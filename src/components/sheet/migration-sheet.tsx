"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useCallback } from "react";
import { useTRPC } from "@/lib/trpc";
import { Details, Note, Plain, Problem, Section, Sheet, useMigrationId } from "./bits";
import { BoardsSection, setUpBoards } from "./boards-section";
import { ConnectClosed } from "./connect-section";
import { MoveSection } from "./move-section";
import { Departure } from "./departure";
import { useQueryChange } from "./subscriptions";

export const TOOLS: [slug: string, label: string][] = [
  ["runs", "Run history"], ["run", "Run log and undo"], ["verify", "Checks and exports"], ["plan", "Plan and options"], ["link", "Field pairing"], ["filter", "Which items move"],
  ["erase", "Erase this migration’s data"],
];

const runBusy = (state: { data: { active: boolean; waiting: unknown } | undefined } | undefined): boolean => Boolean(state?.data?.active || state?.data?.waiting);
const readTime = (state: { dataUpdatedAt: number } | undefined): number => state?.dataUpdatedAt ?? 0;

export function MigrationSheet({ params }: { params: Promise<{ id: string }> }) {
  const migrationId = useMigrationId(params);
  const trpc = useTRPC();
  const status = useQuery({ ...trpc.run.status.queryOptions({ migrationId }), staleTime: 5_000 });
  const manifest = useQuery({ ...trpc.discovery.manifest.queryOptions({ migrationId }), staleTime: 5_000 });
  const busy = Boolean(status.data?.active || status.data?.waiting);
  const latest = useQuery({ ...trpc.plan.latest.queryOptions({ migrationId }), refetchInterval: busy ? 30_000 : false, refetchOnWindowFocus: true, staleTime: 5_000 });
  const { refetch: refetchLatest } = latest;
  const refetchWhenIdle = useCallback((nowBusy: boolean, wasBusy: boolean | undefined): void => { if (wasBusy && !nowBusy) void refetchLatest(); }, [refetchLatest]);
  useQueryChange(trpc.run.status.queryKey({ migrationId }), runBusy, refetchWhenIdle);
  const refetchAfterRead = useCallback((readAt: number, before: number | undefined): void => { if (before !== undefined && before !== 0) void refetchLatest(); }, [refetchLatest]);
  useQueryChange(trpc.discovery.manifest.queryKey({ migrationId }), readTime, refetchAfterRead);
  const linked = (status.data?.boards.length ?? 0) > 0;
  const moving = setUpBoards(manifest.data?.manifest?.boards ?? [], linked);
  const items = moving.reduce((n, b) => n + b.items, 0);
  return (
    <Sheet migrationId={migrationId}
      aside={manifest.data?.manifest ? <details id={`migration-${migrationId}-details`} className="support-details scroll-mt-6 rounded-lg border border-cake-line bg-white p-4"><summary className="cursor-pointer font-medium">Conversions and exclusions</summary><div className="mt-4"><Departure migrationId={migrationId} mode="preflight" /></div></details> : null}
      footer={
        <>
          <Details title="Connection details"><span data-testid="monday-calls">{latest.data ? `monday calls recorded today: ${latest.data.mondayCallsToday.toLocaleString("en")} of ${latest.data.mondayLimit.calls.toLocaleString("en")} (monday's ${latest.data.mondayLimit.plan} plan). Resets at 00:00 UTC.` : latest.error ? "Today’s monday calls could not be read." : ""}</span>
          {latest.data?.mondayLimit.reason ? <span data-testid="monday-limit-reason">{latest.data.mondayLimit.reason}</span> : null}
          </Details>
          <details className="support-details rounded-md border border-cake-line bg-white p-4 print:hidden">
            <summary className="cursor-pointer font-medium">Advanced tools</summary>
            <ul className="mt-2 flex flex-col gap-1">
              {TOOLS.map(([slug, label]) => <li key={slug}><Link prefetch={false} href={`/migrations/${migrationId}/${slug}`}>{label}</Link></li>)}
              <li><Link prefetch={false} href="/">All migrations</Link></li>
            </ul>
          </details>
        </>
      }
    >
      <ConnectClosed migrationId={migrationId} />
      <Problem error={status.error} title="Could not read this migration" />
      <Problem error={manifest.error} title="Could not read the boards" />
      {status.data === undefined ? (
        status.isError ? <div className="py-4"><Plain onClick={() => void status.refetch()} disabled={status.isFetching}>{status.isFetching ? "Reading…" : "Try again"}</Plain></div> : <Note className="py-8">Reading…</Note>
      ) : (
        <>
          <BoardsSection key={`boards-${migrationId}`} migrationId={migrationId} linked={linked} onLinked={() => { void status.refetch(); void manifest.refetch(); }} />
          <MoveSection key={`move-${migrationId}`} migrationId={migrationId} linked={linked} items={items} boardItems={moving.map((b) => b.items)}
            manifest={manifest.data?.manifest ?? null} plan={latest.data?.summary ?? null} />
          <Section migrationId={migrationId} n={4} title="Save your archive" state={manifest.data?.manifest ? "open" : "later"} summary={manifest.data?.manifest ? "Optional" : "Optional. Available after reading your boards"}>
            <Departure key={`departure-${migrationId}`} migrationId={migrationId} mode="archive" />
          </Section>
        </>
      )}
    </Sheet>
  );
}
