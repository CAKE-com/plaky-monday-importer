"use client";

import Link from "next/link";
import { buttonClass, Go, Problem, Sheet } from "./bits";

export function Crash({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const shown = error.digest
    ? { message: "The page could not be built on this app's server. Its log has the details under this digest.", data: { httpStatus: 500, technical: `digest ${error.digest}` } }
    : error;
  return (
    <Sheet workflow={false}>
      <section className="mb-4 flex flex-col gap-4 rounded border border-cake-line bg-white p-6" data-testid="crash">
        <h1 className="text-xl font-medium">This page hit an error it could not recover from</h1>
        <p>Nothing was changed in monday or Plaky by it. Try again; if it happens again, go back to the list of migrations.</p>
        <Problem error={shown} title="What happened" />
        <div className="flex flex-wrap items-center gap-4">
          <Go onClick={reset}>Try again</Go>
          <Link prefetch={false} href="/" className={buttonClass.secondary}>All migrations</Link>
        </div>
      </section>
    </Sheet>
  );
}
