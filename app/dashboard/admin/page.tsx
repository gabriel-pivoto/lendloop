"use client";

import { useMutation, useQuery } from "convex/react";
import { useState } from "react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { LoanList } from "@/components/LoanCard";
import { Badge, Button, Card, Empty, ErrorText, Loading, useRun } from "@/components/ui";

const filters = ["", "requested", "approved", "overdue", "returned", "declined", "cancelled"];

function Listings() {
  const tools = useQuery(api.tools.browse, {});
  const remove = useMutation(api.tools.remove);
  const { run, busy, error } = useRun();
  const [confirming, setConfirming] = useState<Id<"tools"> | null>(null);
  if (tools === undefined) return <Loading />;
  if (tools.length === 0) return <Empty>No listings.</Empty>;
  return (
    <div className="space-y-2">
      <ErrorText>{error}</ErrorText>
      {tools.map((t) => (
        <div key={t._id} className="flex items-center justify-between rounded-md bg-white px-3 py-2 ring-1 ring-stone-200">
          <span className="text-sm">
            <span className="font-medium">{t.name}</span>{" "}
            <span className="text-stone-500">· {t.category} · {t.ownerName}</span>
          </span>
          {confirming === t._id ? (
            <span className="flex gap-2">
              <Button variant="danger" disabled={busy}
                onClick={async () => { await run(() => remove({ toolId: t._id })); setConfirming(null); }}>
                Confirm remove
              </Button>
              <Button variant="ghost" onClick={() => setConfirming(null)}>Keep</Button>
            </span>
          ) : (
            <Button variant="danger" onClick={() => setConfirming(t._id)}>Remove</Button>
          )}
        </div>
      ))}
    </div>
  );
}

function Lenders() {
  const lenders = useQuery(api.users.listLenders);
  const setTrusted = useMutation(api.users.setTrustedLender);
  const { run, busy, error } = useRun();
  if (lenders === undefined) return <Loading />;
  if (lenders.length === 0) return <Empty>No lenders yet.</Empty>;
  return (
    <div className="space-y-2">
      <ErrorText>{error}</ErrorText>
      {lenders.map((u) => (
        <div key={u._id} className="flex items-center justify-between rounded-md bg-white px-3 py-2 ring-1 ring-stone-200">
          <span className="text-sm">
            <span className="font-medium">{u.name}</span>{" "}
            <span className="text-stone-500">· {u.activeListings} listing{u.activeListings === 1 ? "" : "s"}</span>
            {u.trustedLender && <span className="ml-2"><Badge tone="green">Trusted Lender</Badge></span>}
          </span>
          <Button variant="secondary" disabled={busy}
            onClick={() => run(() => setTrusted({ userId: u._id, trusted: !u.trustedLender }))}>
            {u.trustedLender ? "Revoke trusted" : "Mark trusted"}
          </Button>
        </div>
      ))}
    </div>
  );
}

function Problems() {
  const problems = useQuery(api.automation.recentProblems);
  if (problems === undefined) return <Loading />;
  if (problems.length === 0) return <Empty>No automation failures.</Empty>;
  return (
    <ul className="space-y-1 text-sm">
      {problems.map((p) => (
        <li key={p._id} className="rounded-md bg-white px-3 py-2 ring-1 ring-stone-200">
          <Badge tone={p.status === "retrying" ? "amber" : "red"}>{p.status}</Badge>{" "}
          <span className="font-medium">{p.kind}</span>{" "}
          <span className="text-stone-500">{p.event}</span>
          <p className="text-xs text-stone-500">
            {new Date(p.updatedAt).toLocaleString()} · {p.detail}
          </p>
        </li>
      ))}
    </ul>
  );
}

export default function AdminPage() {
  const me = useQuery(api.users.me);
  const [status, setStatus] = useState("");
  const loans = useQuery(api.loans.adminAll, me?.role === "admin" ? { status: status || undefined } : "skip");

  if (me === undefined) return <Loading />;
  if (me?.role !== "admin") return <Empty>This page is for admins.</Empty>;

  return (
    <div className="grid gap-6 lg:grid-cols-[3fr_2fr]">
      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h1 className="text-xl font-semibold">All loans</h1>
          <select className="rounded-md border border-stone-300 bg-white px-2 py-1 text-sm"
            value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Filter loans by status">
            {filters.map((f) => <option key={f} value={f}>{f || "All statuses"}</option>)}
          </select>
        </div>
        <LoanList loans={loans} perspective="admin" empty="No loans match." />
      </section>
      <aside className="space-y-6">
        <Card>
          <h2 className="mb-2 text-sm font-semibold">Automation problems</h2>
          <Problems />
        </Card>
        <Card>
          <h2 className="mb-2 text-sm font-semibold">Lenders</h2>
          <Lenders />
        </Card>
        <Card>
          <h2 className="mb-2 text-sm font-semibold">Listings</h2>
          <Listings />
        </Card>
      </aside>
    </div>
  );
}
