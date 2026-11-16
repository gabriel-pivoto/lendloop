"use client";

import { UserButton } from "@clerk/nextjs";
import {
  Authenticated,
  AuthLoading,
  Unauthenticated,
  useConvexAuth,
  useMutation,
  useQuery,
} from "convex/react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { api } from "@/convex/_generated/api";
import { Badge, ErrorText, Loading, errorMessage } from "@/components/ui";

/** Makes sure the Clerk user has a row in Convex before any page queries run. */
function EnsureUser({ children }: { children: ReactNode }) {
  const { isAuthenticated } = useConvexAuth();
  const store = useMutation(api.users.store);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isAuthenticated) return;
    let cancelled = false;
    store()
      .then(() => !cancelled && setReady(true))
      .catch((err) => !cancelled && setError(errorMessage(err)));
    return () => {
      cancelled = true;
    };
  }, [isAuthenticated, store]);

  if (error) return <ErrorText>{error}</ErrorText>;
  if (!ready) return <Loading />;
  return <>{children}</>;
}

function Nav() {
  const me = useQuery(api.users.me);
  const pathname = usePathname();
  const links = [
    { href: "/dashboard", label: "Browse" },
    { href: "/dashboard/listings", label: "My listings" },
    { href: "/dashboard/requests", label: "My requests" },
    { href: "/dashboard/incoming", label: "Incoming requests" },
    ...(me?.role === "admin" ? [{ href: "/dashboard/admin", label: "Admin" }] : []),
  ];
  return (
    <nav className="flex flex-wrap gap-1" aria-label="Dashboard">
      {links.map((l) => (
        <Link
          key={l.href}
          href={l.href}
          aria-current={pathname === l.href ? "page" : undefined}
          className={`rounded-md px-3 py-1.5 text-sm font-medium ${
            pathname === l.href ? "bg-stone-900 text-white" : "text-stone-700 hover:bg-stone-200"
          }`}
        >
          {l.label}
        </Link>
      ))}
      {me?.trustedLender && (
        <span className="self-center pl-2">
          <Badge tone="green">Trusted Lender</Badge>
        </span>
      )}
    </nav>
  );
}

export function DashboardShell({ children }: { children: ReactNode }) {
  return (
    <div className="mx-auto max-w-5xl px-4 py-6">
      <header className="mb-6 flex items-center justify-between">
        <Link href="/" className="text-lg font-semibold tracking-tight">
          LendLoop
        </Link>
        <UserButton />
      </header>
      <AuthLoading>
        <Loading />
      </AuthLoading>
      <Unauthenticated>
        {/* Clerk let the user in (the page guard passed) but Convex rejected
            the token: usually a missing `aud: convex` claim or a wrong
            CLERK_JWT_ISSUER_DOMAIN. Say so instead of rendering nothing. */}
        <ErrorText>
          You are signed in, but the backend could not verify your session. Try signing out and in
          again. If it keeps happening, check the Clerk to Convex setup in the README.
        </ErrorText>
      </Unauthenticated>
      <Authenticated>
        <EnsureUser>
          <div className="mb-6">
            <Nav />
          </div>
          {children}
        </EnsureUser>
      </Authenticated>
    </div>
  );
}
