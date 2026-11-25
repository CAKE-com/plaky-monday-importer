import type { Metadata } from "next";
import { Sheet } from "@/components/sheet/bits";
import { ConnectOpen } from "@/components/sheet/connect-section";

export const metadata: Metadata = { title: { absolute: "Connect accounts · Monday to Plaky Migrator" } };

export default function Home() {
  return (
    <Sheet>
      <ConnectOpen />
    </Sheet>
  );
}
