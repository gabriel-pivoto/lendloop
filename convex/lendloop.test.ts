/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import { signPayload } from "./lib/hmac";
import { todayUtc } from "./lib/loanRules";

const modules = import.meta.glob(["./**/*.ts", "./**/*.js", "!./**/*.test.ts", "!./**/*.d.ts"]);
const SECRET = "test-hmac-secret";

function setup() {
  const t = convexTest(schema, modules);
  const as = (name: string, email: string) =>
    t.withIdentity({ name, email, emailVerified: true, subject: email, issuer: "test" });
  return { t, as };
}

async function signedFetch(
  t: ReturnType<typeof convexTest>,
  method: "GET" | "POST",
  path: string,
  payload?: unknown,
) {
  const body = payload === undefined ? "" : JSON.stringify(payload);
  const { timestamp, signature } = await signPayload(SECRET, `${method} ${path}`, body);
  return t.fetch(path, {
    method,
    headers: {
      "content-type": "application/json",
      "x-lendloop-timestamp": timestamp,
      "x-lendloop-signature": signature,
    },
    body: method === "GET" ? undefined : body,
  });
}

beforeEach(() => {
  process.env.LENDLOOP_HMAC_SECRET = SECRET;
  process.env.ADMIN_EMAILS = "admin@example.com";
});
afterEach(() => {
  delete process.env.LENDLOOP_HMAC_SECRET;
  delete process.env.ADMIN_EMAILS;
});

describe("access control is enforced in Convex", () => {
  it("rejects anonymous callers on private queries", async () => {
    const { t } = setup();
    await expect(t.query(api.tools.browse, {})).rejects.toThrow(/sign in/);
    await expect(t.query(api.loans.myRequests, {})).rejects.toThrow(/sign in/);
  });

  it("exposes only name and category publicly", async () => {
    const { t, as } = setup();
    const alice = as("Alice Smith", "alice@example.com");
    await alice.mutation(api.users.store, {});
    await alice.mutation(api.tools.create, {
      name: "Cordless drill",
      category: "Power tools",
      description: "Pick up at the blue house",
    });
    const list = await t.query(api.tools.publicList, {});
    expect(list).toHaveLength(1);
    expect(Object.keys(list[0]).sort()).toEqual(["_id", "category", "name"]);
  });

  it("stops a user from editing, deleting or approving someone else's things", async () => {
    const { as } = setup();
    const alice = as("Alice", "alice@example.com");
    const bob = as("Bob", "bob@example.com");
    const carol = as("Carol", "carol@example.com");
    for (const u of [alice, bob, carol]) await u.mutation(api.users.store, {});

    const toolId = await alice.mutation(api.tools.create, { name: "Ladder", category: "Ladders" });
    await expect(
      bob.mutation(api.tools.update, { toolId, name: "Mine now", category: "Ladders" }),
    ).rejects.toThrow(/not found/);
    await expect(bob.mutation(api.tools.remove, { toolId })).rejects.toThrow(/not found/);

    const today = todayUtc();
    const loanId = await bob.mutation(api.loans.request, { toolId, startDate: today, endDate: today });
    await expect(bob.mutation(api.loans.approve, { loanId })).rejects.toThrow();
    await expect(carol.mutation(api.loans.approve, { loanId })).rejects.toThrow(/not found/);
    await expect(carol.query(api.loans.activity, { loanId })).rejects.toThrow(/not found/);
    await alice.mutation(api.loans.approve, { loanId });
  });

  it("reserves admin functions for admins, granted only from ADMIN_EMAILS", async () => {
    const { as } = setup();
    const alice = as("Alice", "alice@example.com");
    const admin = as("Ada Admin", "admin@example.com");
    await alice.mutation(api.users.store, {});
    await admin.mutation(api.users.store, {});

    await expect(alice.query(api.loans.adminAll, {})).rejects.toThrow(/Admins only/);
    const toolId = await alice.mutation(api.tools.create, { name: "Saw", category: "Hand tools" });
    const [lender] = await admin.query(api.users.listLenders, {});
    await expect(
      alice.mutation(api.users.setTrustedLender, { userId: lender._id, trusted: true }),
    ).rejects.toThrow(/Admins only/);

    await admin.mutation(api.users.setTrustedLender, { userId: lender._id, trusted: true });
    await admin.mutation(api.tools.remove, { toolId });
    expect(await alice.query(api.tools.mine, {})).toHaveLength(0);
    expect((await alice.query(api.users.me, {}))?.trustedLender).toBe(true);
  });
});

describe("loan flow", () => {
  it("auto-declines overlapping requests when one is approved, and logs notifications", async () => {
    const { t, as } = setup();
    const alice = as("Alice", "alice@example.com");
    const bob = as("Bob", "bob@example.com");
    const carol = as("Carol", "carol@example.com");
    for (const u of [alice, bob, carol]) await u.mutation(api.users.store, {});
    const toolId = await alice.mutation(api.tools.create, { name: "Mower", category: "Garden" });
    const today = todayUtc();

    const bobLoan = await bob.mutation(api.loans.request, { toolId, startDate: today, endDate: today });
    const carolLoan = await carol.mutation(api.loans.request, { toolId, startDate: today, endDate: today });
    await alice.mutation(api.loans.approve, { loanId: bobLoan });

    const [carolView] = await carol.query(api.loans.myRequests, {});
    expect(carolView._id).toBe(carolLoan);
    expect(carolView.status).toBe("declined");

    await expect(
      carol.mutation(api.loans.request, { toolId, startDate: today, endDate: today }),
    ).rejects.toThrow(/already booked/);

    const events = await t.run((ctx) => ctx.db.query("automationEvents").collect());
    // requested x2, approved, auto-declined
    expect(events.filter((e) => e.kind === "notification")).toHaveLength(4);
  });
});

describe("n8n HTTP endpoints", () => {
  it("rejects unsigned and badly signed calls", async () => {
    const { t } = setup();
    const unsigned = await t.fetch("/n8n/overdue-loans", { method: "GET" });
    expect(unsigned.status).toBe(401);
    const forged = await t.fetch("/n8n/overdue-loans", {
      method: "GET",
      headers: { "x-lendloop-timestamp": String(Date.now()), "x-lendloop-signature": "sha256=00" },
    });
    expect(forged.status).toBe(401);
  });

  it("lists overdue loans and records reminders idempotently", async () => {
    const { t, as } = setup();
    const alice = as("Alice", "alice@example.com");
    const bob = as("Bob Jones", "bob@example.com");
    await alice.mutation(api.users.store, {});
    await bob.mutation(api.users.store, {});
    const toolId = await alice.mutation(api.tools.create, { name: "Pressure washer", category: "Cleaning" });

    // Seed an approved loan that ended three days ago.
    const loanId = await t.run(async (ctx) => {
      const tool = (await ctx.db.get(toolId))!;
      const borrower = (await ctx.db.query("users").collect()).find((u) => u.email === "bob@example.com")!;
      return ctx.db.insert("loans", {
        toolId,
        lenderId: tool.ownerId,
        borrowerId: borrower._id,
        startDate: "2020-01-01",
        endDate: "2020-01-03",
        status: "approved",
      });
    });

    const listRes = await signedFetch(t, "GET", "/n8n/overdue-loans");
    expect(listRes.status).toBe(200);
    const list = await listRes.json();
    expect(list.loans).toHaveLength(1);
    expect(list.loans[0]).toMatchObject({ loanId, borrower: { name: "Bob", email: "bob@example.com" } });
    expect(list.loans[0].lender).not.toHaveProperty("email");

    const payload = { loanId, day: list.day, status: "sent" };
    const first = await signedFetch(t, "POST", "/n8n/overdue-reminders", payload);
    const replay = await signedFetch(t, "POST", "/n8n/overdue-reminders", payload);
    expect(await first.json()).toEqual({ result: "created" });
    expect(await replay.json()).toEqual({ result: "duplicate" });

    const reminders = await t.run((ctx) =>
      ctx.db.query("automationEvents").withIndex("by_kind", (q) => q.eq("kind", "overdue_reminder")).collect(),
    );
    expect(reminders).toHaveLength(1);

    // Already reminded today, so the next run skips it.
    const again = await (await signedFetch(t, "GET", "/n8n/overdue-loans")).json();
    expect(again.loans).toHaveLength(0);
  });

  it("records workflow errors once per execution", async () => {
    const { t } = setup();
    const err = { executionId: "42", workflowName: "LendLoop overdue", message: "SMTP down" };
    await signedFetch(t, "POST", "/n8n/workflow-errors", err);
    await signedFetch(t, "POST", "/n8n/workflow-errors", err);
    const rows = await t.run((ctx) => ctx.db.query("automationEvents").collect());
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "workflow_error", status: "failed" });
  });

  it("validates write-back payloads", async () => {
    const { t } = setup();
    const res = await signedFetch(t, "POST", "/n8n/overdue-reminders", { loanId: "x", day: "nope", status: "sent" });
    expect(res.status).toBe(400);
  });
});
