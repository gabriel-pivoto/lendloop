"use client";

import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { LoanList } from "@/components/LoanCard";

export default function IncomingPage() {
  const loans = useQuery(api.loans.incoming);
  const open = loans?.filter((l) => l.status === "requested" || l.status === "approved");
  const closed = loans?.filter((l) => l.status !== "requested" && l.status !== "approved");
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Incoming requests</h1>
        <p className="text-sm text-stone-600">Approve or decline requests for your tools, and mark loans as returned.</p>
      </div>
      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-stone-700">Needs your attention</h2>
        <LoanList loans={open} perspective="lender" empty="Nothing waiting on you." />
      </section>
      {closed && closed.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-sm font-semibold text-stone-700">History</h2>
          <LoanList loans={closed} perspective="lender" empty="" />
        </section>
      )}
    </div>
  );
}
