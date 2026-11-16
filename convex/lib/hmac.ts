// HMAC-SHA256 request signing shared by both directions:
//   Convex -> n8n  (loan event webhooks)
//   n8n -> Convex  (overdue list, write-backs, workflow errors)
//
// Signed message: `${timestamp}.${scope}.${rawBody}`
//   timestamp: unix epoch in milliseconds, sent in X-LendLoop-Timestamp
//   scope:     "METHOD /path" for calls into Convex, "POST loan-event" for the
//              outbound webhook. Binding method and path stops a signature for
//              one endpoint from being replayed against another.
//   rawBody:   the exact bytes sent ("" for GET)
// Header: X-LendLoop-Signature: sha256=<hex>
//
// Only Web Crypto is used, so this runs in the Convex runtime, Node and tests.

export const SIGNATURE_HEADER = "x-lendloop-signature";
export const TIMESTAMP_HEADER = "x-lendloop-timestamp";
export const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

const encoder = new TextEncoder();

export function canonicalMessage(
  timestamp: string,
  scope: string,
  body: string,
): string {
  return `${timestamp}.${scope}.${body}`;
}

export async function hmacSha256Hex(
  secret: string,
  message: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(message));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Constant-time comparison so response timing does not leak the digest. */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function signPayload(
  secret: string,
  scope: string,
  body: string,
  now: number = Date.now(),
): Promise<{ timestamp: string; signature: string }> {
  const timestamp = String(now);
  const digest = await hmacSha256Hex(
    secret,
    canonicalMessage(timestamp, scope, body),
  );
  return { timestamp, signature: `sha256=${digest}` };
}

export type VerifyResult =
  | { ok: true }
  | {
      ok: false;
      reason:
        | "missing_secret"
        | "missing_headers"
        | "bad_timestamp"
        | "stale"
        | "bad_signature";
    };

export async function verifySignature(input: {
  secret: string | undefined;
  scope: string;
  body: string;
  timestamp: string | null;
  signature: string | null;
  now?: number;
}): Promise<VerifyResult> {
  const { secret, scope, body, timestamp, signature } = input;
  const now = input.now ?? Date.now();
  if (!secret) return { ok: false, reason: "missing_secret" };
  if (!timestamp || !signature) return { ok: false, reason: "missing_headers" };
  if (!/^\d{10,16}$/.test(timestamp))
    return { ok: false, reason: "bad_timestamp" };
  if (Math.abs(now - Number(timestamp)) > MAX_CLOCK_SKEW_MS)
    return { ok: false, reason: "stale" };
  const expected = `sha256=${await hmacSha256Hex(
    secret,
    canonicalMessage(timestamp, scope, body),
  )}`;
  return timingSafeEqual(expected, signature)
    ? { ok: true }
    : { ok: false, reason: "bad_signature" };
}
