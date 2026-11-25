"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useTRPC } from "@/lib/trpc";
import { Note, Problem } from "./bits";

export function NeedsLink({ migrationId, children }: { migrationId: number; children: React.ReactNode }) {
  const trpc = useTRPC();
  const status = useQuery({ ...trpc.run.status.queryOptions({ migrationId }), staleTime: 5_000 });
  if (status.error) return <Problem error={status.error} title="Could not read this migration" />;
  if (!status.data) return <Note>Reading…</Note>;
  if (status.data.boards.length === 0) {
    return (
      <div data-testid="link-first"><Note>
        Link boards first. <Link prefetch={false} href={`/migrations/${migrationId}#migration-${migrationId}-s2`}>Go to Set up boards</Link>, then come back here.
      </Note></div>
    );
  }
  return <>{children}</>;
}
