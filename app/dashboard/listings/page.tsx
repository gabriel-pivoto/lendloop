"use client";

import { useMutation, useQuery } from "convex/react";
import { useState } from "react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Badge, Button, Card, Empty, ErrorText, Loading, inputClass, useRun } from "@/components/ui";

type Draft = { name: string; category: string; description: string };
const blank: Draft = { name: "", category: "", description: "" };

function ToolForm({
  initial,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  initial: Draft;
  submitLabel: string;
  onSubmit: (d: Draft) => Promise<unknown>;
  onCancel?: () => void;
}) {
  const categories = useQuery(api.tools.categories) ?? [];
  const [draft, setDraft] = useState(initial);
  const { run, busy, error } = useRun();
  return (
    <form
      className="space-y-2"
      onSubmit={async (e) => {
        e.preventDefault();
        if (await run(() => onSubmit(draft)) && !onCancel) setDraft(blank);
      }}
    >
      <div className="grid gap-2 sm:grid-cols-[2fr_1fr]">
        <input className={inputClass} placeholder="Tool name, e.g. Cordless drill" required
          minLength={2} maxLength={80} value={draft.name}
          onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
        <select className={inputClass} required value={draft.category}
          onChange={(e) => setDraft({ ...draft, category: e.target.value })}>
          <option value="" disabled>Category</option>
          {/* Explicit value: without it, browser auto-translation rewrites the
              option text and the translated text would be submitted. */}
          {categories.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
      </div>
      <textarea className={inputClass} rows={2} maxLength={500}
        placeholder="Condition, pickup notes… (optional, visible to signed-in neighbors)"
        value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
      <ErrorText>{error}</ErrorText>
      <div className="flex gap-2">
        <Button type="submit" disabled={busy}>{submitLabel}</Button>
        {onCancel && <Button type="button" variant="ghost" onClick={onCancel}>Cancel</Button>}
      </div>
    </form>
  );
}

export default function ListingsPage() {
  const tools = useQuery(api.tools.mine);
  const create = useMutation(api.tools.create);
  const update = useMutation(api.tools.update);
  const remove = useMutation(api.tools.remove);
  const [editing, setEditing] = useState<Id<"tools"> | null>(null);
  const [confirming, setConfirming] = useState<Id<"tools"> | null>(null);
  const { run, busy, error } = useRun();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">My listings</h1>
        <p className="text-sm text-stone-600">Tools you are happy to lend.</p>
      </div>
      <Card>
        <h2 className="mb-2 text-sm font-semibold">List a new tool</h2>
        <ToolForm initial={blank} submitLabel="Add listing"
          onSubmit={(d) => create({ name: d.name, category: d.category, description: d.description || undefined })} />
      </Card>
      <ErrorText>{error}</ErrorText>
      {tools === undefined ? (
        <Loading />
      ) : tools.length === 0 ? (
        <Empty>You have not listed anything yet.</Empty>
      ) : (
        <div className="space-y-3">
          {tools.map((t) => (
            <Card key={t._id}>
              {editing === t._id ? (
                <ToolForm
                  initial={{ name: t.name, category: t.category, description: t.description ?? "" }}
                  submitLabel="Save"
                  onCancel={() => setEditing(null)}
                  onSubmit={async (d) => {
                    await update({ toolId: t._id, name: d.name, category: d.category, description: d.description || undefined });
                    setEditing(null);
                  }}
                />
              ) : (
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p className="font-medium">
                      {t.name} <span className="ml-1"><Badge>{t.category}</Badge></span>
                    </p>
                    {t.description && <p className="mt-1 text-sm text-stone-600">{t.description}</p>}
                    <p className="mt-1 flex gap-2 text-xs">
                      {t.onLoan && <Badge tone="blue">On loan</Badge>}
                      {t.pendingRequests > 0 && (
                        <Badge tone="amber">{t.pendingRequests} pending request{t.pendingRequests > 1 ? "s" : ""}</Badge>
                      )}
                    </p>
                  </div>
                  <div className="flex gap-2">
                    {confirming === t._id ? (
                      <>
                        <Button variant="danger" disabled={busy}
                          onClick={async () => { await run(() => remove({ toolId: t._id })); setConfirming(null); }}>
                          Confirm delete
                        </Button>
                        <Button variant="ghost" onClick={() => setConfirming(null)}>Keep</Button>
                      </>
                    ) : (
                      <>
                        <Button variant="secondary" onClick={() => setEditing(t._id)}>Edit</Button>
                        <Button variant="danger" onClick={() => setConfirming(t._id)}>Delete</Button>
                      </>
                    )}
                  </div>
                </div>
              )}
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
