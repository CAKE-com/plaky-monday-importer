import type { Metadata } from "next";
import { Suspense } from "react";
import { EraseMigration } from "@/components/sheet/tools";

export const metadata: Metadata = { title: "Erase migration data" };

export default function Page({ params }: { params: Promise<{ id: string }> }) {
  return (
    <Suspense fallback={<p className="text-sm text-cake-muted">Loading…</p>}>
      <EraseMigration params={params} />
    </Suspense>
  );
}
