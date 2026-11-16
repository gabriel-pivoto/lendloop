import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { mutation, query } from "./_generated/server";
import { displayName, isAdmin, requireUser } from "./lib/access";
import { CATEGORIES, cleanText, isCategory } from "./lib/loanRules";
import { closeLoan } from "./loans";

const PUBLIC_LIMIT = 100;
const BROWSE_LIMIT = 200;
const MY_TOOLS_LIMIT = 200;
const LOANS_PER_TOOL_LIMIT = 500;

function assertCategory(category: string) {
  if (!isCategory(category))
    throw new ConvexError(`Category must be one of: ${CATEGORIES.join(", ")}.`);
}

/**
 * Public, unauthenticated catalogue. Returns name and category only: no owner,
 * no description, nothing that identifies a neighbor to an anonymous visitor.
 */
export const publicList = query({
  args: {},
  handler: async (ctx) => {
    const tools = await ctx.db.query("tools").order("desc").take(PUBLIC_LIMIT * 2);
    return tools
      .filter((t) => !t.removedAt)
      .slice(0, PUBLIC_LIMIT)
      .map((t) => ({ _id: t._id, name: t.name, category: t.category }));
  },
});

export const categories = query({
  args: {},
  handler: async () => [...CATEGORIES],
});

/** Signed-in catalogue with owner first name and the Trusted Lender badge. */
export const browse = query({
  args: { category: v.optional(v.string()) },
  handler: async (ctx, { category }) => {
    const me = await requireUser(ctx);
    const tools = category
      ? await ctx.db
          .query("tools")
          .withIndex("by_category", (q) => q.eq("category", category))
          .order("desc")
          .take(BROWSE_LIMIT)
      : await ctx.db.query("tools").order("desc").take(BROWSE_LIMIT);

    const active = tools.filter((t) => !t.removedAt);
    const ownerIds = [...new Set(active.map((t) => t.ownerId))];
    const owners = new Map<Id<"users">, Doc<"users"> | null>(
      await Promise.all(
        ownerIds.map(async (id) => [id, await ctx.db.get("users", id)] as const),
      ),
    );
    return active.map((t) => {
      const owner = owners.get(t.ownerId) ?? null;
      return {
        _id: t._id,
        name: t.name,
        category: t.category,
        description: t.description,
        ownerName: displayName(owner),
        ownerTrusted: owner?.trustedLender ?? false,
        isMine: t.ownerId === me._id,
      };
    });
  },
});

export const mine = query({
  args: {},
  handler: async (ctx) => {
    const me = await requireUser(ctx);
    const tools = await ctx.db
      .query("tools")
      .withIndex("by_ownerId", (q) => q.eq("ownerId", me._id))
      .order("desc")
      .take(MY_TOOLS_LIMIT);
    return await Promise.all(
      tools
        .filter((t) => !t.removedAt)
        .map(async (t) => {
          const loans = await ctx.db
            .query("loans")
            .withIndex("by_toolId", (q) => q.eq("toolId", t._id))
            .order("desc")
            .take(LOANS_PER_TOOL_LIMIT);
          return {
            _id: t._id,
            name: t.name,
            category: t.category,
            description: t.description,
            pendingRequests: loans.filter((l) => l.status === "requested").length,
            onLoan: loans.some((l) => l.status === "approved"),
          };
        }),
    );
  },
});

export const create = mutation({
  args: {
    name: v.string(),
    category: v.string(),
    description: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const me = await requireUser(ctx);
    assertCategory(args.category);
    return await ctx.db.insert("tools", {
      ownerId: me._id,
      name: cleanText(args.name, { field: "Name", min: 2, max: 80 })!,
      category: args.category,
      description: cleanText(args.description, { field: "Description", max: 500 }),
    });
  },
});

export const update = mutation({
  args: {
    toolId: v.id("tools"),
    name: v.string(),
    category: v.string(),
    description: v.optional(v.string()),
  },
  handler: async (ctx, { toolId, ...args }) => {
    const me = await requireUser(ctx);
    const tool = await ctx.db.get("tools", toolId);
    // Same message for "missing" and "not yours" so ids cannot be probed.
    if (!tool || tool.removedAt || tool.ownerId !== me._id)
      throw new ConvexError("Listing not found.");
    assertCategory(args.category);
    await ctx.db.patch("tools", toolId, {
      name: cleanText(args.name, { field: "Name", min: 2, max: 80 })!,
      category: args.category,
      description: cleanText(args.description, { field: "Description", max: 500 }),
    });
  },
});

/**
 * Owners remove their own listing; admins can remove any listing. Removal is
 * a soft delete. A tool that is currently out on loan cannot be removed until
 * it comes back, and pending requests are declined so borrowers are notified.
 */
export const remove = mutation({
  args: { toolId: v.id("tools") },
  handler: async (ctx, { toolId }) => {
    const me = await requireUser(ctx);
    const tool = await ctx.db.get("tools", toolId);
    if (!tool || tool.removedAt) throw new ConvexError("Listing not found.");
    if (tool.ownerId !== me._id && !isAdmin(me)) throw new ConvexError("Listing not found.");

    const loans = await ctx.db
      .query("loans")
      .withIndex("by_toolId", (q) => q.eq("toolId", toolId))
      .take(LOANS_PER_TOOL_LIMIT);
    if (loans.some((l) => l.status === "approved"))
      throw new ConvexError(
        "This tool is currently on loan. Mark it as returned before removing it.",
      );
    for (const loan of loans.filter((l) => l.status === "requested")) {
      await closeLoan(ctx, loan, "declined", "Listing was removed.");
    }
    await ctx.db.patch("tools", toolId, { removedAt: Date.now(), removedBy: me._id });
  },
});
