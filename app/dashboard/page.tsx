"use client";

import { useMutation, useQuery } from "convex/react";
import { useState } from "react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import {
  Badge,
  Button,
  Card,
  CategoryFilter,
  Empty,
  ErrorText,
  Loading,
  inputClass,
  useRun,
} from "@/components/ui";

const today = () => new Date().toISOString().slice(0, 10);

function RequestForm({ toolId, onSent, onCancel }: { toolId: Id<"tools">; onSent: () => void; onCancel: () => void }) {
  const request = useMutation(api.loans.request);
  const { run, busy, error } = useRun();
  const [start, setStart] = useState(today());
  const [end, setEnd] = useState(today());
  const [note, setNote] = useState("");
  return (
    <form
      className="mt-3 space-y-2 border-t border-stone-100 pt-3"
      onSubmit={async (e) => {
        e.preventDefault();
        const ok = await run(() =>
          request({ toolId, startDate: start, endDate: end, note: note || undefined }),
        );
        if (ok) onSent();
      }}
    >
      <div className="grid grid-cols-2 gap-2">
        <label className="text-xs text-stone-600">
          From
          <input type="date" required min={today()} className={inputClass} value={start}
            onChange={(e) => { setStart(e.target.value); if (e.target.value > end) setEnd(e.target.value); }} />
        </label>
        <label className="text-xs text-stone-600">
          Until
          <input type="date" required min={start} className={inputClass} value={end}
            onChange={(e) => setEnd(e.target.value)} />
        </label>
      </div>
      <input className={inputClass} placeholder="Note for the owner (optional)" maxLength={300}
        value={note} onChange={(e) => setNote(e.target.value)} />
      <ErrorText>{error}</ErrorText>
      <div className="flex gap-2">
        <Button type="submit" disabled={busy}>Send request</Button>
        <Button type="button" variant="ghost" onClick={onCancel}>Cancel</Button>
      </div>
    </form>
  );
}

export default function BrowsePage() {
  const categories = useQuery(api.tools.categories) ?? [];
  const [category, setCategory] = useState("");
  const tools = useQuery(api.tools.browse, { category: category || undefined });
  const [requesting, setRequesting] = useState<Id<"tools"> | null>(null);
  const [sent, setSent] = useState<string | null>(null);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold">Browse tools</h1>
        <p className="text-sm text-stone-600">Pick a tool and ask its owner for the days you need it.</p>
      </div>
      <CategoryFilter categories={categories} value={category} onChange={setCategory} />
      {sent && (
        <p role="status" className="rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
          Request sent for {sent}. Track it under My requests.
        </p>
      )}
      {tools === undefined ? (
        <Loading />
      ) : tools.length === 0 ? (
        <Empty>No tools in this category yet.</Empty>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {tools.map((t) => (
            <Card key={t._id}>
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="font-medium">{t.name}</p>
                  <p className="text-sm text-stone-500">
                    {t.isMine ? "Your listing" : `Lent by ${t.ownerName}`}
                    {t.ownerTrusted && (
                      <span className="ml-2"><Badge tone="green">Trusted Lender</Badge></span>
                    )}
                  </p>
                </div>
                <Badge>{t.category}</Badge>
              </div>
              {t.description && <p className="mt-2 text-sm text-stone-600">{t.description}</p>}
              {!t.isMine && requesting !== t._id && (
                <Button className="mt-3" variant="secondary"
                  onClick={() => { setRequesting(t._id); setSent(null); }}>
                  Request to borrow
                </Button>
              )}
              {requesting === t._id && (
                <RequestForm toolId={t._id} onCancel={() => setRequesting(null)}
                  onSent={() => { setRequesting(null); setSent(t.name); }} />
              )}
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
