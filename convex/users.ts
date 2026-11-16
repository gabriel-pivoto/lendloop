import { ConvexError, v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { mutation, query } from "./_generated/server";
import { adminEmails, getCurrentUser, isAdmin, requireAdmin } from "./lib/access";

const LENDER_SCAN_LIMIT = 1000;

/**
 * Upserts the signed-in Clerk user. Called by the client once per session.
 * The admin role is granted only when the token carries an explicitly
 * verified email that is listed in ADMIN_EMAILS; a missing or non-boolean
 * `email_verified` claim never counts as verified.
 */
export const store = mutation({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new ConvexError("You need to sign in.");

    const email = identity.email?.toLowerCase();
    const role =
      email && identity.emailVerified === true && adminEmails().includes(email)
        ? ("admin" as const)
        : ("user" as const);
    const name = identity.name ?? identity.givenName ?? email?.split("@")[0] ?? "Neighbor";

    const existing = await getCurrentUser(ctx);
    if (existing) {
      if (existing.name !== name || existing.email !== email || existing.role !== role) {
        await ctx.db.patch("users", existing._id, { name, email, role });
      }
      return existing._id;
    }
    return await ctx.db.insert("users", {
      tokenIdentifier: identity.tokenIdentifier,
      name,
      email,
      role,
      trustedLender: false,
    });
  },
});

export const me = query({
  args: {},
  handler: async (ctx) => {
    const user = await getCurrentUser(ctx);
    if (!user) return null;
    return {
      _id: user._id,
      name: user.name,
      role: isAdmin(user) ? ("admin" as const) : ("user" as const),
      trustedLender: user.trustedLender,
    };
  },
});

/** Admin view of people who have at least one active listing. */
export const listLenders = query({
  args: {},
  handler: async (ctx) => {
    await requireAdmin(ctx);
    const tools = await ctx.db.query("tools").order("desc").take(LENDER_SCAN_LIMIT);
    const counts = new Map<Id<"users">, number>();
    for (const t of tools) {
      if (t.removedAt) continue;
      counts.set(t.ownerId, (counts.get(t.ownerId) ?? 0) + 1);
    }
    const lenders = await Promise.all([...counts.keys()].map((id) => ctx.db.get("users", id)));
    return lenders
      .filter((u): u is NonNullable<typeof u> => u !== null)
      .map((u) => ({
        _id: u._id,
        name: u.name,
        trustedLender: u.trustedLender,
        activeListings: counts.get(u._id) ?? 0,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  },
});

export const setTrustedLender = mutation({
  args: { userId: v.id("users"), trusted: v.boolean() },
  handler: async (ctx, { userId, trusted }) => {
    const admin = await requireAdmin(ctx);
    const target = await ctx.db.get("users", userId);
    if (!target) throw new ConvexError("User not found.");
    await ctx.db.patch("users", userId, {
      trustedLender: trusted,
      trustedAt: trusted ? Date.now() : undefined,
      trustedBy: trusted ? admin._id : undefined,
    });
  },
});
