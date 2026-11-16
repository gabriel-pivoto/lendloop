import { clerkMiddleware } from "@clerk/nextjs/server";

// Makes the Clerk session available to server components. Route protection
// happens in app/dashboard/layout.tsx, and data protection in Convex.
export default clerkMiddleware();

export const config = {
  matcher: [
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
  ],
};
