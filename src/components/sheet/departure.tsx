"use client";

import { useCallback, useState } from "react";
import { useIsMutating, useMutation, useQuery } from "@tanstack/react-query";
import { useTRPC } from "@/lib/trpc";
import { departurePreflight, DEPARTURE_LABELS, receiptStaleness, type DepartureCategory } from "@/lib/departure";
import { Said } from "@/lib/explain";
import { departureDownload } from "@/lib/departure-download";
import { archiveReadiness, ArchiveRequest, isArchiveCancelled } from "@/lib/departure-state";
import { Block, Details, Go, Note, Plain, Problem, statusRefetchMs } from "./bits";
import { useQueryChange } from "./subscriptions";

const categories: DepartureCategory[] = ["preserved", "converted", "manual", "unavailable"];
const verificationText = {
  not_checked: "Not checked yet.",
  needs_attention: "Differences found. Review the results.",
  out_of_date: "Run Check now after the final move.",
  matched: "Selected content matched. Review exclusions separately.",
};

type Mode = "full" | "preflight" | "archive";

const runMark = (state: { data: { run: { id: number; finishedAt: number | null } | null } | undefined } | undefined): string | null =>
  state?.data?.run ? `${state.data.run.id}:${state.data.run.finishedAt ?? ""}` : null;

export function Departure({ migrationId, mode = "full" }: { migrationId: number; mode?: Mode }) {
  return <DepartureBlock key={migrationId} migrationId={migrationId} mode={mode} />;
}

function DepartureBlock({ migrationId, mode }: { migrationId: number; mode: Mode }) {
  const trpc = useTRPC();
  const discovered = useQuery(trpc.discovery.manifest.queryOptions({ migrationId }));
  const planned = useQuery(trpc.plan.latest.queryOptions({ migrationId }));
  const verification = useQuery({ ...trpc.verify.summary.queryOptions({ migrationId }), refetchOnWindowFocus: true });
  const status = useQuery({ ...trpc.run.status.queryOptions({ migrationId }), refetchInterval: (q) => statusRefetchMs(q.state.data) });
  const operating = useIsMutating({ predicate: (mutation) => {
    const input = mutation.state.variables;
    return input !== null && typeof input === "object" && "migrationId" in input && input.migrationId === migrationId;
  } }) > 0;
  const [request] = useState(() => new ArchiveRequest(migrationId));
  const cancelOnLeave = useCallback(() => () => request.cancel(), [request]);
  const { refetch: refreshVerification } = verification;
  const refreshAfterRun = useCallback((run: string | null): void => { if (run !== null) void refreshVerification(); }, [refreshVerification]);
  useQueryChange(trpc.run.status.queryKey({ migrationId }), runMark, refreshAfterRun);
  const build = useMutation({ mutationFn: () => request.run(async (signal) => {
    const response = await fetch(`/api/departure/${request.migrationId}`, { method: "POST", signal });
    const body: unknown = await response.json();
    if (!response.ok) throw new Said(body && typeof body === "object" && "error" in body && typeof body.error === "string" ? body.error : "The archive could not be created. Try again while monday is available.");
    return departureDownload.parse(body);
  }) });
  const v = verification.data;
  const preflight = departurePreflight({
    manifest: discovered.data?.manifest ?? null, plan: planned.data?.summary ?? null, options: discovered.data?.options ?? {},
    receipt: v?.receipt ?? null,
    ...receiptStaleness(v, status.data?.active === true),
  });
  const pending = discovered.isPending || planned.isPending || verification.isPending || status.isPending;
  const error = discovered.error || planned.error || verification.error || status.error;
  const readiness = archiveReadiness({ boards: discovered.data?.manifest?.boards.length ?? 0,
    loading: pending, error: !!error, operating, active: status.data?.active === true,
    waiting: !!status.data?.waiting, scheduled: !!status.data?.schedule });
  return <Block className={mode === "full" ? "" : "border-0 pt-0"} title={mode === "preflight" ? "What moves to Plaky" : mode === "archive" ? "Departure archive" : "Before you leave monday"} testId={mode === "full" ? "departure" : `departure-${mode}`}>
    <Problem error={error} title="Could not refresh; details may be out of date" />
    {mode !== "archive" ? <>
      {pending ? <Note>Checking migration details…</Note> : <>
        <p role="status" className="rounded-md bg-cake-grey-50 p-3 text-sm">{verificationText[preflight.verification]}</p>
        {!planned.data?.summary ? <Note>Details appear after planning.</Note> : null}
        <div className={mode === "preflight" ? "flex flex-col gap-2" : "grid gap-3 sm:grid-cols-2"}>
          {categories.map((category) => {
            const entries = preflight.entries.filter((e) => e.category === category);
            return <details key={category} className="support-details rounded-md border border-cake-line" data-category={category}>
              <summary className="cursor-pointer px-3 py-3 text-sm font-medium">{DEPARTURE_LABELS[category]} · {entries.length}</summary>
              <ul className="flex list-disc flex-col gap-3 border-t border-cake-line px-4 py-3 pl-7 text-sm">{entries.length ? entries.map((e, i) => <li key={i}><strong>{e.subject}</strong>: {e.detail}</li>) : <li>None confirmed.</li>}</ul>
            </details>;
          })}
        </div>
        <Details title="Archive scope"><p>{preflight.scope}</p></Details>
      </>}
    </> : null}
    {mode !== "preflight" ? <div ref={cancelOnLeave} className={mode === "full" ? "border-t border-cake-line pt-4" : ""}>
      {mode === "full" ? <h3 className="font-medium">Departure archive</h3> : null}
      <ol className="my-4 flex list-decimal flex-col gap-2 pl-5 text-sm">
        <li>Stop edits in monday. Move final changes and run <strong>Check now</strong>.</li>
        <li>Download and extract the ZIP. Open <strong>START-HERE.html</strong>, check files and gaps, and keep two copies.</li>
      </ol>
      <Details title="What the archive includes">
        <p>Selected boards’ readable items, fields, comments and files up to 100 MB each, including filtered and readable archived items.</p>
        <p>It also lists the account’s other boards by name and ID (account-inventory.json), not their content.</p>
        <p>Keep the app running until downloaded. Other boards, unreadable content and external links need separate copies.</p>
      </Details>
      {readiness === "operating" ? <p role="status" className="mt-3 text-sm">Wait for the current operation.</p> : readiness === "running" || readiness === "waiting" || readiness === "scheduled" ? <p className="mt-3 text-sm">Finish the run and cancel pending schedules first.</p> : null}
      <div className="mt-4 flex flex-wrap items-center gap-3 print:hidden">
        <Go disabled={readiness !== "ready" || build.isPending} onClick={() => build.mutate()}>{build.isPending ? "Building departure archive…" : "Create departure archive"}</Go>
        {build.isPending ? <Plain onClick={() => request.cancel()}>Cancel archive</Plain> : null}
      </div>
      {isArchiveCancelled(build.error) ? <Note className="mt-3">Archive cancelled.</Note> : <Problem error={build.error} title="Departure archive not created" />}
      {build.isSuccess ? <div className="mt-4 rounded-md border border-cake-brand-100 bg-cake-brand-50 p-4" role="status">
        <p className="text-sm">{build.data.status === "incomplete" ? `Incomplete: ${build.data.failures} read(s) failed. Keep monday access and resolve the gaps.` : "Archive ready. Check files and gaps before leaving monday."} {build.data.boards} board(s), {build.data.attachments} file(s).</p>
        <a className="mt-3 inline-block font-medium text-cake-brand-550 underline print:hidden" href={build.data.url} download>Download departure archive (ZIP)</a>
        <Note>Link expires in 30 minutes. Recreate after source edits.</Note>
      </div> : null}
    </div> : null}
  </Block>;
}
