import type { Metadata } from "next";
import { Suspense } from "react";
import { ItemScope } from "@/components/sheet/item-scope";

export const metadata: Metadata = { title: "Which items move" };

export default function Page({ params }: { params: Promise<{ id: string }> }) {
  return (
    <Suspense fallback={<p className="text-sm text-cake-muted">Loading…</p>}>
      <ItemScope params={params} />
    </Suspense>
  );
}
