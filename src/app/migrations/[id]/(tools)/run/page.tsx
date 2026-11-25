import type { Metadata } from "next";
import { Suspense } from "react";
import { LiveLog } from "@/components/sheet/tools";

export const metadata: Metadata = { title: "Run log and undo" };

export default function Page({ params }: { params: Promise<{ id: string }> }) {
  return (
    <Suspense fallback={<p className="text-sm text-cake-muted">Loading…</p>}>
      <LiveLog params={params} />
    </Suspense>
  );
}
