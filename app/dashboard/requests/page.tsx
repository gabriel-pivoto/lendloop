"use client";

import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { LoanList } from "@/components/LoanCard";

export default function MyRequestsPage() {
  const loans = useQuery(api.loans.myRequests);
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold">My requests</h1>
        <p className="text-sm text-stone-600">Tools you asked to borrow and where each request stands.</p>
      </div>
      <LoanList loans={loans} perspective="borrower" empty="You have not requested anything yet." />
    </div>
  );
}
