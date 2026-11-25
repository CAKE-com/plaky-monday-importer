"use client";

import { Crash } from "@/components/sheet/crash";
import "./globals.css";

export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="en">
      <body className="flex min-h-full flex-col">
        <Crash error={error} reset={reset} />
      </body>
    </html>
  );
}
