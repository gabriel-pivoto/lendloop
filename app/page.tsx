"use client";

import { SignInButton } from "@clerk/nextjs";
import { Authenticated, AuthLoading, Unauthenticated, useQuery } from "convex/react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { api } from "@/convex/_generated/api";
import { Badge, Button, CategoryFilter, Empty, Loading } from "@/components/ui";

export default function Home() {
  const tools = useQuery(api.tools.publicList);
  const [category, setCategory] = useState("");
  const categories = useMemo(
    () => [...new Set((tools ?? []).map((t) => t.category))].sort(),
    [tools],
  );
  const visible = (tools ?? []).filter((t) => !category || t.category === category);

  return (
    <main className="mx-auto max-w-4xl px-4 py-12">
      <header className="flex items-center justify-between">
        <span className="text-lg font-semibold tracking-tight">LendLoop</span>
        <div>
          <AuthLoading>
            <span className="text-sm text-stone-500">…</span>
          </AuthLoading>
          <Unauthenticated>
            <SignInButton mode="modal" forceRedirectUrl="/dashboard">
              <Button>Sign in</Button>
            </SignInButton>
          </Unauthenticated>
          <Authenticated>
            <Link href="/dashboard">
              <Button>Open dashboard</Button>
            </Link>
          </Authenticated>
        </div>
      </header>

      <section className="mt-16 max-w-2xl">
        <h1 className="text-4xl font-semibold tracking-tight sm:text-5xl">
          Borrow the drill. Skip the store.
        </h1>
        <p className="mt-4 text-lg text-stone-600">
          LendLoop lets neighbors lend tools to each other for a few days at a time. List what sits
          in your garage, request what you need, and keep track of who has what.
        </p>
      </section>

      <section className="mt-14">
        <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
          <h2 className="text-lg font-semibold">Available in the neighborhood</h2>
          {tools && <span className="text-sm text-stone-500">{tools.length} tools listed</span>}
        </div>
        {categories.length > 1 && (
          <div className="mb-4">
            <CategoryFilter categories={categories} value={category} onChange={setCategory} />
          </div>
        )}
        {tools === undefined ? (
          <Loading />
        ) : visible.length === 0 ? (
          <Empty>No tools listed yet. Sign in and be the first.</Empty>
        ) : (
          <ul className="grid gap-2 sm:grid-cols-2">
            {visible.map((t) => (
              <li
                key={t._id}
                className="flex items-center justify-between rounded-md bg-white px-4 py-3 ring-1 ring-stone-200"
              >
                <span className="font-medium">{t.name}</span>
                <Badge>{t.category}</Badge>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-4 text-xs text-stone-500">
          Owners and availability are only shown to signed-in neighbors.
        </p>
      </section>
    </main>
  );
}
