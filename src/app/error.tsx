"use client";

import { Crash } from "@/components/sheet/crash";

export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <Crash error={error} reset={reset} />;
}
