import { auth } from "@clerk/nextjs/server";
import type { ReactNode } from "react";
import { DashboardShell } from "@/components/DashboardShell";

// Server-side page guard: unauthenticated visitors are sent to sign in.
// This is UX only. Data access is authorized again inside every Convex
// function, so a request that bypasses this page still gets nothing.
export default async function DashboardLayout({ children }: { children: ReactNode }) {
  await auth.protect();
  return <DashboardShell>{children}</DashboardShell>;
}
