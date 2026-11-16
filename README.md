# LendLoop

A neighborhood tool-lending app. Neighbors list tools they are happy to lend, request each other's tools for a date range, and the owner approves, declines and marks them returned. n8n sends the emails: one when a request is created or changes status, and a daily reminder for overdue loans.

**Stack:** Next.js 15 (App Router) · Clerk · Convex · n8n 2.47 · TypeScript · Tailwind

## Contents

1. [Features](#features)
2. [Architecture](#architecture)
3. [Setup](#setup)
4. [Environment variables](#environment-variables)
5. [Security decisions](#security-decisions)
6. [Data minimization](#data-minimization)
7. [Integration and error handling](#integration-and-error-handling)
8. [Tests](#tests)
9. [What I would change for production](#what-i-would-change-for-production)

## Features

| Area | What it does |
|---|---|
| Public page | Tagline, a read-only list of tools showing name and category only, and a sign-in button |
| My listings | Create, edit and delete your own tools. Deleting is blocked while the tool is out on loan, and pending requests are declined with a notification |
| Browse | All tools with a category filter, the owner's first name and a **Trusted Lender** badge. Request a date range with an optional note |
| My requests | Your requests and their status. Cancel while pending |
| Incoming requests | Approve or decline requests for your tools, with an optional reason. Mark loans as returned. Approving automatically declines overlapping pending requests |
| Admin | All loans, filterable by status including *overdue*. Remove any listing. Mark lenders as Trusted Lender. Automation failures from n8n and Convex in one panel |
| Bonus | Each loan card has an **Automation activity** timeline: delivered, sent, retrying or failed, with details |

Business rules live in [convex/lib/loanRules.ts](convex/lib/loanRules.ts):

- Day-granular inclusive ranges.
- No past dates.
- Loans last at most 30 days and can be booked at most 180 days ahead.
- Approved loans on the same tool cannot overlap.
- A request whose start date has passed cannot be approved, only declined.
- The state machine is closed by default:

```
requested ──approve (lender)──▶ approved ──mark returned (lender)──▶ returned
    │ decline (lender)  ▶ declined
    └ cancel (borrower) ▶ cancelled
```

## Architecture

```
 Browser (Next.js + Clerk)                 Convex                                   n8n (Docker)
 ─────────────────────────      ─────────────────────────────────       ─────────────────────────────────
 Clerk session ──JWT──────────▶ queries / mutations
                                  └ access.ts: requireUser / requireAdmin
                                  └ status change + automationEvents row
                                    written in the SAME transaction
                                  └ scheduler ▶ deliverNotification ──HMAC POST──▶ ① Loan request notification
                                     (retries with backoff, 5 tries)       │  verify HMAC ▶ 202 / 401
                                                                           │  dedupe eventId ▶ email (SMTP)
                                http.ts  ◀────HMAC POST /n8n/notification-results ┘  write back sent/failed
                                  │
                                  ├◀──HMAC GET  /n8n/overdue-loans ──────── ② Daily overdue reminder (09:00 UTC)
                                  ├◀──HMAC POST /n8n/overdue-reminders ────    email each borrower, write back
                                  │     (idempotent per loan per day)
                                  └◀──HMAC POST /n8n/workflow-errors ────── ③ Error handler (errorWorkflow of ① and ②)
                                                                                          │
                                                                                Mailpit (local SMTP inbox)
```

| Path | Responsibility |
|---|---|
| [convex/schema.ts](convex/schema.ts) | `users`, `tools` (soft delete), `loans`, `automationEvents` (audit trail plus idempotency keys) |
| [convex/lib/access.ts](convex/lib/access.ts) | Every public function starts here. Authorization is on the server, never only in the UI |
| [convex/tools.ts](convex/tools.ts), [convex/loans.ts](convex/loans.ts), [convex/users.ts](convex/users.ts) | Domain queries and mutations |
| [convex/automation.ts](convex/automation.ts) | Outbound delivery with retries; idempotent inbound write-backs |
| [convex/http.ts](convex/http.ts) | The only entry point for n8n: HMAC check, body size cap, shape validation, then internal functions |
| [convex/lib/hmac.ts](convex/lib/hmac.ts) | Signing and verification using Web Crypto, shared by both directions |
| [n8n/workflows/](n8n/workflows/) | Exported workflow JSON (3 workflows) |
| [n8n/bootstrap.sh](n8n/bootstrap.sh) | First boot imports the credential and workflows, then publishes them |

## Setup

Prerequisites: Node 20+, Docker, a Clerk account and a Convex account. Both have free tiers. A local Convex backend also works without an account; see the note in step 4.

### 1. Install

```bash
npm install
```

### 2. Clerk

1. Create an application in the Clerk dashboard.
2. Open **Integrations → Convex** and activate it. Copy the **Frontend API URL**; this is the JWT issuer.
3. Open **Configure → Sessions → Customize session token** and add these claims next to the managed `aud`. Without them, Convex sees no name or email, so notifications have no recipient and nobody can be admin:

   ```json
   {
     "aud": "convex",
     "name": "{{user.full_name}}",
     "email": "{{user.primary_email_address}}",
     "email_verified": "{{user.email_verified}}"
   }
   ```

4. Put the publishable key and secret key in `.env.local`. See [.env.example](.env.example).

### 3. Convex

```bash
npx convex dev            # creates the deployment, writes NEXT_PUBLIC_CONVEX_URL to .env.local
npx convex env set CLERK_JWT_ISSUER_DOMAIN https://<your-app>.clerk.accounts.dev
npx convex env set ADMIN_EMAILS you@example.com
npx convex env set LENDLOOP_HMAC_SECRET "$(openssl rand -hex 32)"
```

Keep `npx convex dev` running in its own terminal.

### 4. n8n and Mailpit (Docker Compose)

Copy `.env.example` to `.env` and fill in the Compose section:

```bash
LENDLOOP_HMAC_SECRET=<same value you set in Convex>
N8N_ENCRYPTION_KEY=<openssl rand -hex 32>
CONVEX_SITE_URL=https://<deployment>.convex.site
```

Then start the stack:

```bash
docker compose up -d                     # n8n on :5678, Mailpit inbox on :8025
```

On first boot, [n8n/bootstrap.sh](n8n/bootstrap.sh) imports the SMTP credential and the three workflows, then publishes them. Open http://localhost:5678 to create the n8n owner account.

Convex needs a URL for the n8n webhook:

- **Convex cloud** cannot reach `localhost`. Expose n8n with the bundled tunnel:

  ```bash
  docker compose --profile tunnel up -d
  docker compose logs tunnel | grep trycloudflare
  # Set N8N_PUBLIC_URL=<that url>/ in .env, then: docker compose up -d n8n
  npx convex env set N8N_LOAN_EVENT_WEBHOOK_URL https://<that-url>/webhook/lendloop-loan-event
  ```

- **Local Convex backend.** Use `npx convex dev` with a local deployment. Set `CONVEX_SITE_URL=http://host.docker.internal:3211` in `.env`, then run:

  ```bash
  npx convex env set N8N_LOAN_EVENT_WEBHOOK_URL http://localhost:5678/webhook/lendloop-loan-event
  ```

If `N8N_LOAN_EVENT_WEBHOOK_URL` is not set, the app still works. Events are recorded as `skipped`.

### 5. Run the app

```bash
npm run dev                              # http://localhost:3000
npx convex run seed:demo                 # optional: demo users, tools, a pending request and an overdue loan
```

To run the app in Docker as well, use `docker compose --profile app up -d --build`. The build reads `NEXT_PUBLIC_*` from `.env`.

### Trying the automations

| Automation | How to trigger it | Where to look |
|---|---|---|
| Notification | Request a tool as one user, approve it as another | Mailpit at http://localhost:8025. The loan card's activity moves from *delivered* to *sent* |
| Overdue reminder | `npx convex run seed:demo` creates an overdue loan. In n8n, open *Daily overdue reminder* and click **Execute workflow** | Mailpit, plus the activity on the loan |
| Error handler | Stop Convex, or set a wrong `LENDLOOP_HMAC_SECRET` in n8n, then trigger either workflow | Admin page, **Automation problems** panel |

## Environment variables

| Variable | Where | Purpose |
|---|---|---|
| `NEXT_PUBLIC_CONVEX_URL` | `.env.local` | Convex client URL. Written by `npx convex dev` |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY` | `.env.local` | Clerk |
| `CLERK_JWT_ISSUER_DOMAIN` | Convex env | Issuer that Convex trusts for Clerk JWTs |
| `ADMIN_EMAILS` | Convex env | Comma-separated list. Grants admin only to a **verified** email in the Clerk token. Re-evaluated at every sign-in, so removing an address revokes access |
| `LENDLOOP_HMAC_SECRET` | Convex env **and** Compose `.env` | Shared HMAC key. Generate it with `openssl rand -hex 32` |
| `N8N_LOAN_EVENT_WEBHOOK_URL` | Convex env | Public URL of workflow ① |
| `N8N_ENCRYPTION_KEY` | Compose `.env` | Encrypts n8n credentials at rest. Do not change it after the first boot |
| `CONVEX_SITE_URL` | Compose `.env` | Where n8n calls Convex HTTP actions (`*.convex.site`) |
| `N8N_PUBLIC_URL` | Compose `.env` | Base URL n8n uses for webhooks (the tunnel URL when Convex runs in the cloud) |
| `LENDLOOP_MAIL_FROM` | Compose `.env` | Sender address |

No secret is committed. `.env*` is git-ignored except `.env.example`. The SMTP credential in [n8n/credentials/](n8n/credentials/) points at the local Mailpit and contains no password. For real SMTP, replace it in the n8n UI; n8n stores it encrypted with `N8N_ENCRYPTION_KEY`.

## Security decisions

**Authorization lives in Convex.** Every public query and mutation calls `requireUser` or `requireAdmin` ([access.ts](convex/lib/access.ts)) and checks ownership against the record:

- Approving requires `loan.lenderId === me`.
- Cancelling requires `loan.borrowerId === me`.
- Editing a tool requires `tool.ownerId === me`.
- Removing someone else's listing requires the admin role.

The Next.js page guard ([app/dashboard/layout.tsx](app/dashboard/layout.tsx)) is only for UX. The tests call the functions directly as other users to prove this; see [convex/lendloop.test.ts](convex/lendloop.test.ts).

**Errors do not reveal whether a record exists.** "Not found" and "not yours" return the same message, so ids cannot be probed.

**The state machine is server-side and closed.** Transitions not listed in `TRANSITIONS` are rejected, whatever the UI sends.

**Admin role from configuration, not from user input.** It comes from `ADMIN_EMAILS` and requires an `email_verified` claim that is exactly `true`, so nobody can promote themselves by signing up with an admin's address. Every admin call checks the list again, so removing an address revokes access immediately, without waiting for a new sign-in.

**Signed webhooks in both directions** ([hmac.ts](convex/lib/hmac.ts)):

- The signature is HMAC-SHA256 over `${timestamp}.${scope}.${rawBody}`, sent in `X-LendLoop-Signature: sha256=<hex>`.
- `scope` binds the signature to one endpoint (`POST /n8n/overdue-reminders`), so a captured signature cannot be replayed against another.
- Timestamps outside ±5 minutes are rejected, which limits replay.
- Comparison is constant-time.
- n8n verifies the **raw bytes** of the body (webhook `rawBody` option), not re-serialized JSON.
- Both sides fail closed: no secret means every request is rejected.

**A small inbound attack surface.**

- n8n can reach only four HTTP routes.
- They call `internal*` functions, which the browser client cannot call.
- Bodies are capped at 16 KB and every field is validated before use.
- The webhook answers a forged request with `401` before running any other node.

**Least privilege in n8n.**

- Code nodes may load only the `crypto` built-in.
- Execution history is pruned after 7 days.
- Diagnostics and telemetry are off.

**Next.js hardening.** Security headers are set (`X-Frame-Options`, `nosniff`, `Referrer-Policy`, `Permissions-Policy`), the `x-powered-by` header is off, and the runtime container is non-root.

## Data minimization

- **Users table:** Clerk display name, email (needed for notifications), role and the trusted flag. No phone number, address or avatar is stored.
- **Public page:** tool `name` and `category` only. There is no owner and no description. A test asserts the exact keys.
- **Signed-in views:** neighbors see each other's **first name** only. Emails are never sent to the browser for other users.
- **Webhook payloads:** only the **recipient's** name and email are included. The counterpart appears by first name only. The overdue endpoint returns the borrower's email and the lender's first name, not the lender's email.
- **Error reports:** n8n sends Convex the workflow name, node and error message only, never the failed run's input data.
- **Soft deletes:** removed listings keep the loan history intact for auditability without staying visible.
- **Retention:** n8n prunes executions after 7 days, because they contain email addresses.

## Integration and error handling

**Outbox in the same transaction.** A status change and its `automationEvents` row commit together, and the delivery is scheduled from the same mutation. If the mutation commits, the notification will be attempted. If it fails, nothing is sent.

**Convex → n8n retries.** A failed delivery is retried 5 times with exponential backoff from 30 s (`deliverNotification`), with a 10 s timeout per call. The status goes `pending → retrying → delivered`, or `failed` after the last attempt. Both are visible on the loan card and in the admin panel.

**n8n → Convex retries.** HTTP Request nodes retry 4 times, every 5 s. Email nodes retry 3 times. A failed email goes to the node's error output, so it is written back as `failed` instead of being lost.

**Idempotency.**

- Write-backs are keyed: `notify:<eventId>` and `overdue:<loanId>:<day>`.
- A replay with the same status is a no-op.
- `sent` can upgrade an earlier `failed` (a retry that worked); `failed` never downgrades `sent`.
- The overdue list leaves out loans already reminded today, so a re-run of the workflow on the same day sends nothing.
- On the n8n side, workflow ① remembers the last 500 event ids, so a Convex retry after a lost `202` does not send a second email.

**Visible failures.** Workflows ① and ② use ③ as their `errorWorkflow`. ③ reports to `/n8n/workflow-errors` (idempotent per execution id), and the report appears in the admin panel.

### Verified locally

With a local Convex backend, n8n 2.47.7 and Mailpit:

- A signed event returned `202` and the email reached Mailpit. A forged or unsigned event returned `401`.
- A real notification went Convex → n8n → email → write-back and ended as `sent`.
- The overdue workflow ran twice. It produced one email and one `overdue_reminder` row.
- A failing write-back triggered the error workflow, and a `workflow_error` row appeared in Convex.
- With n8n stopped, a notification went to `retrying`. After n8n restarted it was delivered on attempt 2 and ended as `sent`.

## Tests

```bash
npm test          # vitest: 26 tests
npm run typecheck
npm run lint
```

- **[convex/lib/rules.test.ts](convex/lib/rules.test.ts):** state machine, date rules, and HMAC (tampering, endpoint swap, wrong secret, replay window, missing secret).
- **[convex/lendloop.test.ts](convex/lendloop.test.ts):** uses `convex-test` to run the real functions against an in-memory backend.
  - Anonymous access is rejected.
  - The public payload has the exact expected keys.
  - Users cannot touch other users' tools or loans.
  - Admin functions are gated.
  - Overlapping requests are auto-declined, and expired requests cannot be approved.
  - Notifications carry the loan state from when the event happened, even if it is retried later.
  - A `failed` result from n8n is never overwritten by a late `delivered`.
  - Signed HTTP endpoints reject forged calls and stay idempotent on replay.

## What I would change for production

1. **Secrets and rotation.** Keep the HMAC key in a secrets manager. Support two active keys (`kid` header) so the key can be rotated without downtime, and use a separate key per direction.
2. **Durable workflow state.** Replace n8n workflow static data for dedupe with a lookup to Convex, or Redis. Run n8n in queue mode with Postgres, external task runners and S3 binary storage instead of SQLite.
3. **Delivery guarantees.** Move retries to a Convex component such as Workpool, and add a dead-letter view with a manual "retry" button for admins.
4. **Real email.** Use a transactional provider such as Postmark or SES with SPF, DKIM and DMARC, plus unsubscribe and notification preferences per user. Keep templates outside the workflow.
5. **Roles in Clerk.** Move the admin role to Clerk organization roles or `publicMetadata`, with an audit log of admin actions (trust changes, removals).
6. **Abuse limits.** Rate-limit request creation per user (`@convex-dev/rate-limiter`), cap open requests, and add CAPTCHA on sign-up.
7. **Time zones.** Store each neighborhood's time zone and compute "overdue" in local time instead of UTC.
8. **Observability.** Send structured logs to a log drain, alert when `failed` events or `workflow_error` counts rise, and add an uptime check on the n8n webhook.
9. **Privacy operations.** Add a retention job for closed loans and automation events, account deletion that anonymizes loan history, and a data processing agreement with every processor (Clerk, Convex, the email provider).
10. **CI.** Run typecheck, lint, tests and `next build` on every PR, validate the n8n workflow JSON, and use preview deployments with a separate Convex deployment for each preview.
