// HTTP endpoints for n8n. Each one:
//   1. reads the raw body once,
//   2. verifies X-LendLoop-Timestamp / X-LendLoop-Signature (HMAC-SHA256 over
//      `${timestamp}.${METHOD} ${path}.${rawBody}`, 5 minute window),
//   3. validates the JSON shape,
//   4. calls an internal function. Internal functions are not reachable from
//      the browser client, so this file is the only way in for n8n.
import { httpRouter } from "convex/server";
import { ConvexError } from "convex/values";
import { internal } from "./_generated/api";
import { httpAction, type ActionCtx } from "./_generated/server";
import { SIGNATURE_HEADER, TIMESTAMP_HEADER, verifySignature } from "./lib/hmac";
import { isIsoDate, todayUtc } from "./lib/loanRules";

const MAX_BODY_BYTES = 16 * 1024;

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

type Handler = (ctx: ActionCtx, body: unknown, url: URL) => Promise<Response>;

function signed(method: "GET" | "POST", path: string, handler: Handler) {
  return httpAction(async (ctx, req) => {
    const raw = method === "GET" ? "" : await req.text();
    if (raw.length > MAX_BODY_BYTES) return json(413, { error: "payload_too_large" });

    const check = await verifySignature({
      secret: process.env.LENDLOOP_HMAC_SECRET,
      scope: `${method} ${path}`,
      body: raw,
      timestamp: req.headers.get(TIMESTAMP_HEADER),
      signature: req.headers.get(SIGNATURE_HEADER),
    });
    if (!check.ok) {
      // Do not tell the caller which part failed beyond a coarse reason.
      const status = check.reason === "missing_secret" ? 503 : 401;
      console.warn(`Rejected ${method} ${path}: ${check.reason}`);
      return json(status, { error: status === 503 ? "not_configured" : "unauthorized" });
    }

    let body: unknown = null;
    if (raw) {
      try {
        body = JSON.parse(raw);
      } catch {
        return json(400, { error: "invalid_json" });
      }
    }
    try {
      return await handler(ctx, body, new URL(req.url));
    } catch (err) {
      if (err instanceof ConvexError) return json(422, { error: String(err.data) });
      console.error(`Error in ${method} ${path}`, err);
      return json(500, { error: "internal_error" });
    }
  });
}

function obj(body: unknown): Record<string, unknown> {
  return body && typeof body === "object" && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : {};
}
const str = (x: unknown, max = 200) =>
  typeof x === "string" && x.length > 0 && x.length <= max ? x : null;
const resultStatus = (x: unknown) => (x === "sent" || x === "failed" ? x : null);

const http = httpRouter();

/** Daily overdue job pulls its work list from here. */
http.route({
  path: "/n8n/overdue-loans",
  method: "GET",
  handler: signed("GET", "/n8n/overdue-loans", async (ctx) => {
    const today = todayUtc();
    const loans = await ctx.runQuery(internal.automation.overdueLoans, { today });
    return json(200, { day: today, count: loans.length, loans });
  }),
});

/** Write-back from the overdue workflow, once per loan per day. */
http.route({
  path: "/n8n/overdue-reminders",
  method: "POST",
  handler: signed("POST", "/n8n/overdue-reminders", async (ctx, body) => {
    const b = obj(body);
    const loanId = str(b.loanId, 64);
    const day = str(b.day, 10);
    const status = resultStatus(b.status);
    if (!loanId || !day || !isIsoDate(day) || !status)
      return json(400, { error: "expected { loanId, day: YYYY-MM-DD, status: sent|failed }" });
    const res = await ctx.runMutation(internal.automation.recordReminderResult, {
      loanId,
      day,
      status,
      detail: str(b.detail, 300) ?? undefined,
    });
    return json(200, res);
  }),
});

/** Write-back from the request notification workflow. */
http.route({
  path: "/n8n/notification-results",
  method: "POST",
  handler: signed("POST", "/n8n/notification-results", async (ctx, body) => {
    const b = obj(body);
    const eventId = str(b.eventId, 64);
    const status = resultStatus(b.status);
    if (!eventId || !status)
      return json(400, { error: "expected { eventId, status: sent|failed }" });
    const res = await ctx.runMutation(internal.automation.recordNotificationResult, {
      eventId,
      status,
      detail: str(b.detail, 300) ?? undefined,
    });
    return json(200, res);
  }),
});

/** n8n error workflow reports any failed execution here. */
http.route({
  path: "/n8n/workflow-errors",
  method: "POST",
  handler: signed("POST", "/n8n/workflow-errors", async (ctx, body) => {
    const b = obj(body);
    const executionId = str(b.executionId, 64);
    const workflowName = str(b.workflowName, 200);
    const message = str(b.message, 2000);
    if (!executionId || !workflowName || !message)
      return json(400, { error: "expected { executionId, workflowName, message }" });
    const res = await ctx.runMutation(internal.automation.recordWorkflowError, {
      executionId,
      workflowName,
      message,
      nodeName: str(b.nodeName, 200) ?? undefined,
    });
    return json(200, res);
  }),
});

export default http;
