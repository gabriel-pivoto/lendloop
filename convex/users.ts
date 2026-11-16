import { ConvexError, v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { mutation, query } from "./_generated/server";
import {
  adminEmails,
  getCurrentUser,
  requireAdmin,
} from "./lib/access";

/**
 * Upserts the signed-in Clerk user. Called by the client once per session.
 * The admin role is derived from ADMIN_EMAILS on every call and only for a
 * verified email, so it can be granted or revoked without a data migration
 * and cannot be claimed by signing up with an unverified address.
 */
export const store = mutation({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new ConvexError("You need to sign in.");

    const email = identity.email?.toLowerCase();
    const role =
      email && identity.emailVerified !== false && adminEmails().includes(email)
        ? ("admin" as const)
        : ("user" as const);
    const name =
      identity.name ?? identity.givenName ?? email?.split("@")[0] ?? "Neighbor";

    const existing = await getCurrentUser(ctx);
    if (existing) {
      if (
        existing.name !== name ||
        existing.email !== email ||
        existing.role !== role
      ) {
        await ctx.db.patch(existing._id, { name, email, role });
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
      role: user.role,
      trustedLender: user.trustedLender,
    };
  },
});

/** Admin view of people who have listed at least one tool. */
export const listLenders = query({
  args: {},
  handler: async (ctx) => {
    await requireAdmin(ctx);
    const tools = await ctx.db.query("tools").collect();
    const counts = new Map<Id<"users">, number>();
    for (const t of tools) {
      if (t.removedAt) continue;
      counts.set(t.ownerId, (counts.get(t.ownerId) ?? 0) + 1);
    }
    const lenders = await Promise.all(
      [...counts.keys()].map((id) => ctx.db.get(id)),
    );
    return lenders
      .filter((u): u is NonNullable<typeof u> => u !== null)
      .map((u) => ({
        _id: u._id,
        name: u.name,
        email: u.email,
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
    const target = await ctx.db.get(userId);
    if (!target) throw new ConvexError("User not found.");
    await ctx.db.patch(userId, {
      trustedLender: trusted,
      trustedAt: trusted ? Date.now() : undefined,
      trustedBy: trusted ? admin._id : undefined,
    });
  },
});
