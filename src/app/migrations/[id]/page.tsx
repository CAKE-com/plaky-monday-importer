import type { Metadata } from "next";
import { Suspense } from "react";
import { MigrationSheet } from "@/components/sheet/migration-sheet";

export const metadata: Metadata = { title: "Migration" };

export default function Page({ params }: { params: Promise<{ id: string }> }) {
  return (
    <Suspense fallback={<p className="p-8 text-sm text-cake-muted">Loading…</p>}>
      <MigrationSheet params={params} />
    </Suspense>
  );
}
