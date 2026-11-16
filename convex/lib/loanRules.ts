// Pure domain rules for loans. No database access, so they can be unit tested
// in isolation and reused by queries, mutations and HTTP actions alike.
import { ConvexError } from "convex/values";

export const LOAN_STATUSES = [
  "requested",
  "approved",
  "declined",
  "cancelled",
  "returned",
] as const;
export type LoanStatus = (typeof LOAN_STATUSES)[number];

export type Actor = "lender" | "borrower";

export const CATEGORIES = [
  "Power tools",
  "Hand tools",
  "Garden",
  "Ladders",
  "Cleaning",
  "Camping",
  "Kitchen",
  "Other",
] as const;
export type Category = (typeof CATEGORIES)[number];

export const MAX_LOAN_DAYS = 30;
export const MAX_BOOKING_HORIZON_DAYS = 180;

// Allowed transitions and who may perform each one. Anything not listed here
// is rejected, which keeps the state machine closed by default.
const TRANSITIONS: Record<LoanStatus, Partial<Record<LoanStatus, Actor>>> = {
  requested: { approved: "lender", declined: "lender", cancelled: "borrower" },
  approved: { returned: "lender" },
  declined: {},
  cancelled: {},
  returned: {},
};

export function canTransition(
  from: LoanStatus,
  to: LoanStatus,
  actor: Actor,
): boolean {
  return TRANSITIONS[from][to] === actor;
}

export function isCategory(value: string): value is Category {
  return (CATEGORIES as readonly string[]).includes(value);
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function isIsoDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

/** Today's date in UTC as YYYY-MM-DD. Loans are day-granular. */
export function todayUtc(now: number = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10);
}

export function daysBetween(start: string, end: string): number {
  const ms =
    new Date(`${end}T00:00:00Z`).getTime() -
    new Date(`${start}T00:00:00Z`).getTime();
  return Math.round(ms / 86_400_000);
}

/** Inclusive date ranges; ISO strings compare correctly as strings. */
export function rangesOverlap(
  aStart: string,
  aEnd: string,
  bStart: string,
  bEnd: string,
): boolean {
  return aStart <= bEnd && bStart <= aEnd;
}

/** Returns an error message, or null when the range is acceptable. */
export function validateRange(
  start: string,
  end: string,
  today: string,
): string | null {
  if (!isIsoDate(start) || !isIsoDate(end)) return "Dates must be YYYY-MM-DD.";
  if (start < today) return "Start date cannot be in the past.";
  if (end < start) return "End date must be on or after the start date.";
  if (daysBetween(start, end) + 1 > MAX_LOAN_DAYS)
    return `Loans are limited to ${MAX_LOAN_DAYS} days.`;
  if (daysBetween(today, start) > MAX_BOOKING_HORIZON_DAYS)
    return `Requests can be made at most ${MAX_BOOKING_HORIZON_DAYS} days ahead.`;
  return null;
}

export function isOverdue(
  loan: { status: LoanStatus; endDate: string },
  today: string,
): boolean {
  return loan.status === "approved" && loan.endDate < today;
}

export function cleanText(
  value: string | undefined,
  { field, min = 0, max }: { field: string; min?: number; max: number },
): string | undefined {
  const trimmed = (value ?? "").trim().replace(/\s+/g, " ");
  if (trimmed.length < min) throw new ConvexError(`${field} is too short.`);
  if (trimmed.length > max)
    throw new ConvexError(`${field} must be at most ${max} characters.`);
  return trimmed.length ? trimmed : undefined;
}
