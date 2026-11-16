import { describe, expect, it } from "vitest";
import {
  canTransition,
  isIsoDate,
  isOverdue,
  rangesOverlap,
  validateRange,
} from "./loanRules";
import { signPayload, verifySignature } from "./hmac";

describe("loan state machine", () => {
  it("lets only the lender approve, decline and mark returned", () => {
    expect(canTransition("requested", "approved", "lender")).toBe(true);
    expect(canTransition("requested", "approved", "borrower")).toBe(false);
    expect(canTransition("requested", "declined", "lender")).toBe(true);
    expect(canTransition("approved", "returned", "lender")).toBe(true);
    expect(canTransition("approved", "returned", "borrower")).toBe(false);
  });

  it("lets only the borrower cancel, and only while pending", () => {
    expect(canTransition("requested", "cancelled", "borrower")).toBe(true);
    expect(canTransition("requested", "cancelled", "lender")).toBe(false);
    expect(canTransition("approved", "cancelled", "borrower")).toBe(false);
  });

  it("treats terminal states as final", () => {
    for (const to of ["requested", "approved", "returned"] as const) {
      expect(canTransition("returned", to, "lender")).toBe(false);
      expect(canTransition("declined", to, "lender")).toBe(false);
    }
  });
});

describe("dates", () => {
  it("validates real calendar dates", () => {
    expect(isIsoDate("2026-02-28")).toBe(true);
    expect(isIsoDate("2026-02-30")).toBe(false);
    expect(isIsoDate("26-2-1")).toBe(false);
  });

  it("detects inclusive overlaps", () => {
    expect(rangesOverlap("2026-01-01", "2026-01-05", "2026-01-05", "2026-01-07")).toBe(true);
    expect(rangesOverlap("2026-01-01", "2026-01-04", "2026-01-05", "2026-01-07")).toBe(false);
  });

  it("rejects past, inverted and overly long ranges", () => {
    const today = "2026-11-15";
    expect(validateRange("2026-11-14", "2026-11-16", today)).toMatch(/past/);
    expect(validateRange("2026-11-20", "2026-11-18", today)).toMatch(/after/);
    expect(validateRange("2026-11-15", "2026-12-31", today)).toMatch(/30 days/);
    expect(validateRange("2026-11-15", "2026-11-15", today)).toBeNull();
  });

  it("flags approved loans past their end date as overdue", () => {
    expect(isOverdue({ status: "approved", endDate: "2026-11-14" }, "2026-11-15")).toBe(true);
    expect(isOverdue({ status: "approved", endDate: "2026-11-15" }, "2026-11-15")).toBe(false);
    expect(isOverdue({ status: "returned", endDate: "2026-11-01" }, "2026-11-15")).toBe(false);
  });
});

describe("HMAC signatures", () => {
  const secret = "s3cret";
  const scope = "POST /n8n/overdue-reminders";
  const body = JSON.stringify({ loanId: "abc", day: "2026-11-15", status: "sent" });

  it("accepts a fresh, correctly signed payload", async () => {
    const now = Date.now();
    const { timestamp, signature } = await signPayload(secret, scope, body, now);
    expect(await verifySignature({ secret, scope, body, timestamp, signature, now })).toEqual({ ok: true });
  });

  it("rejects a tampered body, a different endpoint and a wrong secret", async () => {
    const now = Date.now();
    const { timestamp, signature } = await signPayload(secret, scope, body, now);
    const base = { secret, scope, body, timestamp, signature, now };
    expect((await verifySignature({ ...base, body: body.replace("sent", "failed") })).ok).toBe(false);
    expect((await verifySignature({ ...base, scope: "POST /n8n/workflow-errors" })).ok).toBe(false);
    expect((await verifySignature({ ...base, secret: "other" })).ok).toBe(false);
  });

  it("rejects replays outside the 5 minute window", async () => {
    const then = Date.now() - 6 * 60 * 1000;
    const { timestamp, signature } = await signPayload(secret, scope, body, then);
    expect(await verifySignature({ secret, scope, body, timestamp, signature })).toEqual({
      ok: false,
      reason: "stale",
    });
  });

  it("fails closed when no secret is configured", async () => {
    expect(
      await verifySignature({ secret: undefined, scope, body, timestamp: "1", signature: "x" }),
    ).toEqual({ ok: false, reason: "missing_secret" });
  });
});
