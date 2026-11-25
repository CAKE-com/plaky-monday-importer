"use client";

import { ScheduleChanges } from "./schedule-changes";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useCallback, useRef, useState } from "react";
import { costSentence, dailyLimit, passesToday, planCalls } from "@/lib/monday-budget";
import { useTRPC, useTRPCClient } from "@/lib/trpc";
import type { ManifestSummary, PlanSummary, ReceiptView } from "@/lib/reports";
import { AUTHORSHIP_NOTE, inactiveLine, isNothingOutside, outsideTheMove, type OutsideTheMove } from "@/lib/outside";
import { receiptEnvelope } from "@/lib/receipt-envelope";
import { AutomaticPlan } from "@/lib/plan-state";
import { moveState } from "@/lib/move-state";
import { resultOffer } from "@/lib/result-offer";
import { Block, Cell, clock, Details, Explain, Go, Grid, Mark, Note, Plain, plural, Problem, Progress, Quiet, Row, Section, Status, statusRefetchMs } from "./bits";
import { useSave } from "./use-save";
import { usePlakyRead } from "./plaky-read";
import { useQueryChange } from "./subscriptions";
import { shortReasons } from "@/lib/short-reasons";
import { PeopleChoices } from "./boards-section";

export const heldSentence = (held: { until: number } | null): string =>
  held ? `Moving before ${clock(held.until)} reuses this read.` : "Move will read monday again.";

export function MoveSection({ migrationId, linked, items, boardItems = [], manifest = null, plan = null }: {
  migrationId: number; linked: boolean; items: number; boardItems?: readonly number[];
  manifest?: ManifestSummary | null; plan?: PlanSummary | null;
}) {
  const trpc = useTRPC();
  const status = useQuery({ ...trpc.run.status.queryOptions({ migrationId }), refetchInterval: (q) => statusRefetchMs(q.state.data), refetchOnWindowFocus: true, staleTime: 5_000 });
  const s = status.data;
  const view = moveState(linked, s);
  if (view.state === "locked") return <Section migrationId={migrationId} n={3} title="Move and check items" state="later" summary="Available after the boards are set up" />;
  if (!s) return <Section migrationId={migrationId} n={3} title="Move and check items" state="open"><Problem error={status.error} title="Could not read the run" />{status.isPending ? <Note>Reading…</Note> : null}</Section>;
  return (
    <Section migrationId={migrationId} n={3} title="Move and check items" state="open">
      <Problem error={status.error} title="Could not refresh; showing the last result" />
      <ViewFocus view={view.state}>
        {view.state === "moving" ? <Moving migrationId={migrationId} status={s} onStopped={() => void status.refetch()} />
          : view.state === "paused" ? <Paused migrationId={migrationId} waiting={view.waiting} deletions={s.deletions} onCancelled={() => void status.refetch()} />
            : view.state === "result" ? <Result migrationId={migrationId} schedule={s.schedule} run={view.run} since={s.since} outside={outsideTheMove(manifest, plan)} onStarted={() => void status.refetch()} />
              : <Ready migrationId={migrationId} items={items} boardItems={boardItems} onStarted={() => void status.refetch()} />}
      </ViewFocus>
    </Section>
  );
}

function ViewFocus({ view, children }: { view: string; children: React.ReactNode }) {
  const shown = useRef(view);
  const focusOnChange = useCallback((box: HTMLDivElement | null): void => {
    if (!box || shown.current === view) return;
    shown.current = view;
    box.focus();
  }, [view]);
  return <div ref={focusOnChange} tabIndex={-1} className="flex flex-col gap-5 outline-none" data-testid="move-view">{children}</div>;
}

type LatestState = { status: string; fetchStatus: string; data: { summary: unknown; latestRun: { at: number; status: string } | null; mondayCallsToday: number; mondayLimit: ReturnType<typeof dailyLimit> } | undefined };
const latestState = <S extends LatestState>(state: S | undefined): S | null => state ?? null;

function Ready({ migrationId, items, boardItems, onStarted }: { migrationId: number; items: number; boardItems: readonly number[]; onStarted: () => void }) {
  const trpc = useTRPC();
  const latest = useQuery({ ...trpc.plan.latest.queryOptions({ migrationId }), staleTime: 5_000 });
  const plan = useMutation(trpc.plan.run.mutationOptions({ onSettled: () => void latest.refetch() }));
  const start = useMutation(trpc.run.start.mutationOptions({ onSuccess: onStarted }));
  const [planning] = useState(() => new AutomaticPlan());
  const { mutate: runPlan } = plan;
  const cost = planCalls(boardItems);
  const limit = latest.data?.mondayLimit ?? dailyLimit(null);
  const overBudget = latest.data !== undefined && passesToday(cost, latest.data.mondayCallsToday, limit);
  const planWhenAdmitted = useCallback((state: LatestState | null): void => {
    if (!state) return;
    const data = state.data;
    const facts = { loaded: state.status === "success", fetching: state.fetchStatus === "fetching", hasSummary: !!data?.summary, latestRun: data?.latestRun ?? null,
      overBudget: data !== undefined && passesToday(cost, data.mondayCallsToday, data.mondayLimit ?? dailyLimit(null)) };
    if (planning.admit(facts)) runPlan({ migrationId });
  }, [planning, cost, runPlan, migrationId]);
  useQueryChange(trpc.plan.latest.queryKey({ migrationId }), latestState, planWhenAdmitted);
  const summary = plan.data ?? latest.data?.summary ?? null;
  const held = plan.data ? plan.data.held : (latest.data?.held ?? null);
  const stale = latest.data?.stale === true;
  if (!summary) {
    return (
      <>
        <p role="status" className="text-sm text-cake-muted">{plan.isPending || latest.isPending ? "Preparing the plan…" : "No plan yet."}</p>
        {overBudget && !plan.isPending ? <p className="flex items-start gap-2" data-testid="plan-cost"><Mark kind="now" /><span>Planning paused: monday’s daily limit. {costSentence(cost, latest.data?.mondayCallsToday ?? null, limit)}</span></p> : null}
        <Problem error={[plan.error, latest.error]} title="Could not plan" />
        {!plan.isPending && !latest.isPending ? <div><Plain onClick={() => runPlan({ migrationId })}>Plan {plan.error || latest.data?.latestRun ? "again" : "now"}</Plain></div> : null}
        <div className="flex flex-wrap items-center gap-5 pt-2">
          <Go onClick={() => start.mutate({ migrationId, mode: "full" })} disabled={start.isPending || plan.isPending}>{start.isPending ? "Starting…" : `Move ${plural(items, "item")}`}</Go>
          <Note>Review the plan first. Repeating a move won’t duplicate items.</Note>
        </div>
        <Problem error={start.error} title="Could not start" />
      </>
    );
  }
  const docExports = summary.boards.reduce((n, b) => n + (b.docExports ?? 0), 0);
  const short = summary.mondayCalls !== undefined && latest.data !== undefined && latest.data.mondayCallsToday + summary.mondayCalls + 2 * docExports > limit.calls;
  const total = summary.boards.reduce((n, b) => ({ creates: n.creates + b.creates, updates: n.updates + b.updates }), { creates: 0, updates: 0 });
  const moving = summary.boards.reduce((n, b) => n + b.creates + b.updates + b.unchanged, 0);
  return (
    <>

      <Note><a href={`#migration-${migrationId}-details`} onClick={() => {
        const details = document.getElementById(`migration-${migrationId}-details`);
        if (details instanceof HTMLDetailsElement) details.open = true;
      }}>Review conversions and exclusions</a> before moving.</Note>
      <Grid head={["Board", "New items", "Updated items"]} align={["left", "right", "right"]} testId="plan">
        {summary.boards.map((b) => <Row key={b.mondayBoardId}><Cell>{b.name}</Cell><Cell right>{b.creates}</Cell><Cell right>{b.updates}</Cell></Row>)}
        <Row><Cell><strong>Total</strong></Cell><Cell right><strong>{total.creates}</strong></Cell><Cell right><strong>{total.updates}</strong></Cell></Row>
      </Grid>
      {docExports ? <Note>{plural(docExports, "monday doc")} will be saved as Markdown (.md).</Note> : null}
      {summary.failures.map((f, i) => <div key={`${i}:${f}`} className="flex items-start gap-2"><span className="pt-1"><Mark kind="flag" /></span><div><Explain text={f} /></div></div>)}
      <div className="flex flex-wrap items-center gap-3">
        <Note>Plan checked {clock(summary.at)}.</Note>
        <Quiet onClick={() => runPlan({ migrationId })} disabled={plan.isPending}>{plan.isPending ? "Planning…" : "Plan again"}</Quiet>
      </div>
      <Details title="How the plan is used"><p>{heldSentence(held)}</p></Details>
      <Problem error={[plan.error, latest.error]} title="Could not refresh the plan" />
      {short ? (
        <p className="flex items-start gap-2" data-testid="budget"><Mark kind="now" /><span>
          At monday’s daily limit, the move pauses and resumes after 00:00 UTC. Keep the app running.
        </span></p>
      ) : null}

      <PeopleChoices migrationId={migrationId} linked onChanged={() => void latest.refetch()} />
      {stale ? <p className="flex items-start gap-2" data-testid="plan-stale"><Mark kind="now" /><span>Choices changed after this plan. Plan again to refresh these numbers. Move reads monday again and uses the new choices.</span></p> : null}
      <div className="flex flex-wrap items-center gap-5 pt-2">
        <Go onClick={() => start.mutate({ migrationId, mode: "full" })} disabled={start.isPending || plan.isPending}>{start.isPending ? "Starting…" : stale ? "Move items" : `Move ${plural(moving, "item")}`}</Go>
        <Note>Repeating a move won’t duplicate items.</Note>
      </div>
      <Problem error={start.error} title="Could not start" />
    </>
  );
}

type RunStatus = { elsewhere?: boolean; progress: { done: number; planned: number; at: number; from: { done: number; at: number } } | null; since: string | null; boards: { name: string; applied: boolean }[] };

function Moving({ migrationId, status, onStopped }: { migrationId: number; status: RunStatus; onStopped: () => void }) {
  const trpc = useTRPC();
  const stop = useMutation(trpc.run.stop.mutationOptions({ onSuccess: onStopped }));
  const done = status.progress?.done ?? 0;
  const planned = status.progress?.planned ?? 0;
  const tenth = planned ? Math.floor((done / planned) * 10) * 10 : 0;
  return (
    <>
      <span role="status" className="sr-only">{planned ? `Moving: ${tenth} % complete.` : "Moving: reading both sides."}</span>
      <p className="text-lg" data-testid="moving">
        {planned ? <><span className="tabular-nums">{done}</span> of {plural(planned, "change")} completed.</> : "Reading both sides…"}
        {status.since ? <span className="text-cake-muted"> Changes since {clock(Date.parse(status.since))}.</span> : null}
      </p>
      <Progress done={done} planned={planned} />
      <div className="flex flex-wrap items-center gap-5">
        {status.elsewhere ? <Note>This run was started by another copy of this app. Stop it there.</Note> : (
          <>
            <Plain onClick={() => stop.mutate({ migrationId })} disabled={stop.isPending}>{stop.isPending ? "Stopping…" : "Stop after this change"}</Plain>
            <Note>Keep the app running. You can close this tab.</Note>
          </>
        )}
      </div>
      <Problem error={stop.error} title="Could not stop" />
    </>
  );
}

function Paused({ migrationId, waiting, deletions, onCancelled }: { migrationId: number; waiting: { reset: number; resumeAt: number }; deletions: boolean; onCancelled: () => void }) {
  const trpc = useTRPC();
  const cancel = useMutation(trpc.run.cancelResume.mutationOptions({ onSuccess: onCancelled }));
  return (
    <>
      <p role="status" className="text-lg" data-testid="paused">Paused. monday’s API calls for today are used up.</p>
      <p>Resumes at <strong>{clock(waiting.resumeAt)}</strong>. Progress is saved. Keep the app running.</p>
      {deletions ? <Note>Automatic resumes never delete or rebuild items. Use Move again for those changes.</Note> : null}
      <div><Plain onClick={() => cancel.mutate({ migrationId })} disabled={cancel.isPending}>Don’t continue on its own</Plain></div>
      <Problem error={cancel.error} title="Could not cancel" />
    </>
  );
}

type Run = { id: number; status: string; counts: Record<string, number> | null; finishedAt: number | null };

const EDITED_UPDATE_GAP = "For edited comments, use Move again.";

function Result({ migrationId, run, since, schedule, outside, onStarted }: { migrationId: number; run: Run; since: string | null; schedule: { at: number; everyHours: number | null } | null; outside: OutsideTheMove; onStarted: () => void }) {
  const trpc = useTRPC();
  const summary = useQuery({ ...trpc.verify.summary.queryOptions({ migrationId }), refetchOnWindowFocus: true });
  const problems = useQuery(trpc.run.problems.queryOptions({ migrationId }));
  const client = useTRPCClient();
  const readiness = usePlakyRead("provision.readiness", migrationId, () => client.provision.readiness.mutate({ migrationId }));
  const tick = useMutation(trpc.provision.tick.mutationOptions({ onSuccess: readiness.read }));
  const start = useMutation(trpc.run.start.mutationOptions({ onSuccess: onStarted }));
  const verify = useMutation(trpc.verify.run.mutationOptions({ onSuccess: () => void summary.refetch() }));
  const download = useSave();
  const [printError, setPrintError] = useState<Error | null>(null);
  const v = summary.data;
  if (!v) return <><Note>{summary.isPending ? "Reading the check…" : "The check could not be read."}</Note><Problem error={summary.error} title="Could not read the check" /></>;
  const receipt = v.receipt;
  const current = v.receiptRunId !== null && v.receiptRunId >= run.id && !v.undoneAfter;
  const readBefore = v.sourceReadAt != null && v.checkedAt != null && v.checkedAt - v.sourceReadAt >= 60_000 ? v.sourceReadAt : null;
  const stale = current && v.freshness?.stale === true;
  const goneBoards = (readiness.data ?? []).filter((i) => i.key.endsWith(":gone"));
  const goneIds = new Set(goneBoards.map((i) => i.board));
  const left = (readiness.data ?? []).filter((i) => (i.kind === "manual" || !i.done) && !i.key.endsWith(":status-types") && !i.key.endsWith(":gone"));
  const byBoard = new Map<string | null, typeof left>();
  for (const item of left) byBoard.set(item.board, [...(byBoard.get(item.board) ?? []), item]);
  const names = new Map<string, string>([...(receipt?.boards.map((b) => [b.monday_board_id, b.name] as const) ?? []), ...(readiness.data ?? []).flatMap((i) => (i.board !== null && i.boardName ? [[i.board, i.boardName] as const] : []))]);
  const again = (): void => start.mutate({ migrationId, mode: "full" });
  const notMoved = (problems.data?.items ?? []).filter((p) => p.code !== "verify.done");

  const allGone = Boolean(receipt?.boards.length) && receipt!.boards.every((b) => goneIds.has(b.monday_board_id));
  const offer = resultOffer({ runStatus: run.status, since, receipt: receipt ? (receipt.ok ? "ok" : "short") : "none", current, changes: v.changes, problems: notMoved.length, undoneAfter: v.undoneAfter, allGone });
  let headline: string;
  if (run.status === "interrupted") headline = `${run.counts?.writes === undefined ? "Stopped before it finished" : `Stopped after ${plural(run.counts.writes, "change")}`}. Moving again continues where it stopped.`;
  else if (run.status === "rate_limited") headline = "Stopped by monday’s daily limit, and nothing is set to restart it. Move again after the reset at 00:00 UTC.";
  else if (run.status === "plaky_rate_limited") headline = "Stopped by Plaky’s rate limit. Moving again continues where it stopped.";
  else if (v.undoneAfter) headline = "A board was undone after this was checked. Move again to rebuild it.";
  else if (receipt && current) headline = `${receipt.matched} of ${plural(receipt.monday_items, "item")} moved and checked against monday${v.receiptAt ? ` at ${clock(v.receiptAt)}` : ""}${readBefore !== null ? `, as monday read at ${clock(readBefore)}` : ""}.`;
  else if (since && run.status === "failed") headline = `Bringing over the changes ended with problems${run.finishedAt ? ` at ${clock(run.finishedAt)}` : ""}: see what was not moved below.`;
  else if (since) headline = `Changes brought over${run.finishedAt ? ` at ${clock(run.finishedAt)}` : ""}.${receipt && v.receiptAt ? ` Last checked at ${clock(v.receiptAt)}; the changes since are not checked yet.` : ""}`;
  else headline = run.status === "failed" ? "The run ended before everything was checked." : "Moved.";

  return (
    <>
      <p role="status" className="text-lg" data-testid="result">{headline}</p>
      <Problem error={summary.error} title="Could not refresh; showing the last check" />
      {receipt && !current && v.receiptAt ? <Note>As checked at {clock(v.receiptAt)}, after an earlier run:</Note> : null}
      {receipt && stale ? <p className="flex items-start gap-2" data-testid="receipt-stale"><Mark kind="now" /><span>{v.freshness!.reasons.join(" ")} Check now for a current receipt.</span></p> : null}
      {receipt ? (
        <Grid head={["Board", "In monday", "In Plaky", ""]} align={["left", "right", "right", "left"]} testId="result-boards">
          {receipt.boards.map((b) => (
            <Row key={b.monday_board_id}>
              <Cell>{b.name}</Cell><Cell right>{b.monday_items}</Cell><Cell right>{b.matched}</Cell>
              <Cell>
                {goneIds.has(b.monday_board_id) ? <Status kind="flag"><strong>Gone from Plaky since</strong></Status>
                  : b.complete ? <Status kind="done">Match</Status>
                  : <Status kind="flag"><strong>{b.missing.length ? `${b.missing.length} not moved` : b.differing.length ? `${b.differing.length} differ` : "Short"}</strong></Status>}
              </Cell>
            </Row>
          ))}
        </Grid>
      ) : null}
      {run.status !== "interrupted" ? (
        <div className="flex flex-wrap items-center gap-5 print:hidden"><Plain onClick={() => verify.mutate({ migrationId })} disabled={verify.isPending}>{verify.isPending ? "Checking every board…" : "Check now"}</Plain><Note>Compares both sides without changes.</Note></div>
      ) : null}
      <Problem error={verify.error} title="Could not check" />
      {receipt ? <ShortReasons receipt={receipt} /> : null}
      {receipt ? <Differences receipt={receipt} /> : null}
      <Outside outside={outside} />

      {notMoved.length ? (
        <Block title={notMoved.length === 1 ? "1 thing was not moved" : `${notMoved.length}${problems.data?.truncated ? "+" : ""} things were not moved`} testId="not-moved">
          <ul className="flex flex-col gap-3">
            {notMoved.map((p) => (
              <li key={p.id} className="flex flex-col gap-1">
                <span className="flex items-start gap-2"><span className="pt-1"><Mark kind="flag" /></span><span>{p.board ? <strong>{p.board}: </strong> : null}<Explain text={p.message} /></span></span>
                <span className="ml-6 flex flex-wrap gap-4 text-[15px] print:hidden">
                  {p.mondayItemUrl ? <a href={p.mondayItemUrl} target="_blank" rel="noreferrer">Open in monday</a> : null}
                  {p.boardUrl ? <a href={p.boardUrl} target="_blank" rel="noreferrer">Open the board in Plaky</a> : null}
                </span>
              </li>
            ))}
          </ul>
          <div className="flex flex-wrap items-center gap-5 print:hidden">
            <Go onClick={again} disabled={start.isPending}>{start.isPending ? "Starting…" : offer.move}</Go>
            <Note>{run.status === "rate_limited" ? "Before monday’s reset at 00:00 UTC it stops at the same point." : "Only what is missing or different is written."}</Note>
          </div>
        </Block>
      ) : offer.move ? (
        <div><Go onClick={again} disabled={start.isPending}>{start.isPending ? "Starting…" : offer.move}</Go></div>
      ) : null}
      <Problem error={problems.error} title="Could not read what was not moved" />
      <Problem error={start.error} title="Could not start" />

      <Details title={schedule ? "Scheduled changes — review or cancel" : "Bring over changes before the final switch"} className="print:hidden">
        <p>Copy new and changed items before the final switch. Items deleted in monday stay in Plaky. {EDITED_UPDATE_GAP}</p>
        <div className="flex flex-wrap items-center gap-5">
          <Plain onClick={() => start.mutate({ migrationId, mode: "changes" })} disabled={start.isPending || !offer.bring}>Bring over changes</Plain>
          <Note>{offer.refusedNote ?? (v.changes?.full.length ? `Reads in full: ${v.changes.full.join(", ")}.` : run.finishedAt ? `Last run finished at ${clock(run.finishedAt)}.` : "")}</Note>
        </div>
        {v.changes || schedule ? <ScheduleChanges migrationId={migrationId} schedule={schedule} onChange={onStarted} /> : null}
      </Details>

      {goneBoards.length ? (
        <Block title={goneBoards.length === 1 ? "A board is gone from Plaky" : `${goneBoards.length} boards are gone from Plaky`} testId="gone-boards">
          <ul className="flex flex-col gap-1">{goneBoards.map((i) => <li key={i.key} className="flex items-start gap-2"><span className="pt-1"><Mark kind="flag" /></span><span>{i.board !== null && names.get(i.board) ? <strong>{names.get(i.board)}: </strong> : null}<Explain text={i.text} /></span></li>)}</ul>
          <Note>In Set up boards, choose “Set up a deleted board again”.</Note>
        </Block>
      ) : null}
      {left.length ? (
        <Block title="Left for you in Plaky" testId="left-for-you">

          {[...byBoard].map(([board, list]) => (
            <div key={board ?? "workspace"} className="flex flex-col">
              <h4 className="pt-1 text-[15px] font-semibold">{board === null ? "The workspace" : (names.get(board) ?? board)}</h4>
              <ul className="flex flex-col">
                {list.map((item) => (
                  <li key={item.key} className="flex min-h-10 items-center gap-2.5">
                    {item.kind === "manual" ? (
                      <label className="flex items-center gap-2.5">
                        <input type="checkbox" className="size-[18px] flex-none accent-cake-brand-500" checked={item.done} disabled={tick.isPending} onChange={(e) => tick.mutate({ migrationId, key: item.key, done: e.target.checked })} />
                        <span className={item.done ? "text-cake-muted line-through" : undefined}><Explain text={item.text} /></span>
                      </label>
                    ) : <Status kind={item.key.endsWith(":gone") || item.key.endsWith(":unread") ? "flag" : "now"}><span><Explain text={item.text} /></span></Status>}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </Block>
      ) : readiness.isSuccess ? <Note>No manual steps left.</Note> : null}
      <Problem error={readiness.error} title="Could not read what is left to do in Plaky" />
      <Problem error={tick.error} title="Could not save that tick" />

      <Block title="Save report" className="print:hidden">
        <div className="flex flex-wrap items-center gap-5">
          <Note>Save before closing the app. Finished migration records are erased on shutdown.</Note>
          <Plain onClick={() => { try { setPrintError(null); window.print(); } catch (e) { setPrintError(e instanceof Error ? e : new Error(String(e))); } }}>Print or save as PDF</Plain>
          {receipt ? <Quiet onClick={() => download.save(`receipt-${migrationId}.json`, () => `${JSON.stringify(receiptEnvelope({ ...v, receipt }, outside), null, 2)}\n`)}>Download receipt (JSON)</Quiet> : null}
        </div>
        <Problem error={printError} title="Could not open printing" />
        <Problem error={download.error} title="Could not save the receipt" />
      </Block>
      <Note className="hidden border-t border-cake-line pt-4 print:block">Printed {new Date().toLocaleString()}. Nothing in monday was changed.</Note>
    </>
  );
}

function Outside({ outside }: { outside: OutsideTheMove }) {
  if (isNothingOutside(outside)) return null;
  return (
    <Details title="Review conversions and exclusions" testId="outside">
      <Note>Save a separate copy of excluded content.</Note>
      {outside.boards.length ? (
        <div><h4 className="text-[15px] font-semibold">Boards and other content not moved</h4>
          <ul className="ml-5 list-disc">{outside.boards.map((b, i) => <li key={`${i}:${b.name}`}><strong>{b.name}</strong>: {b.reason}</li>)}</ul></div>
      ) : null}
      {outside.columns.length ? (
        <div><h4 className="text-[15px] font-semibold">Fields not carried</h4>
          <ul className="ml-5 list-disc">{outside.columns.map((c, i) => <li key={`${i}:${c.board}:${c.column}`}><strong>{c.board}</strong>: {c.column}: {c.reason}</li>)}</ul></div>
      ) : null}
      {outside.byChoice.length ? (
        <div><h4 className="text-[15px] font-semibold">Left out by choice</h4>
          <ul className="ml-5 list-disc" data-testid="by-choice">{outside.byChoice.map((c, i) => <li key={`${i}:${c.board}:${c.column}`}><strong>{c.board}</strong>: {c.column} (Tools → Field pairing)</li>)}</ul></div>
      ) : null}
      {outside.deeper.length ? (
        <div><h4 className="text-[15px] font-semibold">Too deep for Plaky</h4>
          <Note>Plaky nests one level of subitems. These stay in monday, with their comments and files.</Note>
          <ul className="ml-5 list-disc" data-testid="deeper">{outside.deeper.map((d) => <li key={`${d.board}:${d.item}`}><strong>{d.board}</strong>: {d.item}</li>)}</ul></div>
      ) : null}
      {outside.filtered.length ? (
        <div><h4 className="text-[15px] font-semibold">Left out by a filter</h4>
          <ul className="ml-5 list-disc" data-testid="filtered">{outside.filtered.map((f) => <li key={f.board}><strong>{f.board}</strong>: {f.items} item(s) (Tools → Which items move)</li>)}</ul></div>
      ) : null}
      {outside.archivedGroups.length ? (
        <div><h4 className="text-[15px] font-semibold">Archived groups in monday</h4>
          <Note>monday’s API lists no items in an archived group, so they are not carried.</Note>
          <ul className="ml-5 list-disc">{outside.archivedGroups.map((g, i) => <li key={`${i}:${g.board}:${g.group}`}><strong>{g.board}</strong>: {g.group}</li>)}</ul></div>
      ) : null}
      {outside.inactiveItems.length ? (
        <div><h4 className="text-[15px] font-semibold">Archived and deleted items</h4>
          <ul className="ml-5 list-disc" data-testid="inactive-items">{outside.inactiveItems.map((i) => <li key={i.board}>{inactiveLine(i)}</li>)}</ul></div>
      ) : null}
      {outside.asText.length ? (
        <div><h4 className="text-[15px] font-semibold">Text and snapshots</h4>
          <ul className="ml-5 list-disc" data-testid="as-text">{outside.asText.map((c, i) => <li key={`${i}:${c.board}:${c.text}`}><strong>{c.board}</strong>: {c.text}</li>)}</ul></div>
      ) : null}
      {outside.planNotes.length ? (
        <div><h4 className="text-[15px] font-semibold">Migration plan notes</h4>
          <ul className="ml-5 list-disc" data-testid="plan-notes">{outside.planNotes.map((n, i) => <li key={`${i}:${n.board}:${n.text}`}><strong>{n.board}</strong>: {n.text}</li>)}</ul></div>
      ) : null}
      {outside.authorship ? (
        <div data-testid="authorship"><h4 className="text-[15px] font-semibold">Authors and dates</h4><p>{AUTHORSHIP_NOTE}</p></div>
      ) : null}
      {outside.warnings.length ? (
        <div><h4 className="text-[15px] font-semibold">To check</h4>
          <ul className="flex flex-col gap-1">{outside.warnings.map((w, i) => <li key={`${i}:${w}`} className="flex items-start gap-2"><span className="pt-1"><Mark kind="now" /></span><span><Explain text={w} /></span></li>)}</ul></div>
      ) : null}
    </Details>
  );
}

function ShortReasons({ receipt }: { receipt: ReceiptView }) {
  const lines = receipt.boards.flatMap((b) => shortReasons(b).map((text) => ({ board: b.name, text })));
  if (!lines.length) return null;
  return (
    <Block title="Why the check is short" testId="short-reasons">
      <ul className="flex flex-col gap-1">
        {lines.map((l, i) => <li key={`${i}:${l.text}`} className="flex items-start gap-2"><span className="pt-1"><Mark kind="flag" /></span><span><strong>{l.board}</strong>: <Explain text={l.text} /></span></li>)}
      </ul>
    </Block>
  );
}

function Differences({ receipt }: { receipt: ReceiptView }) {
  const lines = receipt.boards.flatMap((b) => [
    ...b.differing.map((d) => ({ board: b.name, kind: "differs", text: d })),
    ...b.not_carried.map((d) => ({ board: b.name, kind: "value not carried", text: d })),
    ...b.uncarried.map((d) => ({ board: b.name, kind: "field not carried", text: d })),
  ]);
  if (!lines.length) return null;
  return (
    <Block title={lines.length === 1 ? "1 value is not as in monday" : `${lines.length} values are not as in monday`} testId="differences">
      <ul className="flex flex-col gap-1">
        {lines.map((l, i) => <li key={`${i}:${l.text}`} className="flex items-start gap-2"><span className="pt-1"><Mark kind="flag" /></span><span><strong>{l.board}</strong> ({l.kind}): <Explain text={l.text} /></span></li>)}
      </ul>
    </Block>
  );
}
