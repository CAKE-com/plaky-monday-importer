import type { Metadata } from "next";
import Link from "next/link";
import { buttonClass, Sheet } from "@/components/sheet/bits";

export const metadata: Metadata = { title: "Not found" };

export default function NotFound() {
  return (
    <Sheet workflow={false}>
      <section className="mb-4 flex flex-col gap-4 rounded border border-cake-line bg-white p-6" data-testid="not-found">
        <h1 className="text-xl font-medium">There is nothing at this address</h1>
        <p>The migration may have been erased, or the address was typed or copied wrongly.</p>
        <div><Link prefetch={false} href="/" className={buttonClass.cta}>All migrations</Link></div>
      </section>
    </Sheet>
  );
}
