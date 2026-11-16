// Convex validates Clerk-issued JWTs against this issuer. Set
// CLERK_JWT_ISSUER_DOMAIN in the Convex dashboard (or `npx convex env set`).
const authConfig = {
  providers: [
    {
      domain: process.env.CLERK_JWT_ISSUER_DOMAIN!,
      applicationID: "convex",
    },
  ],
};

export default authConfig;
