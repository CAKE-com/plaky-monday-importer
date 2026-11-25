import type { Metadata } from "next";
import { Suspense } from "react";
import { Exports } from "@/components/sheet/tools";

export const metadata: Metadata = { title: "Checks and exports" };

export default function Page({ params }: { params: Promise<{ id: string }> }) {
  return (
    <Suspense fallback={<p className="text-sm text-cake-muted">Loading…</p>}>
      <Exports params={params} />
    </Suspense>
  );
}
