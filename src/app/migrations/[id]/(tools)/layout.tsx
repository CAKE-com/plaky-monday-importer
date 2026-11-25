import { Suspense } from "react";
import { Sheet } from "@/components/sheet/bits";
import { ToolsNav } from "@/components/sheet/tools";

export default function ToolsLayout({ children, params }: { children: React.ReactNode; params: Promise<{ id: string }> }) {
  return (
    <Sheet workflow={false}>
      <Suspense fallback={<p className="text-sm text-cake-muted">Loading…</p>}>
        <ToolsNav params={params} />
        <div className="flex flex-col gap-6 rounded border border-cake-line bg-white p-6 [&>:first-child]:border-t-0 [&>:first-child]:pt-0">{children}</div>
      </Suspense>
    </Sheet>
  );
}
