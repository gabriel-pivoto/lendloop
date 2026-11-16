import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export const loanStatus = v.union(
  v.literal("requested"),
  v.literal("approved"),
  v.literal("declined"),
  v.literal("cancelled"),
  v.literal("returned"),
);

export const automationKind = v.union(
  v.literal("notification"),
  v.literal("overdue_reminder"),
  v.literal("workflow_error"),
);

export const automationStatus = v.union(
  v.literal("pending"), // queued in Convex, not yet delivered to n8n
  v.literal("retrying"), // delivery to n8n failed, a retry is scheduled
  v.literal("delivered"), // n8n accepted the webhook (2xx)
  v.literal("sent"), // n8n reported the message was sent
  v.literal("failed"), // gave up, or n8n reported a failure
  v.literal("skipped"), // automation not configured in this environment
);

/** Loan state captured when an event is enqueued, so retries send what happened then. */
export const loanSnapshot = v.object({
  status: loanStatus,
  startDate: v.string(),
  endDate: v.string(),
  reason: v.optional(v.string()),
});

export default defineSchema({
  // One row per Clerk user. Only what the app needs: a display name for the
  // UI and an email so n8n can notify. No phone, address or avatar is stored.
  users: defineTable({
    tokenIdentifier: v.string(),
    name: v.string(),
    email: v.optional(v.string()),
    role: v.union(v.literal("admin"), v.literal("user")),
    trustedLender: v.boolean(),
    trustedAt: v.optional(v.number()),
    trustedBy: v.optional(v.id("users")),
  }).index("by_tokenIdentifier", ["tokenIdentifier"]),

  // Listings are soft deleted so loan history keeps pointing at a real row.
  tools: defineTable({
    ownerId: v.id("users"),
    name: v.string(),
    category: v.string(),
    description: v.optional(v.string()),
    removedAt: v.optional(v.number()),
    removedBy: v.optional(v.id("users")),
  })
    .index("by_ownerId", ["ownerId"])
    .index("by_category", ["category"]),

  // A loan starts life as a request; status walks the state machine in
  // convex/lib/loanRules.ts.
  loans: defineTable({
    toolId: v.id("tools"),
    lenderId: v.id("users"),
    borrowerId: v.id("users"),
    startDate: v.string(), // YYYY-MM-DD, inclusive
    endDate: v.string(), // YYYY-MM-DD, inclusive
    status: loanStatus,
    note: v.optional(v.string()),
    statusReason: v.optional(v.string()),
    decidedAt: v.optional(v.number()),
    returnedAt: v.optional(v.number()),
    lastReminderAt: v.optional(v.number()),
  })
    .index("by_toolId", ["toolId"])
    .index("by_borrowerId", ["borrowerId"])
    .index("by_lenderId", ["lenderId"])
    .index("by_status_and_endDate", ["status", "endDate"]),

  // Audit trail of every automation touch point, shown per loan in the UI.
  // idempotencyKey is unique by convention (enforced in automation.ts), which
  // is what makes n8n write-backs safe to retry.
  automationEvents: defineTable({
    kind: automationKind,
    source: v.union(v.literal("convex"), v.literal("n8n")),
    status: automationStatus,
    idempotencyKey: v.string(),
    loanId: v.optional(v.id("loans")),
    event: v.optional(v.string()),
    snapshot: v.optional(loanSnapshot),
    detail: v.optional(v.string()),
    attempts: v.number(),
    updatedAt: v.number(),
  })
    .index("by_idempotencyKey", ["idempotencyKey"])
    .index("by_loanId", ["loanId"])
    .index("by_kind", ["kind"]),
});
