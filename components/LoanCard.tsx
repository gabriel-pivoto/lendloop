"use client";

import { useMutation } from "convex/react";
import { useState } from "react";
import { api } from "@/convex/_generated/api";
import type { FunctionReturnType } from "convex/server";
import { Badge, Button, Card, ErrorText, inputClass, useRun } from "./ui";

export type LoanView = FunctionReturnType<typeof api.loans.myRequests>[number];
type Perspective = "borrower" | "lender" | "admin";

const statusTone = {
  requested: "amber",
  approved: "green",
  declined: "red",
  cancelled: "gray",
  returned: "blue",
} as const;

const activityTone = {
  pending: "gray",
  retrying: "amber",
  delivered: "blue",
  sent: "green",
  failed: "red",
  skipped: "gray",
} as const;

const fmtDate = (iso: string) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });

const fmtTime = (ms: number) =>
  new Date(ms).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" });

function Activity({ loan }: { loan: LoanView }) {
  if (loan.activity.length === 0) return null;
  return (
    <details className="mt-3 text-xs text-stone-600">
      <summary className="cursor-pointer select-none text-stone-500">
        Automation activity ({loan.activity.length})
      </summary>
      <ol className="mt-2 space-y-1 border-l border-stone-200 pl-3">
        {loan.activity.map((a) => (
          <li key={a._id} className="flex flex-wrap items-center gap-2">
            <span className="text-stone-400">{fmtTime(a.at)}</span>
            <Badge tone={activityTone[a.status]}>{a.status}</Badge>
            <span>
              {a.kind === "overdue_reminder" ? "Overdue reminder" : `Notification ${a.event ?? ""}`}
            </span>
            {a.detail && <span className="text-stone-400">· {a.detail}</span>}
          </li>
        ))}
      </ol>
    </details>
  );
}

export function LoanCard({ loan, perspective }: { loan: LoanView; perspective: Perspective }) {
  const approve = useMutation(api.loans.approve);
  const decline = useMutation(api.loans.decline);
  const cancel = useMutation(api.loans.cancel);
  const markReturned = useMutation(api.loans.markReturned);
  const { run, busy, error } = useRun();
  const [declining, setDeclining] = useState(false);
  const [reason, setReason] = useState("");

  const who =
    perspective === "borrower"
      ? `from ${loan.lenderName}`
      : perspective === "lender"
        ? `requested by ${loan.borrowerName}`
        : `${loan.borrowerName} ← ${loan.lenderName}`;

  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="font-medium">
            {loan.toolName}{" "}
            <span className="text-sm font-normal text-stone-500">{who}</span>
            {loan.lenderTrusted && perspective !== "lender" && (
              <span className="ml-2">
                <Badge tone="green">Trusted Lender</Badge>
              </span>
            )}
          </p>
          <p className="text-sm text-stone-600">
            {fmtDate(loan.startDate)} → {fmtDate(loan.endDate)}
          </p>
          {loan.note && <p className="mt-1 text-sm text-stone-600">“{loan.note}”</p>}
          {loan.statusReason && <p className="mt-1 text-xs text-stone-500">{loan.statusReason}</p>}
        </div>
        <div className="flex items-center gap-2">
          {loan.overdue && <Badge tone="red">Overdue</Badge>}
          <Badge tone={statusTone[loan.status]}>{loan.status}</Badge>
        </div>
      </div>

      {perspective === "lender" && loan.status === "requested" && !declining && (
        <div className="mt-3 flex gap-2">
          <Button disabled={busy} onClick={() => run(() => approve({ loanId: loan._id }))}>
            Approve
          </Button>
          <Button variant="secondary" disabled={busy} onClick={() => setDeclining(true)}>
            Decline
          </Button>
        </div>
      )}
      {perspective === "lender" && declining && (
        <form
          className="mt-3 flex flex-wrap gap-2"
          onSubmit={async (e) => {
            e.preventDefault();
            if (await run(() => decline({ loanId: loan._id, reason: reason || undefined })))
              setDeclining(false);
          }}
        >
          <input
            className={`${inputClass} max-w-xs`}
            placeholder="Reason (optional)"
            maxLength={200}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
          <Button type="submit" variant="danger" disabled={busy}>
            Confirm decline
          </Button>
          <Button type="button" variant="ghost" onClick={() => setDeclining(false)}>
            Back
          </Button>
        </form>
      )}
      {perspective === "lender" && loan.status === "approved" && (
        <div className="mt-3">
          <Button disabled={busy} onClick={() => run(() => markReturned({ loanId: loan._id }))}>
            Mark as returned
          </Button>
        </div>
      )}
      {perspective === "borrower" && loan.status === "requested" && (
        <div className="mt-3">
          <Button variant="secondary" disabled={busy} onClick={() => run(() => cancel({ loanId: loan._id }))}>
            Cancel request
          </Button>
        </div>
      )}
      <ErrorText>{error}</ErrorText>
      <Activity loan={loan} />
    </Card>
  );
}

export function LoanList({
  loans,
  perspective,
  empty,
}: {
  loans: LoanView[] | undefined;
  perspective: Perspective;
  empty: string;
}) {
  if (loans === undefined) return <p className="text-sm text-stone-500">Loading…</p>;
  if (loans.length === 0)
    return (
      <p className="rounded-lg border border-dashed border-stone-300 p-6 text-center text-sm text-stone-500">
        {empty}
      </p>
    );
  return (
    <div className="space-y-3">
      {loans.map((l) => (
        <LoanCard key={l._id} loan={l} perspective={perspective} />
      ))}
    </div>
  );
}
