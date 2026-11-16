// Every public query and mutation goes through these helpers. Authorization
// lives here, on the server, so hiding a button in the UI is never the only
// thing standing between a user and someone else's data.
import { ConvexError } from "convex/values";
import type { Doc } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";

export async function getCurrentUser(
  ctx: QueryCtx,
): Promise<Doc<"users"> | null> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) return null;
  return await ctx.db
    .query("users")
    .withIndex("by_token", (q) =>
      q.eq("tokenIdentifier", identity.tokenIdentifier),
    )
    .unique();
}

export async function requireUser(ctx: QueryCtx): Promise<Doc<"users">> {
  const user = await getCurrentUser(ctx);
  if (!user) throw new ConvexError("You need to sign in.");
  return user;
}

export async function requireAdmin(ctx: QueryCtx): Promise<Doc<"users">> {
  const user = await requireUser(ctx);
  if (user.role !== "admin") throw new ConvexError("Admins only.");
  return user;
}

export function isAdmin(user: Doc<"users">): boolean {
  return user.role === "admin";
}

/** First name only: enough for the UI, less personal data on the wire. */
export function displayName(user: Doc<"users"> | null): string {
  if (!user) return "Unknown";
  return user.name.split(" ")[0] || "Neighbor";
}

export function adminEmails(): string[] {
  return (process.env.ADMIN_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}
