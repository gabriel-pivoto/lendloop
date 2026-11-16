import { defineApp } from "convex/server";
import { v } from "convex/values";

// Typed deployment environment, read through `env` from ./_generated/server.
// Everything is optional so a fresh deployment can push before automation is
// configured; code that needs a value checks for it and fails closed.
const app = defineApp({
  env: {
    ADMIN_EMAILS: v.optional(v.string()),
    LENDLOOP_HMAC_SECRET: v.optional(v.string()),
    N8N_LOAN_EVENT_WEBHOOK_URL: v.optional(v.string()),
  },
});

export default app;
