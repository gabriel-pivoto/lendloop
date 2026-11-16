"use client";

import { ConvexError } from "convex/values";
import { useCallback, useState, type ButtonHTMLAttributes, type ReactNode } from "react";

export function errorMessage(err: unknown): string {
  if (err instanceof ConvexError) return String(err.data);
  return "Something went wrong. Please try again.";
}

/** Runs a mutation with busy and error state, so every form behaves the same. */
export function useRun() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      return true;
    } catch (err) {
      setError(errorMessage(err));
      return false;
    } finally {
      setBusy(false);
    }
  }, []);
  return { run, busy, error, setError };
}

type Variant = "primary" | "secondary" | "danger" | "ghost";
const variants: Record<Variant, string> = {
  primary: "bg-emerald-700 text-white hover:bg-emerald-800",
  secondary: "bg-white text-stone-800 ring-1 ring-stone-300 hover:bg-stone-50",
  danger: "bg-white text-red-700 ring-1 ring-red-200 hover:bg-red-50",
  ghost: "text-stone-600 hover:bg-stone-100",
};

export function Button({
  variant = "primary",
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return (
    <button
      className={`inline-flex items-center justify-center rounded-md px-3 py-1.5 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-50 ${variants[variant]} ${className}`}
      {...props}
    />
  );
}

const badgeTones = {
  gray: "bg-stone-100 text-stone-700",
  green: "bg-emerald-100 text-emerald-800",
  amber: "bg-amber-100 text-amber-800",
  red: "bg-red-100 text-red-800",
  blue: "bg-sky-100 text-sky-800",
} as const;

export function Badge({ tone = "gray", children }: { tone?: keyof typeof badgeTones; children: ReactNode }) {
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${badgeTones[tone]}`}>
      {children}
    </span>
  );
}

export function ErrorText({ children }: { children: ReactNode }) {
  if (!children) return null;
  return (
    <p role="alert" className="text-sm text-red-700">
      {children}
    </p>
  );
}

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`rounded-lg bg-white p-4 shadow-sm ring-1 ring-stone-200 ${className}`}>{children}</div>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="rounded-lg border border-dashed border-stone-300 p-6 text-center text-sm text-stone-500">{children}</p>;
}

export function Loading() {
  return <p className="text-sm text-stone-500">Loading…</p>;
}

export const inputClass =
  "w-full rounded-md border border-stone-300 bg-white px-3 py-1.5 text-sm focus:border-emerald-600 focus:outline-none focus:ring-1 focus:ring-emerald-600";

export function CategoryFilter({
  categories,
  value,
  onChange,
}: {
  categories: string[];
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="flex flex-wrap gap-2" role="group" aria-label="Filter by category">
      {["", ...categories].map((c) => (
        <button
          key={c || "all"}
          onClick={() => onChange(c)}
          aria-pressed={value === c}
          className={`rounded-full px-3 py-1 text-xs font-medium ring-1 transition ${
            value === c
              ? "bg-emerald-700 text-white ring-emerald-700"
              : "bg-white text-stone-700 ring-stone-300 hover:bg-stone-50"
          }`}
        >
          {c || "All"}
        </button>
      ))}
    </div>
  );
}
