// Everything that crosses the Convex <-> n8n boundary.
//
// Outbound: a mutation calls enqueueLoanNotification, which writes a pending
// automationEvents row (with a snapshot of the loan at that moment) and
// schedules deliverNotification. Because the row is written in the same
// transaction as the status change, an event is never lost: if the mutation
// commits, the delivery is scheduled. The action signs the payload, POSTs it
// to n8n and retries with exponential backoff.
//
// Inbound: convex/http.ts verifies the HMAC and then calls the internal
// functions below. Every write-back carries an idempotency key, so n8n can
// retry freely without creating duplicate rows.
import { ConvexError, v, type Infer } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
  env,
  internalAction,
  internalMutation,
  internalQuery,
  query,
  type MutationCtx,
} from "./_generated/server";
import { automationStatus, loanSnapshot } from "./schema";
import { displayName, requireAdmin } from "./lib/access";
import { daysBetween } from "./lib/loanRules";
import { signPayload, SIGNATURE_HEADER, TIMESTAMP_HEADER } from "./lib/hmac";

export const MAX_DELIVERY_ATTEMPTS = 5;
const BASE_BACKOFF_MS = 30_000;
const DELIVERY_TIMEOUT_MS = 10_000;
const OVERDUE_BATCH_LIMIT = 500;
export const OUTBOUND_SCOPE = "POST loan-event";

// ---------------------------------------------------------------------------
// Outbound: Convex -> n8n
// ---------------------------------------------------------------------------

type LoanForEvent = Pick<Doc<"loans">, "status" | "startDate" | "endDate" | "statusReason"> & {
  _id: Id<"loans">;
};

export async function enqueueLoanNotification(
  ctx: MutationCtx,
  loan: LoanForEvent,
  event: string,
) {
  const now = Date.now();
  const eventId = await ctx.db.insert("automationEvents", {
    kind: "notification",
    source: "convex",
    status: "pending",
    idempotencyKey: "pending",
    loanId: loan._id,
    event,
    snapshot: {
      status: loan.status,
      startDate: loan.startDate,
      endDate: loan.endDate,
      reason: loan.statusReason,
    },
    attempts: 0,
    updatedAt: now,
  });
  await ctx.db.patch("automationEvents", eventId, { idempotencyKey: `notify:${eventId}` });
  await ctx.scheduler.runAfter(0, internal.automation.deliverNotification, { eventId });
}

/** Who should hear about each event. Only that person's contact is sent. */
function recipientFor(event: string): "lender" | "borrower" {
  return event === "loan.requested" || event === "loan.cancelled" ? "lender" : "borrower";
}

type NotificationBody = {
  eventId: Id<"automationEvents">;
  event: string;
  occurredAt: string;
  loan: { id: Id<"loans">; status: string; startDate: string; endDate: string; reason: string | null };
  tool: { name: string };
  recipient: { role: "lender" | "borrower"; name: string; email: string | null };
  counterpart: { name: string };
};
type NotificationPayload = {
  status: Doc<"automationEvents">["status"];
  attempts: number;
  body: NotificationBody;
} | null;

export const notificationPayload = internalQuery({
  args: { eventId: v.id("automationEvents") },
  handler: async (ctx, { eventId }): Promise<NotificationPayload> => {
    const ev = await ctx.db.get("automationEvents", eventId);
    if (!ev || !ev.loanId || !ev.event || !ev.snapshot) return null;
    const loan = await ctx.db.get("loans", ev.loanId);
    if (!loan) return null;
    const [tool, lender, borrower] = await Promise.all([
      ctx.db.get("tools", loan.toolId),
      ctx.db.get("users", loan.lenderId),
      ctx.db.get("users", loan.borrowerId),
    ]);
    const role = recipientFor(ev.event);
    const recipient = role === "lender" ? lender : borrower;
    const counterpart = role === "lender" ? borrower : lender;
    const snap: Infer<typeof loanSnapshot> = ev.snapshot;
    return {
      status: ev.status,
      attempts: ev.attempts,
      body: {
        eventId: ev._id,
        event: ev.event,
        occurredAt: new Date(ev._creationTime).toISOString(),
        // The loan as it was when the event happened, not as it is now, so a
        // retried "requested" email never describes a later state.
        loan: {
          id: loan._id,
          status: snap.status,
          startDate: snap.startDate,
          endDate: snap.endDate,
          reason: snap.reason ?? null,
        },
        tool: { name: tool?.name ?? "a tool" },
        recipient: { role, name: displayName(recipient), email: recipient?.email ?? null },
        counterpart: { name: displayName(counterpart) },
      },
    };
  },
});

export const recordDelivery = internalMutation({
  args: {
    eventId: v.id("automationEvents"),
    status: automationStatus,
    attempts: v.number(),
    detail: v.optional(v.string()),
  },
  handler: async (ctx, { eventId, ...patch }) => {
    const ev = await ctx.db.get("automationEvents", eventId);
    // n8n answers 202 before sending, so its "sent"/"failed" write-back can
    // land before we record "delivered". The n8n outcome is final.
    if (!ev || ev.status === "sent" || ev.status === "failed") return null;
    await ctx.db.patch("automationEvents", eventId, { ...patch, updatedAt: Date.now() });
    return null;
  },
});

export const deliverNotification = internalAction({
  args: { eventId: v.id("automationEvents") },
  handler: async (ctx, { eventId }) => {
    const data: NotificationPayload = await ctx.runQuery(internal.automation.notificationPayload, {
      eventId,
    });
    if (!data || (data.status !== "pending" && data.status !== "retrying")) return;

    const url = env.N8N_LOAN_EVENT_WEBHOOK_URL;
    const secret = env.LENDLOOP_HMAC_SECRET;
    const attempts = data.attempts + 1;
    const record = async (status: Doc<"automationEvents">["status"], detail: string) => {
      const done: null = await ctx.runMutation(internal.automation.recordDelivery, {
        eventId,
        status,
        attempts,
        detail,
      });
      return done;
    };

    if (!url || !secret) {
      await record(
        "skipped",
        "Automation is not configured (N8N_LOAN_EVENT_WEBHOOK_URL / LENDLOOP_HMAC_SECRET).",
      );
      return;
    }

    const body = JSON.stringify(data.body);
    const { timestamp, signature } = await signPayload(secret, OUTBOUND_SCOPE, body);
    let failure: string | null = null;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [TIMESTAMP_HEADER]: timestamp,
          [SIGNATURE_HEADER]: signature,
          "x-lendloop-event-id": eventId,
        },
        body,
        signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
      });
      if (!res.ok) failure = `n8n responded ${res.status}`;
    } catch (err) {
      failure = err instanceof Error ? err.message : "network error";
    }

    if (!failure) {
      await record("delivered", "Accepted by n8n.");
      return;
    }
    if (attempts >= MAX_DELIVERY_ATTEMPTS) {
      await record("failed", `Gave up after ${attempts} attempts: ${failure}`.slice(0, 300));
      return;
    }
    const delay = BASE_BACKOFF_MS * 2 ** (attempts - 1);
    await record("retrying", `${failure}. Retrying in ${Math.round(delay / 1000)}s.`.slice(0, 300));
    await ctx.scheduler.runAfter(delay, internal.automation.deliverNotification, { eventId });
  },
});

// ---------------------------------------------------------------------------
// Inbound: n8n -> Convex (called from convex/http.ts after HMAC verification)
// ---------------------------------------------------------------------------

type UpsertResult = { result: "created" | "updated" | "duplicate" };

/**
 * Idempotent write keyed by idempotencyKey. A replay with the same status is
 * a no-op; a later "sent" may upgrade an earlier "failed" (a retry that
 * worked), but a "failed" never downgrades a "sent".
 */
async function upsertByKey(
  ctx: MutationCtx,
  key: string,
  row: Omit<Doc<"automationEvents">, "_id" | "_creationTime" | "idempotencyKey" | "updatedAt">,
): Promise<UpsertResult> {
  const existing = await ctx.db
    .query("automationEvents")
    .withIndex("by_idempotencyKey", (q) => q.eq("idempotencyKey", key))
    .unique();
  const now = Date.now();
  if (!existing) {
    await ctx.db.insert("automationEvents", { ...row, idempotencyKey: key, updatedAt: now });
    return { result: "created" };
  }
  if (existing.status === row.status || existing.status === "sent") {
    return { result: "duplicate" };
  }
  await ctx.db.patch("automationEvents", existing._id, {
    status: row.status,
    detail: row.detail,
    attempts: existing.attempts + 1,
    updatedAt: now,
  });
  return { result: "updated" };
}

export const recordNotificationResult = internalMutation({
  args: {
    eventId: v.string(),
    status: v.union(v.literal("sent"), v.literal("failed")),
    detail: v.optional(v.string()),
  },
  handler: async (ctx, { eventId, status, detail }): Promise<UpsertResult> => {
    const id = ctx.db.normalizeId("automationEvents", eventId);
    const ev = id ? await ctx.db.get("automationEvents", id) : null;
    if (!ev || ev.kind !== "notification") throw new ConvexError("Unknown event.");
    if (ev.status === status || ev.status === "sent") return { result: "duplicate" };
    await ctx.db.patch("automationEvents", ev._id, {
      status,
      detail:
        detail?.slice(0, 300) ?? (status === "sent" ? "Email sent by n8n." : "n8n failed to send."),
      updatedAt: Date.now(),
    });
    return { result: "updated" };
  },
});

export function reminderKey(loanId: string, day: string) {
  return `overdue:${loanId}:${day}`;
}

/**
 * Approved loans past their end date that have not yet had a successful
 * reminder today. Only what the reminder email needs is returned.
 */
export const overdueLoans = internalQuery({
  args: { today: v.string() },
  handler: async (ctx, { today }) => {
    const loans = await ctx.db
      .query("loans")
      .withIndex("by_status_and_endDate", (q) => q.eq("status", "approved").lt("endDate", today))
      .take(OVERDUE_BATCH_LIMIT);
    const rows = await Promise.all(
      loans.map(async (loan) => {
        const key = reminderKey(loan._id, today);
        const done = await ctx.db
          .query("automationEvents")
          .withIndex("by_idempotencyKey", (q) => q.eq("idempotencyKey", key))
          .unique();
        if (done?.status === "sent") return null;
        const [tool, borrower, lender] = await Promise.all([
          ctx.db.get("tools", loan.toolId),
          ctx.db.get("users", loan.borrowerId),
          ctx.db.get("users", loan.lenderId),
        ]);
        return {
          loanId: loan._id,
          idempotencyKey: key,
          toolName: tool?.name ?? "a tool",
          endDate: loan.endDate,
          daysOverdue: daysBetween(loan.endDate, today),
          borrower: { name: displayName(borrower), email: borrower?.email ?? null },
          lender: { name: displayName(lender) },
        };
      }),
    );
    return rows.filter((r) => r !== null);
  },
});

export const recordReminderResult = internalMutation({
  args: {
    loanId: v.string(),
    day: v.string(),
    status: v.union(v.literal("sent"), v.literal("failed")),
    detail: v.optional(v.string()),
  },
  handler: async (ctx, { loanId, day, status, detail }): Promise<UpsertResult> => {
    const id = ctx.db.normalizeId("loans", loanId);
    const loan = id ? await ctx.db.get("loans", id) : null;
    if (!loan) throw new ConvexError("Unknown loan.");
    const res = await upsertByKey(ctx, reminderKey(loan._id, day), {
      kind: "overdue_reminder",
      source: "n8n",
      status,
      loanId: loan._id,
      event: "loan.overdue",
      detail:
        detail?.slice(0, 300) ??
        (status === "sent" ? "Overdue reminder sent." : "Reminder failed."),
      attempts: 1,
    });
    if (status === "sent" && res.result !== "duplicate") {
      await ctx.db.patch("loans", loan._id, { lastReminderAt: Date.now() });
    }
    return res;
  },
});

export const recordWorkflowError = internalMutation({
  args: {
    executionId: v.string(),
    workflowName: v.string(),
    nodeName: v.optional(v.string()),
    message: v.string(),
  },
  handler: async (ctx, a): Promise<UpsertResult> => {
    return await upsertByKey(ctx, `error:${a.executionId}`, {
      kind: "workflow_error",
      source: "n8n",
      status: "failed",
      event: a.workflowName.slice(0, 100),
      detail: `${a.nodeName ? `[${a.nodeName}] ` : ""}${a.message}`.slice(0, 500),
      attempts: 1,
    });
  },
});

// ---------------------------------------------------------------------------
// Admin visibility
// ---------------------------------------------------------------------------

export const recentProblems = query({
  args: {},
  handler: async (ctx) => {
    await requireAdmin(ctx);
    const errors = await ctx.db
      .query("automationEvents")
      .withIndex("by_kind", (q) => q.eq("kind", "workflow_error"))
      .order("desc")
      .take(20);
    const recent = await ctx.db.query("automationEvents").order("desc").take(200);
    const failedDeliveries = recent.filter(
      (e) => e.kind !== "workflow_error" && (e.status === "failed" || e.status === "retrying"),
    );
    return [...errors, ...failedDeliveries]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 30)
      .map((e) => ({
        _id: e._id,
        kind: e.kind,
        status: e.status,
        event: e.event,
        detail: e.detail,
        updatedAt: e.updatedAt,
      }));
  },
});
