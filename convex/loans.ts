import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { displayName, isAdmin, requireAdmin, requireUser } from "./lib/access";
import {
  canTransition,
  cleanText,
  isOverdue,
  rangesOverlap,
  todayUtc,
  validateRange,
  type Actor,
  type LoanStatus,
} from "./lib/loanRules";
import { enqueueLoanNotification } from "./automation";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function loadLoanFor(
  ctx: QueryCtx,
  loanId: Id<"loans">,
  me: Doc<"users">,
): Promise<{ loan: Doc<"loans">; actor: Actor }> {
  const loan = await ctx.db.get(loanId);
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
  await ctx.db.patch(loan._id, {
    status: to,
    statusReason: reason,
    ...(to === "approved" || to === "declined" ? { decidedAt: now } : {}),
    ...(to === "returned" ? { returnedAt: now } : {}),
  });
  await enqueueLoanNotification(ctx, loan._id, `loan.${to}`);
}

async function hasApprovedOverlap(
  ctx: QueryCtx,
  toolId: Id<"tools">,
  start: string,
  end: string,
  excludeId?: Id<"loans">,
) {
  const loans = await ctx.db
    .query("loans")
    .withIndex("by_tool", (q) => q.eq("toolId", toolId))
    .collect();
  return loans.some(
    (l) =>
      l._id !== excludeId &&
      l.status === "approved" &&
      rangesOverlap(start, end, l.startDate, l.endDate),
  );
}

type LoanView = Awaited<ReturnType<typeof toView>>;

async function toView(ctx: QueryCtx, loan: Doc<"loans">, today: string) {
  const [tool, lender, borrower, events] = await Promise.all([
    ctx.db.get(loan.toolId),
    ctx.db.get(loan.lenderId),
    ctx.db.get(loan.borrowerId),
    ctx.db
      .query("automationEvents")
      .withIndex("by_loan", (q) => q.eq("loanId", loan._id))
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

async function views(ctx: QueryCtx, loans: Doc<"loans">[]): Promise<LoanView[]> {
  const today = todayUtc();
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
    const tool = await ctx.db.get(toolId);
    if (!tool || tool.removedAt) throw new ConvexError("Tool not found.");
    if (tool.ownerId === me._id)
      throw new ConvexError("You cannot borrow your own tool.");

    const rangeError = validateRange(startDate, endDate, todayUtc());
    if (rangeError) throw new ConvexError(rangeError);

    if (await hasApprovedOverlap(ctx, toolId, startDate, endDate))
      throw new ConvexError("The tool is already booked for some of those days.");

    const mine = await ctx.db
      .query("loans")
      .withIndex("by_borrower", (q) => q.eq("borrowerId", me._id))
      .collect();
    if (
      mine.some(
        (l) =>
          l.toolId === toolId &&
          (l.status === "requested" || l.status === "approved") &&
          rangesOverlap(startDate, endDate, l.startDate, l.endDate),
      )
    )
      throw new ConvexError("You already have a request for those dates.");

    const loanId = await ctx.db.insert("loans", {
      toolId,
      lenderId: tool.ownerId,
      borrowerId: me._id,
      startDate,
      endDate,
      status: "requested",
      note: cleanText(note, { field: "Note", max: 300 }),
    });
    await enqueueLoanNotification(ctx, loanId, "loan.requested");
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
  args: {},
  handler: async (ctx) => {
    const me = await requireUser(ctx);
    const loans = await ctx.db
      .query("loans")
      .withIndex("by_borrower", (q) => q.eq("borrowerId", me._id))
      .order("desc")
      .collect();
    return await views(ctx, loans);
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
    if (
      await hasApprovedOverlap(ctx, loan.toolId, loan.startDate, loan.endDate, loan._id)
    )
      throw new ConvexError("Another approved loan already covers those dates.");
    await transition(ctx, loan, "approved", actor);

    // Pending requests that now clash can never be approved; close them so
    // those borrowers hear back right away instead of waiting.
    const siblings = await ctx.db
      .query("loans")
      .withIndex("by_tool", (q) => q.eq("toolId", loan.toolId))
      .collect();
    for (const other of siblings) {
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
    await transition(
      ctx,
      loan,
      "declined",
      actor,
      cleanText(reason, { field: "Reason", max: 200 }),
    );
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
  args: {},
  handler: async (ctx) => {
    const me = await requireUser(ctx);
    const loans = await ctx.db
      .query("loans")
      .withIndex("by_lender", (q) => q.eq("lenderId", me._id))
      .order("desc")
      .collect();
    return await views(ctx, loans);
  },
});

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------

export const adminAll = query({
  args: { status: v.optional(v.string()) },
  handler: async (ctx, { status }) => {
    await requireAdmin(ctx);
    const loans = await ctx.db.query("loans").order("desc").take(500);
    const filtered =
      status === "overdue"
        ? loans.filter((l) => isOverdue(l, todayUtc()))
        : status
          ? loans.filter((l) => l.status === status)
          : loans;
    return await views(ctx, filtered);
  },
});

/** Full automation history for one loan, for participants and admins. */
export const activity = query({
  args: { loanId: v.id("loans") },
  handler: async (ctx, { loanId }) => {
    const me = await requireUser(ctx);
    const loan = await ctx.db.get(loanId);
    if (!loan || (!isAdmin(me) && loan.lenderId !== me._id && loan.borrowerId !== me._id))
      throw new ConvexError("Request not found.");
    return await ctx.db
      .query("automationEvents")
      .withIndex("by_loan", (q) => q.eq("loanId", loanId))
      .order("desc")
      .collect();
  },
});
