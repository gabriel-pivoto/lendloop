import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { displayName, isAdmin, requireAdmin, requireUser } from "./lib/access";
import {
  canTransition,
  cleanText,
  isIsoDate,
  isOverdue,
  rangesOverlap,
  todayUtc,
  validateRange,
  type Actor,
  type LoanStatus,
} from "./lib/loanRules";
import { enqueueLoanNotification } from "./automation";
import { loanStatus } from "./schema";

const LIST_LIMIT = 200;
const ADMIN_LIST_LIMIT = 500;
const LOANS_PER_TOOL_LIMIT = 500;
const ACTIVITY_LIMIT = 100;

// Queries must not read the wall clock (their results are cached), so the
// client passes its current UTC day. It only drives the "overdue" badge;
// every rule that matters is enforced in mutations with the server clock.
const todayArg = v.string();
function checkToday(today: string) {
  if (!isIsoDate(today)) throw new ConvexError("today must be YYYY-MM-DD.");
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function loadLoanFor(
  ctx: QueryCtx,
  loanId: Id<"loans">,
  me: Doc<"users">,
): Promise<{ loan: Doc<"loans">; actor: Actor }> {
  const loan = await ctx.db.get("loans", loanId);
  if (!loan) throw new ConvexError("Request not found.");
  if (loan.lenderId === me._id) return { loan, actor: "lender" };
  if (loan.borrowerId === me._id) return { loan, actor: "borrower" };
  throw new ConvexError("Request not found.");
}

async function transition(
  ctx: MutationCtx,
  loan: Doc<"loans">,
  to: LoanStatus,
  actor: Actor,
  reason?: string,
) {
  if (!canTransition(loan.status, to, actor))
    throw new ConvexError(`Cannot move a ${loan.status} request to ${to}.`);
  await closeLoan(ctx, loan, to, reason);
}

/** Applies a status change and emits the notification event. */
export async function closeLoan(
  ctx: MutationCtx,
  loan: Doc<"loans">,
  to: LoanStatus,
  reason?: string,
) {
  const now = Date.now();
  await ctx.db.patch("loans", loan._id, {
    status: to,
    statusReason: reason,
    ...(to === "approved" || to === "declined" ? { decidedAt: now } : {}),
    ...(to === "returned" ? { returnedAt: now } : {}),
  });
  await enqueueLoanNotification(ctx, { ...loan, status: to, statusReason: reason }, `loan.${to}`);
}

async function loansForTool(ctx: QueryCtx, toolId: Id<"tools">) {
  return await ctx.db
    .query("loans")
    .withIndex("by_toolId", (q) => q.eq("toolId", toolId))
    .order("desc")
    .take(LOANS_PER_TOOL_LIMIT);
}

function overlapsApproved(
  loans: Doc<"loans">[],
  start: string,
  end: string,
  excludeId?: Id<"loans">,
) {
  return loans.some(
    (l) =>
      l._id !== excludeId &&
      l.status === "approved" &&
      rangesOverlap(start, end, l.startDate, l.endDate),
  );
}

async function toView(ctx: QueryCtx, loan: Doc<"loans">, today: string) {
  const [tool, lender, borrower, events] = await Promise.all([
    ctx.db.get("tools", loan.toolId),
    ctx.db.get("users", loan.lenderId),
    ctx.db.get("users", loan.borrowerId),
    ctx.db
      .query("automationEvents")
      .withIndex("by_loanId", (q) => q.eq("loanId", loan._id))
      .order("desc")
      .take(5),
  ]);
  return {
    _id: loan._id,
    _creationTime: loan._creationTime,
    toolName: tool?.name ?? "Removed tool",
    toolCategory: tool?.category ?? "",
    lenderName: displayName(lender),
    lenderTrusted: lender?.trustedLender ?? false,
    borrowerName: displayName(borrower),
    startDate: loan.startDate,
    endDate: loan.endDate,
    status: loan.status,
    statusReason: loan.statusReason,
    note: loan.note,
    overdue: isOverdue(loan, today),
    lastReminderAt: loan.lastReminderAt,
    // Bonus: recent automation activity, rendered as a small timeline.
    activity: events.map((e) => ({
      _id: e._id,
      at: e.updatedAt,
      kind: e.kind,
      source: e.source,
      status: e.status,
      event: e.event,
      detail: e.detail,
      attempts: e.attempts,
    })),
  };
}

async function views(ctx: QueryCtx, loans: Doc<"loans">[], today: string) {
  return await Promise.all(loans.map((l) => toView(ctx, l, today)));
}

// ---------------------------------------------------------------------------
// Borrower side
// ---------------------------------------------------------------------------

export const request = mutation({
  args: {
    toolId: v.id("tools"),
    startDate: v.string(),
    endDate: v.string(),
    note: v.optional(v.string()),
  },
  handler: async (ctx, { toolId, startDate, endDate, note }) => {
    const me = await requireUser(ctx);
    const tool = await ctx.db.get("tools", toolId);
    if (!tool || tool.removedAt) throw new ConvexError("Tool not found.");
    if (tool.ownerId === me._id) throw new ConvexError("You cannot borrow your own tool.");

    const rangeError = validateRange(startDate, endDate, todayUtc());
    if (rangeError) throw new ConvexError(rangeError);

    const toolLoans = await loansForTool(ctx, toolId);
    if (overlapsApproved(toolLoans, startDate, endDate))
      throw new ConvexError("The tool is already booked for some of those days.");
    if (
      toolLoans.some(
        (l) =>
          l.borrowerId === me._id &&
          l.status === "requested" &&
          rangesOverlap(startDate, endDate, l.startDate, l.endDate),
      )
    )
      throw new ConvexError("You already have a request for those dates.");

    const loan = {
      toolId,
      lenderId: tool.ownerId,
      borrowerId: me._id,
      startDate,
      endDate,
      status: "requested" as const,
      note: cleanText(note, { field: "Note", max: 300 }),
    };
    const loanId = await ctx.db.insert("loans", loan);
    await enqueueLoanNotification(ctx, { _id: loanId, ...loan }, "loan.requested");
    return loanId;
  },
});

export const cancel = mutation({
  args: { loanId: v.id("loans") },
  handler: async (ctx, { loanId }) => {
    const me = await requireUser(ctx);
    const { loan, actor } = await loadLoanFor(ctx, loanId, me);
    await transition(ctx, loan, "cancelled", actor);
  },
});

export const myRequests = query({
  args: { today: todayArg },
  handler: async (ctx, { today }) => {
    checkToday(today);
    const me = await requireUser(ctx);
    const loans = await ctx.db
      .query("loans")
      .withIndex("by_borrowerId", (q) => q.eq("borrowerId", me._id))
      .order("desc")
      .take(LIST_LIMIT);
    return await views(ctx, loans, today);
  },
});

// ---------------------------------------------------------------------------
// Lender side
// ---------------------------------------------------------------------------

export const approve = mutation({
  args: { loanId: v.id("loans") },
  handler: async (ctx, { loanId }) => {
    const me = await requireUser(ctx);
    const { loan, actor } = await loadLoanFor(ctx, loanId, me);
    if (!canTransition(loan.status, "approved", actor))
      throw new ConvexError(`Cannot move a ${loan.status} request to approved.`);
    if (loan.startDate < todayUtc())
      throw new ConvexError(
        "This request's start date has already passed. Decline it so the borrower can ask for new dates.",
      );

    const toolLoans = await loansForTool(ctx, loan.toolId);
    if (overlapsApproved(toolLoans, loan.startDate, loan.endDate, loan._id))
      throw new ConvexError("Another approved loan already covers those dates.");
    await closeLoan(ctx, loan, "approved");

    // Pending requests that now clash can never be approved; close them so
    // those borrowers hear back right away instead of waiting.
    for (const other of toolLoans) {
      if (
        other._id !== loan._id &&
        other.status === "requested" &&
        rangesOverlap(loan.startDate, loan.endDate, other.startDate, other.endDate)
      ) {
        await closeLoan(ctx, other, "declined", "Dates were booked by another neighbor.");
      }
    }
  },
});

export const decline = mutation({
  args: { loanId: v.id("loans"), reason: v.optional(v.string()) },
  handler: async (ctx, { loanId, reason }) => {
    const me = await requireUser(ctx);
    const { loan, actor } = await loadLoanFor(ctx, loanId, me);
    await transition(ctx, loan, "declined", actor, cleanText(reason, { field: "Reason", max: 200 }));
  },
});

export const markReturned = mutation({
  args: { loanId: v.id("loans") },
  handler: async (ctx, { loanId }) => {
    const me = await requireUser(ctx);
    const { loan, actor } = await loadLoanFor(ctx, loanId, me);
    await transition(ctx, loan, "returned", actor);
  },
});

export const incoming = query({
  args: { today: todayArg },
  handler: async (ctx, { today }) => {
    checkToday(today);
    const me = await requireUser(ctx);
    const loans = await ctx.db
      .query("loans")
      .withIndex("by_lenderId", (q) => q.eq("lenderId", me._id))
      .order("desc")
      .take(LIST_LIMIT);
    return await views(ctx, loans, today);
  },
});

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------

export const adminAll = query({
  args: {
    today: todayArg,
    status: v.optional(v.union(loanStatus, v.literal("overdue"))),
  },
  handler: async (ctx, { today, status }) => {
    checkToday(today);
    await requireAdmin(ctx);
    // Filter through the index so older matches are not cut off by the limit.
    const loans =
      status === "overdue"
        ? await ctx.db
            .query("loans")
            .withIndex("by_status_and_endDate", (q) =>
              q.eq("status", "approved").lt("endDate", today),
            )
            .order("desc")
            .take(ADMIN_LIST_LIMIT)
        : status
          ? await ctx.db
              .query("loans")
              .withIndex("by_status_and_endDate", (q) => q.eq("status", status))
              .order("desc")
              .take(ADMIN_LIST_LIMIT)
          : await ctx.db.query("loans").order("desc").take(ADMIN_LIST_LIMIT);
    return await views(ctx, loans, today);
  },
});

/** Full automation history for one loan, for participants and admins. */
export const activity = query({
  args: { loanId: v.id("loans") },
  handler: async (ctx, { loanId }) => {
    const me = await requireUser(ctx);
    const loan = await ctx.db.get("loans", loanId);
    if (!loan || (!isAdmin(me) && loan.lenderId !== me._id && loan.borrowerId !== me._id))
      throw new ConvexError("Request not found.");
    return await ctx.db
      .query("automationEvents")
      .withIndex("by_loanId", (q) => q.eq("loanId", loanId))
      .order("desc")
      .take(ACTIVITY_LIMIT);
  },
});
