// Every public query and mutation goes through these helpers. Authorization
// lives here, on the server, so hiding a button in the UI is never the only
// thing standing between a user and someone else's data.
import { ConvexError } from "convex/values";
import type { Doc } from "../_generated/dataModel";
import { env, type QueryCtx } from "../_generated/server";

export async function getCurrentUser(ctx: QueryCtx): Promise<Doc<"users"> | null> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) return null;
  return await ctx.db
    .query("users")
    .withIndex("by_tokenIdentifier", (q) => q.eq("tokenIdentifier", identity.tokenIdentifier))
    .unique();
}

export async function requireUser(ctx: QueryCtx): Promise<Doc<"users">> {
  const user = await getCurrentUser(ctx);
  if (!user) throw new ConvexError("You need to sign in.");
  return user;
}

export function adminEmails(): string[] {
  return (env.ADMIN_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Admin requires both the stored role (granted at sign-in only for a verified
 * email) and the address still being in ADMIN_EMAILS right now. Removing an
 * address from the env revokes access on the next call, with no need for the
 * user to sign in again.
 */
export function isAdmin(user: Doc<"users">): boolean {
  return (
    user.role === "admin" &&
    !!user.email &&
    adminEmails().includes(user.email.toLowerCase())
  );
}

export async function requireAdmin(ctx: QueryCtx): Promise<Doc<"users">> {
  const user = await requireUser(ctx);
  if (!isAdmin(user)) throw new ConvexError("Admins only.");
  return user;
}

/** First name only: enough for the UI, less personal data on the wire. */
export function displayName(user: Doc<"users"> | null): string {
  if (!user) return "Unknown";
  return user.name.split(" ")[0] || "Neighbor";
}
