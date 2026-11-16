// Demo data for local development and reviewers:
//   npx convex run seed:demo
// Internal, so it cannot be called from the browser. Refuses to run twice.
import type { Id } from "./_generated/dataModel";
import { internalMutation } from "./_generated/server";
import { enqueueLoanNotification } from "./automation";
import { todayUtc } from "./lib/loanRules";

const addDays = (iso: string, days: number) =>
  new Date(new Date(`${iso}T00:00:00Z`).getTime() + days * 86_400_000).toISOString().slice(0, 10);

export const demo = internalMutation({
  args: {},
  handler: async (ctx) => {
    if (await ctx.db.query("tools").first()) return "Already seeded, skipping.";
    const user = (name: string, email: string, trustedLender = false) =>
      ctx.db.insert("users", {
        tokenIdentifier: `seed|${email}`,
        name,
        email,
        role: "user",
        trustedLender,
      });
    const alice = await user("Alice Martins", "alice@example.com", true);
    const bob = await user("Bob Silva", "bob@example.com");
    const carol = await user("Carol Souza", "carol@example.com");

    const tool = (ownerId: Id<"users">, name: string, category: string, description?: string) =>
      ctx.db.insert("tools", { ownerId, name, category, description });
    const drill = await tool(alice, "Cordless drill", "Power tools", "18V, two batteries.");
    const ladder = await tool(alice, "Extension ladder 6m", "Ladders");
    await tool(bob, "Hedge trimmer", "Garden");
    await tool(carol, "Camping tent (4 people)", "Camping");
    await tool(carol, "Carpet cleaner", "Cleaning");

    const today = todayUtc();
    const pending = {
      toolId: drill,
      lenderId: alice,
      borrowerId: bob,
      startDate: addDays(today, 2),
      endDate: addDays(today, 4),
      status: "requested" as const,
      note: "Hanging shelves this weekend.",
    };
    const pendingId = await ctx.db.insert("loans", pending);
    await enqueueLoanNotification(ctx, { _id: pendingId, ...pending }, "loan.requested");

    await ctx.db.insert("loans", {
      toolId: ladder,
      lenderId: alice,
      borrowerId: carol,
      startDate: addDays(today, -6),
      endDate: addDays(today, -2),
      status: "approved",
      decidedAt: Date.now(),
    });
    return "Seeded 3 users, 5 tools, 1 pending request and 1 overdue loan.";
  },
});
