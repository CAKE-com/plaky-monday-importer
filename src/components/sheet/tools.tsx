"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSubscription } from "@trpc/tanstack-react-query";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { use, useCallback, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { confirmationState } from "@/lib/confirmation-state";
import { erasePhrase } from "@/lib/erase-phrase";
import { statusRefetchMs } from "@/lib/move-state";
import { useSave } from "./use-save";
import { handoffReport } from "@/lib/handoff-report";
import { ConfirmDialog } from "./confirm-dialog";
import { Departure } from "./departure";
import { outsideTheMove } from "@/lib/outside";
import { receiptEnvelope } from "@/lib/receipt-envelope";
import { EventBuffer, streamStats, type Stream } from "@/lib/stream-stats";
import { COUNT_LABEL, runKind, runMode, runStatus } from "@/lib/labels";
import { useTRPC, useTRPCClient } from "@/lib/trpc";
import type { RunEvent } from "@/server/trpc/routers/run";
import { Block, Cell, clock, Danger, Explain, fieldClass, Go, Grid, Mark, Note, Plain, plural, Problem, Progress, Quiet, Row, saveFile, Status, useMigrationId } from "./bits";
import { LinkTable } from "./link-table";
import { NeedsLink } from "./link-first";
import { heldSentence } from "./move-section";
import { TOOLS } from "./migration-sheet";
import { VirtualLog } from "./virtual-log";
import { usePlakyRead } from "./plaky-read";
import { useQueryChange } from "./subscriptions";

export function ToolsNav({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const pathname = usePathname();
  return (
    <>
      <nav aria-label="Tools" className="flex flex-wrap items-center gap-x-4 gap-y-1 pb-4 text-[15px]">
        <Link prefetch={false} href={`/migrations/${id}`}>← Back to the sheet</Link>
        <span className="text-cake-muted">·</span>
        {TOOLS.map(([slug, label]) => (
          <Link key={slug} prefetch={false} href={`/migrations/${id}/${slug}`} aria-current={pathname.endsWith(`/${slug}`) ? "page" : undefined} className={pathname.endsWith(`/${slug}`) ? "font-medium text-cake-ink no-underline" : undefined}>{label}</Link>
        ))}
      </nav>
    </>
  );
}

const when = (ms: number | string): string => clock(typeof ms === "string" ? Date.parse(ms) : ms);


function duration(ms: number | null): string {
  if (ms === null) return "—";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m} min ${s % 60} s` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

const SHOWN = ["writes", "created", "updated", "unchanged", "failures", "ambiguous", "deletedItems", "deletedGroups"] as const;

export function RunHistory({ params }: { params: Promise<{ id: string }> }) {
  const migrationId = useMigrationId(params);
  const trpc = useTRPC();
  const history = useQuery(trpc.run.history.queryOptions({ migrationId }));
  const [open, setOpen] = useState<number | null>(null);
  return (
    <Block level={1} title="Run history">
      <Note>Open a run for its results and problems.</Note>
      <Problem error={history.error} title="Could not read the runs" />
      {history.data && !history.data.length ? <Note>No runs yet.</Note> : null}
      {history.data?.length ? (
        <Grid head={["#", "Kind", "Mode", "Status", "Counts", "monday calls", "Started", "Took"]} align={["left", "left", "left", "left", "left", "right", "left", "right"]} testId="runs" label="Run history">
          {history.data.map((r) => (
            <Row key={r.id}>
              <Cell><button type="button" className="text-left text-cake-brand-550 underline underline-offset-3" aria-expanded={open === r.id} data-testid={`run-${r.id}`} onClick={() => setOpen(open === r.id ? null : r.id)}>{r.id}</button></Cell>
              <Cell>{runKind(r.kind)}</Cell>
              <Cell>{r.mode ? runMode(r.mode) : "—"}{r.since ? <span className="block text-sm text-cake-muted">since {when(r.since)}</span> : null}</Cell>
              <Cell><Status kind={r.status === "succeeded" ? "done" : r.status === "failed" ? "flag" : r.status === "running" ? "now" : "next"}>{runStatus(r.status)}</Status></Cell>
              <Cell className="text-sm">{SHOWN.filter((k) => r.counts?.[k]).map((k) => `${r.counts![k]} ${COUNT_LABEL[k] ?? k}`).join(", ") || (r.plannedWrites !== null ? `planned ${r.plannedWrites}` : "—")}</Cell>
              <Cell right>{r.mondayCalls ?? "—"}</Cell>
              <Cell className="text-sm">{when(r.startedAt)}</Cell>
              <Cell right>{r.status === "running" ? "running" : duration(r.durationMs)}</Cell>
            </Row>
          ))}
        </Grid>
      ) : null}
      {open !== null ? <RunDetails key={open} migrationId={migrationId} runId={open} /> : null}
    </Block>
  );
}

function Problems({ items, truncated }: { items: { id: number; level: string; board: string | null; boardUrl: string | null; mondayItemUrl: string | null; message: string }[]; truncated: boolean }) {
  if (!items.length) return <Note>None.</Note>;
  return (
    <ul className="flex flex-col gap-2" data-testid="problems">
      {items.map((p) => (
        <li key={p.id} className="flex flex-col gap-1">
          <span className="flex items-start gap-2"><span className="pt-1"><Mark kind="flag" /></span><span>{p.board ? <strong>{p.board}: </strong> : null}<Explain text={`${p.level === "error" ? "" : "outcome unknown: "}${p.message}`} /></span></span>
          <span className="ml-6 flex flex-wrap gap-4 text-[15px]">
            {p.mondayItemUrl ? <a href={p.mondayItemUrl} target="_blank" rel="noreferrer" data-testid="monday-item-link">Open in monday</a> : null}
            {p.boardUrl ? <a href={p.boardUrl} target="_blank" rel="noreferrer">Open the board in Plaky</a> : null}
          </span>
        </li>
      ))}
      {truncated ? <li className="text-sm text-cake-muted">and more: the first {items.length} are shown.</li> : null}
    </ul>
  );
}

function RunDetails({ migrationId, runId }: { migrationId: number; runId: number }) {
  const trpc = useTRPC();
  const problems = useQuery(trpc.run.problems.queryOptions({ migrationId, runId }));
  const receipt = useQuery(trpc.run.receipt.queryOptions({ migrationId, runId }));
  const r = receipt.data;
  return (
    <div className="flex flex-col gap-3 border-t border-cake-line pt-4" data-testid="run-details">
      <h3 className="text-[15px] font-semibold">Run {runId}{r ? ` (${r.kind})` : ""}</h3>
      <Problem error={problems.error} title="Could not read the run's problems" />
      <Problem error={receipt.error} title="Could not read the run's receipt" />
      <div className="flex flex-col gap-2" data-testid="run-problems">
        <span className="text-sm text-cake-muted">Problems ({problems.data?.items.length ?? 0}{problems.data?.truncated ? "+" : ""})</span>
        {problems.data ? <Problems items={problems.data.items} truncated={problems.data.truncated} /> : null}
      </div>
      <div className="flex flex-col gap-2" data-testid="run-receipt">
        <span className="text-sm text-cake-muted">Receipt</span>
        {r?.receipt ? (
          <>
            <p>{r.receipt.ok ? <Status kind="done">Complete</Status> : <Status kind="flag"><strong>Incomplete</strong></Status>} · {r.receipt.matched} of {plural(r.receipt.monday_items, "monday item")} present in Plaky.</p>
            <Grid head={["Board", "In monday", "In Plaky", "Matched", ""]} align={["left", "right", "right", "right", "left"]} label="Board comparison, monday and Plaky">
              {r.receipt.boards.map((b) => (
                <Row key={b.monday_board_id}>
                  <Cell>{b.name}</Cell><Cell right>{b.monday_items}</Cell><Cell right>{b.plaky_items}</Cell><Cell right>{b.matched}</Cell>
                  <Cell>{b.complete ? <Status kind="done">Match</Status> : <Status kind="flag"><strong>{b.missing.length ? `${b.missing.length} not moved` : b.differing.length ? `${b.differing.length} differ` : "Short"}</strong></Status>}</Cell>
                </Row>
              ))}
            </Grid>
            {r.receipt.failures.map((f, i) => <div key={`${i}:${f}`} className="flex items-start gap-2"><span className="pt-1"><Mark kind="flag" /></span><div><Explain text={`Could not verify ${f}`} /></div></div>)}
            {r.receipt.unmatched_users.map((u, i) => <p key={`${i}:${u}`} className="flex items-start gap-2"><Mark kind="flag" /><span>Assignment not carried: {u}</span></p>)}
          </>
        ) : r?.plan ? (
          <>
            <p>Migration plan: {plural(r.plan.plannedWrites, "planned change")}.</p>
            <Grid head={["Board", "Create", "Update", "Unchanged"]} align={["left", "right", "right", "right"]} label="Migration plan by board">
              {r.plan.boards.map((b) => <Row key={b.mondayBoardId}><Cell>{b.name}</Cell><Cell right>{b.creates}</Cell><Cell right>{b.updates}</Cell><Cell right>{b.unchanged}</Cell></Row>)}
            </Grid>
            {r.plan.failures.map((f, i) => <div key={`${i}:${f}`} className="flex items-start gap-2"><span className="pt-1"><Mark kind="flag" /></span><div><Explain text={`Cannot plan ${f}`} /></div></div>)}
          </>
        ) : r ? <Note>This run left no receipt.</Note> : null}
      </div>
    </div>
  );
}


const runActive = (state: { data: { active: boolean } | undefined } | undefined): boolean => state?.data?.active === true;

function runEventLog() {
  const buffer = new EventBuffer<RunEvent>();
  let stream: Stream<RunEvent> = { events: [], received: 0, duplicates: 0 };
  return {
    push: (payload: unknown): void => buffer.push(((payload as { data?: RunEvent }).data ?? payload) as RunEvent),
    read: (): Stream<RunEvent> => stream,
    subscribe: (changed: () => void): (() => void) => {
      const timer = setInterval(() => {
        const batch = buffer.drain();
        if (!batch.length && stream.received === buffer.received) return;
        stream = { events: stream.events.concat(batch), received: buffer.received, duplicates: buffer.duplicates };
        changed();
      }, 250);
      return () => clearInterval(timer);
    },
  };
}

export function LiveLog({ params }: { params: Promise<{ id: string }> }) {
  const migrationId = useMigrationId(params);
  const trpc = useTRPC();
  const status = useQuery({ ...trpc.run.status.queryOptions({ migrationId }), refetchInterval: (q) => statusRefetchMs(q.state.data), refetchOnWindowFocus: true });
  const start = useMutation(trpc.run.start.mutationOptions({ onSuccess: () => void status.refetch() }));
  const stop = useMutation(trpc.run.stop.mutationOptions({ onSuccess: () => void status.refetch() }));
  const cancelResume = useMutation(trpc.run.cancelResume.mutationOptions({ onSuccess: () => void status.refetch() }));
  const problems = useQuery({ ...trpc.run.problems.queryOptions({ migrationId }), refetchInterval: status.data?.active ? 2000 : false });
  const active = status.data?.active === true;
  const refetchProblems = problems.refetch;
  const refetchWhenEnded = useCallback((nowActive: boolean, wasActive: boolean | undefined): void => { if (wasActive && !nowActive) void refetchProblems(); }, [refetchProblems]);
  useQueryChange(trpc.run.status.queryKey({ migrationId }), runActive, refetchWhenEnded);

  const [log] = useState(runEventLog);
  const stream = useSyncExternalStore(log.subscribe, log.read, log.read);
  const sub = useSubscription(trpc.run.events.subscriptionOptions({ migrationId }, { onData: log.push }));

  const stats = useMemo(() => streamStats(stream), [stream]);
  const s = status.data;
  const done = s?.progress?.done ?? 0;
  const planned = s?.progress?.planned ?? 0;
  const currentRun = s?.run?.id ?? null;
  const perBoard = useMemo(() => {
    const m = new Map<string, { events: number; problems: number }>();
    for (const e of stream.events) {
      if (!e.board || e.runId !== currentRun) continue;
      const cur = m.get(e.board) ?? { events: 0, problems: 0 };
      cur.events++;
      if (e.level === "error" || e.level === "ambiguous") cur.problems++;
      m.set(e.board, cur);
    }
    return m;
  }, [stream, currentRun]);

  return (
    <>
      <Block level={1} title="Live log">
        <Note>Reloading keeps the run going.</Note>
        <div className="flex flex-wrap items-center gap-4">
          <Go onClick={() => start.mutate({ migrationId })} disabled={start.isPending || active}>{s?.run ? "Run again" : "Start run"}</Go>
          <Plain onClick={() => stop.mutate({ migrationId })} disabled={!active || s?.elsewhere || stop.isPending}>Stop after this write</Plain>
          <span role="status" data-testid="run-status">{active ? <Status kind="now">running</Status> : s?.waiting ? <Status kind="now">waiting for monday</Status> : <Status kind={s?.run?.status === "succeeded" ? "done" : s?.run ? "flag" : "next"}>{s?.run ? runStatus(s.run.status) : "not started"}</Status>}</span>
        </div>
        {s?.waiting && !active ? (
          <p className="flex items-start gap-2" data-testid="monday-wait"><Mark kind="now" /><span>
            Waiting for monday’s daily limit until {clock(s.waiting.reset)}. The run resumes on its own at {clock(s.waiting.resumeAt)}; everything written so far is kept.{" "}
            <Quiet onClick={() => cancelResume.mutate({ migrationId })} disabled={cancelResume.isPending}>Don’t continue on its own</Quiet>
          </span></p>
        ) : null}
        <Problem error={start.error} title="Could not start the run" />
        <Problem error={stop.error} title="Could not stop the run" />
        <Problem error={cancelResume.error} title="Could not cancel the automatic resume" />
        <Problem error={status.error} title="Could not read the run status" />
        <Problem error={sub.error} title="The live log disconnected" />
        {s?.since ? <Note data-testid="run-since">Changes-only run: monday items changed since {when(s.since)}.</Note> : null}
        <p className="text-sm" data-testid="progress-text">{done} of {plural(planned, "write")} done.</p>
        <Progress done={done} planned={planned} />
        <p className="flex flex-wrap gap-4 text-sm" data-testid="counters">
          <span>Outcome unknown: <strong>{s?.counters.ambiguous ?? 0}</strong></span>
          <span>Failures: <strong>{s?.counters.errors ?? 0}</strong></span>
          <span>Warnings: <strong>{s?.counters.warnings ?? 0}</strong></span>
        </p>
        <Grid head={["Board", "Status", "Events"]} align={["left", "left", "right"]} label="Run progress by board">
          {(s?.boards ?? []).map((b, i) => {
            const seen = perBoard.get(b.name);
            const state = b.state.applied === "written" ? "moved" : active ? (seen ? "moving" : "waiting") : s?.run ? "not moved" : "waiting";
            return <Row key={`${i}:${b.name}`}><Cell>{b.name}</Cell><Cell>{state}{seen?.problems ? ` · ${plural(seen.problems, "problem")}` : ""}</Cell><Cell right>{seen?.events ?? 0}</Cell></Row>;
          })}
        </Grid>
        {problems.data?.items.length ? (
          <div className="flex flex-col gap-2">
            <span className="text-sm text-cake-muted">To look at ({problems.data.items.length}{problems.data.truncated ? "+" : ""}). Run again settles what it can: only what is missing or different in Plaky is written, so nothing is duplicated.</span>
            <Problems items={problems.data.items} truncated={problems.data.truncated} />
          </div>
        ) : null}
        <Problem error={problems.error} title="Could not read the problems" />
        <VirtualLog rows={stream.events} />
        <details className="text-sm text-cake-muted">
          <summary className="cursor-pointer">Technical details</summary>
          <p data-testid="stream-stats">
            events {stats.first === null ? "none yet" : `#${stats.first}–#${stats.last}`}, {stream.events.length} shown, {stream.received} received, gaps {stats.gaps}, duplicates {stream.duplicates}, stream {STREAM_STATE[sub.status] ?? sub.status}
          </p>
        </details>
      </Block>
      <UndoBoard migrationId={migrationId} disabled={active} onDone={() => void status.refetch()} />
    </>
  );
}

const STREAM_STATE: Record<string, string> = { idle: "closed", connecting: "connecting", pending: "live", error: "reconnecting" };

const workedSentence = (items: number): string => `${plural(items, "item")} kept: people added comments or files in Plaky.`;

const undoCounts = (items: number, nested: number, groups: number, their = true): string =>
  `${items} item(s)${nested ? `, ${their ? "their " : ""}${nested} nested subitem(s)` : ""} and ${groups} group(s)`;

export function UndoBoard({ migrationId, disabled, onDone }: { migrationId: number; disabled: boolean; onDone?: () => void }) {
  const trpc = useTRPC();
  const boards = useQuery(trpc.undo.boards.queryOptions({ migrationId }));
  const [board, setBoard] = useState("");
  const [typed, setTyped] = useState("");
  const preview = useMutation(trpc.undo.preview.mutationOptions());
  const commit = useMutation(trpc.undo.commit.mutationOptions({ onSuccess: () => { preview.reset(); setTyped(""); onDone?.(); } }));
  const p = preview.data && preview.data.board.mondayBoardId === board ? preview.data : null;
  const r = commit.data;
  const confirmation = confirmationState(p?.board.name ?? null, typed, commit.isPending || preview.isPending, disabled);
  if (boards.error) return <Block level={2} title="Undo one board" testId="undo"><Problem error={boards.error} title="Could not read the boards that can be undone" /></Block>;
  if (!boards.data?.length) return null;
  return (
    <Block level={2} title="Undo one board" testId="undo">
      <Note>Deletes this migration’s items and empty groups from the selected Plaky board. Items people worked on in Plaky, by adding a comment or a file, are kept, and so are their groups. Other content stays.</Note>
      <div className="flex flex-wrap items-center gap-4">
        <select disabled={commit.isPending || preview.isPending} aria-label="Board to undo" className={fieldClass} value={board} onChange={(e) => { setBoard(e.target.value); setTyped(""); preview.reset(); commit.reset(); }}>
          <option value="">Choose a board…</option>
          {boards.data.map((b) => <option key={b.mondayBoardId} value={b.mondayBoardId}>{b.name}</option>)}
        </select>
        <Plain disabled={!board || preview.isPending || commit.isPending || disabled} onClick={() => { setTyped(""); preview.reset(); commit.reset(); preview.mutate({ migrationId, mondayBoardId: board }); }}>
          {preview.isPending ? "Reading Plaky…" : "Preview undo"}
        </Plain>
      </div>
      <Problem error={preview.error} title="Could not read the board" />
      {p ? (
        <div className="flex flex-col gap-3" data-testid="undo-preview">
          <p>
            Would delete <strong data-testid="undo-items">{p.items.length}</strong> item(s){p.nested.length ? <>, their <strong data-testid="undo-nested">{p.nested.length}</strong> nested subitem(s)</> : null} and <strong data-testid="undo-groups">{p.groups.length}</strong> group(s) on{" "}
            {p.board.url ? <a href={p.board.url} target="_blank" rel="noreferrer">{p.board.name}</a> : p.board.name}.
          </p>
          {p.items.length ? (
            <details><summary className="cursor-pointer">Items ({p.items.length})</summary>
              <ul className="ml-5 max-h-48 list-disc overflow-auto text-cake-muted">{p.items.map((i) => <li key={i.plakyId}>{i.title} <span className="text-sm">(monday {i.mondayId})</span></li>)}</ul>
            </details>
          ) : null}
          {p.nested.length ? (
            <details><summary className="cursor-pointer">Nested subitems ({p.nested.length}), deleted with their items</summary>
              <ul className="ml-5 max-h-48 list-disc overflow-auto text-cake-muted">{p.nested.map((n) => <li key={n.plakyId}>{n.title} <span className="text-sm">(monday {n.mondayId})</span></li>)}</ul>
            </details>
          ) : null}
          {p.worked.length ? <p className="flex items-start gap-2" data-testid="undo-worked"><Mark kind="now" />{workedSentence(p.worked.length)}</p> : null}
          {p.groups.length ? <Note>Groups: {p.groups.map((g) => g.title).join(", ")}</Note> : null}
          {p.kept.length ? <div><p className="flex items-start gap-2"><Mark kind="now" /><strong>Left alone ({p.kept.length})</strong></p><ul className="ml-5 list-disc text-[15px]">{p.kept.map((k) => <li key={k}>{k}</li>)}</ul></div> : null}
          {p.gone.length ? <Note>{p.gone.length} record(s) of rows already gone from Plaky are cleared.</Note> : null}
          <label className="flex max-w-[520px] flex-col gap-1.5">
            <span>Type the board’s name, <strong>{p.board.name}</strong>, to confirm. Each item is checked again just before it is deleted, and one people worked on in Plaky meanwhile is kept.</span>
            <input value={typed} onChange={(e) => setTyped(e.target.value)} aria-label="Board name to confirm" className={fieldClass} />
          </label>
          <div>
            <Danger disabled={confirmation !== "confirmed"} onClick={() => commit.mutate({ migrationId, mondayBoardId: board, confirm: typed, expected: { items: p.items.map((i) => i.plakyId), groups: p.groups.map((g) => g.plakyId) } })}>
              {commit.isPending ? "Deleting…" : `Delete ${undoCounts(p.items.length, p.nested.length, p.groups.length, false)}`}
            </Danger>
          </div>
        </div>
      ) : null}
      <Problem error={commit.error} title="Undo failed" />
      {r ? (
        <div className="flex items-start gap-2" data-testid="undo-result"><span className="pt-1"><Mark kind={r.failures.length ? "flag" : "done"} /></span><div>
          Deleted {undoCounts(r.deletedItems, r.deletedNested, r.deletedGroups, false)} on {r.board.name}.{r.reset ? " The board is marked not applied: the next run rebuilds it." : ""}{r.scheduleCancelled ? " The schedule to bring over changes was cancelled, so nothing rebuilds it by itself." : ""}
          {r.worked.length ? <p data-testid="undo-result-worked">{workedSentence(r.worked.length)}</p> : null}
          {r.kept.length ? <details><summary className="cursor-pointer">Left alone ({r.kept.length})</summary><ul className="ml-5 list-disc text-[15px]">{r.kept.map((k) => <li key={k}>{k}</li>)}</ul></details> : null}
          {r.failures.length ? <ul className="ml-5 list-disc">{r.failures.map((f) => <li key={f}><Explain text={f} /></li>)}</ul> : null}
        </div></div>
      ) : null}
    </Block>
  );
}


export function Exports({ params }: { params: Promise<{ id: string }> }) {
  const migrationId = useMigrationId(params);
  const trpc = useTRPC();
  const client = useTRPCClient();
  const status = useQuery({ ...trpc.run.status.queryOptions({ migrationId }), refetchInterval: (q) => statusRefetchMs(q.state.data) });
  const summary = useQuery({ ...trpc.verify.summary.queryOptions({ migrationId }), refetchOnWindowFocus: true });
  const discovered = useQuery(trpc.discovery.manifest.queryOptions({ migrationId }));
  const planned = useQuery(trpc.plan.latest.queryOptions({ migrationId }));
  const outside = outsideTheMove(discovered.data?.manifest, planned.data?.summary);
  const verifyNow = useMutation(trpc.verify.run.mutationOptions({ onSuccess: async () => { await summary.refetch(); } }));
  const download = useSave();
  const report = useMutation({ mutationFn: async () => {
    const data = summary.data;
    if (!data?.receipt) return null;
    let checklistError: Error | null = null;
    const readiness = await client.provision.readiness.mutate({ migrationId }).catch((e: unknown) => {
      checklistError = e instanceof Error ? e : new Error(String(e));
      return null;
    });
    const text = handoffReport({
      migrationName: data.migrationName, generatedAt: new Date(), receipt: data.receipt, boardLinks: data.links, readiness,
      verifiedAt: data.receiptAt === null ? null : new Date(data.receiptAt),
      unverifiedLaterRun: data.run && data.receiptRunId !== null && data.run.id !== data.receiptRunId ? { status: data.run.status, startedAt: new Date(data.run.startedAt) } : null,
      undoneAfter: data.undoneAfter,
      boardNames: new Map(data.receipt.boards.map((b) => [b.monday_board_id, b.name])),
      outside,
    });
    saveFile(`migration-report-${migrationId}.md`, text, "text/markdown");
    return { checklistError };
  } });
  const r = summary.data;
  const busy = status.data?.active === true || verifyNow.isPending;
  const receiptIsOlder = r?.receipt && r.run && r.receiptRunId !== null && r.receiptRunId !== r.run.id;
  return (
    <><Block level={1} title="Checks and exports">
      <Problem error={summary.error} title="Could not read the receipt" />
      <Problem error={status.error} title="Could not read the run status" />
      {r?.receipt ? (
        <p>{r.receipt.ok ? <Status kind="done">Complete</Status> : <Status kind="flag"><strong>Incomplete</strong></Status>} · {r.receipt.matched} of {plural(r.receipt.monday_items, "monday item")} present in Plaky{r.receiptAt ? `, checked at ${clock(r.receiptAt)}` : ""}.</p>
      ) : <Note>No receipt yet: finish a run first.</Note>}
      {receiptIsOlder && !busy ? <Note>This receipt is from an earlier run: the last run{status.data?.since ? ` (changes since ${when(status.data.since)})` : ""} was not checked. Check now for a current one.</Note> : null}
      {r?.receipt && r.freshness?.stale && !receiptIsOlder && !busy ? <Note>{r.freshness.reasons.join(" ")} Check now for a current receipt.</Note> : null}
      {verifyNow.isPending ? <Note>Checking: reading every board on both sides…</Note> : null}
      <Problem error={verifyNow.error} title="Could not check" />
      <div className="flex flex-wrap gap-4">
        <Plain onClick={() => verifyNow.mutate({ migrationId })} disabled={busy}>Check now</Plain>
        <Plain disabled={!r?.receipt || report.isPending} onClick={() => report.mutate()}>{report.isPending ? "Reading Plaky…" : "Export the report"}</Plain>
        <Plain disabled={!r?.receipt} onClick={() => { const got = r?.receipt; if (r && got) download.save(`receipt-${migrationId}.json`, () => `${JSON.stringify(receiptEnvelope({ ...r, receipt: got }, outside), null, 2)}\n`); }}>Export the receipt (JSON)</Plain>
      </div>
      <Problem error={[report.error, download.error]} title="Export failed" />
      <Problem error={report.isSuccess ? report.data?.checklistError : null} title="Report saved without the manual checklist" />
    </Block>
    <Departure key={migrationId} migrationId={migrationId} /></>
  );
}


type Destructive = "prune" | "recreateDrifted";
const WARNING: Record<Destructive, { title: string; text: string }> = {
  prune: { title: "Delete Plaky rows that monday no longer has?", text: "Rows whose monday item was deleted, moved or archived will be deleted from Plaky. Rows people worked on in Plaky, by adding a comment or a file, are kept. This cannot be undone." },
  recreateDrifted: { title: "Delete and re-create renamed items?", text: "An item renamed in monday is deleted and created again with its new title, which gives it a new Plaky id and loses anything added to it in Plaky. An item that changed group is moved, not re-created." },
};

export function PlanOptions({ params }: { params: Promise<{ id: string }> }) {
  const migrationId = useMigrationId(params);
  const trpc = useTRPC();
  const latest = useQuery(trpc.plan.latest.queryOptions({ migrationId }));
  const discovered = useQuery(trpc.discovery.manifest.queryOptions({ migrationId }));
  const nested = discovered.data?.manifest?.boards.some((b) => b.nested) ?? false;
  const [showValues, setShowValues] = useState(false);
  const [asking, setAsking] = useState<Destructive | null>(null);
  const details = useQuery({ ...trpc.plan.details.queryOptions({ migrationId, showValues: true }), enabled: showValues });
  const run = useMutation(trpc.plan.run.mutationOptions({ onSuccess: () => { void latest.refetch(); if (showValues) void details.refetch(); } }));
  const queryClient = useQueryClient();
  const setOptions = useMutation(trpc.plan.setOptions.mutationOptions({
    onSuccess: (stored) => {
      setAsking(null);
      queryClient.setQueryData(trpc.plan.latest.queryKey({ migrationId }), (old) => (old ? { ...old, prune: stored.prune, recreateDrifted: stored.recreateDrifted, carryArchived: stored.carryArchived } : old));
      void queryClient.invalidateQueries(trpc.verify.summary.queryFilter({ migrationId }));
      void queryClient.invalidateQueries(trpc.run.status.queryFilter({ migrationId }));
      void latest.refetch();
    },
  }));
  const summary = run.data ?? latest.data?.summary ?? null;
  const prune = latest.data?.prune ?? false;
  const recreate = latest.data?.recreateDrifted ?? false;
  const set = (key: Destructive, on: boolean): void => setOptions.mutate({ migrationId, [key]: on });
  const change = (key: Destructive, on: boolean): void => (on ? setAsking(key) : set(key, false));
  const switches = useRef<Record<Destructive, HTMLInputElement | null>>({ prune: null, recreateDrifted: null });
  const option = (key: Destructive, label: string, hint: string, checked: boolean) => (
    <label className="flex items-start gap-2.5"><input type="checkbox" ref={(el) => { switches.current[key] = el; }} className="mt-1 size-[18px] flex-none accent-cake-brand-500" checked={checked} disabled={setOptions.isPending || (key === "recreateDrifted" && !checked && (nested || !discovered.isSuccess))} onChange={(e) => change(key, e.target.checked)} /><span>{label}<span className="block text-sm text-cake-muted">{key === "recreateDrifted" && nested ? "Unavailable with nested subitems." : hint}</span></span></label>
  );
  return (
    <Block level={1} title="Plan and options">
      <div className="flex flex-wrap items-center gap-4">
        <Plain onClick={() => run.mutate({ migrationId })} disabled={run.isPending}>{run.isPending ? "Planning… (reads monday and Plaky)" : "Plan again"}</Plain>
        <Note>Preview only. Use Move on the migration page to apply.</Note>
      </div>

      <Link prefetch={false} href={`/migrations/${migrationId}`}>Back to migration</Link>
      <Problem error={run.error} title="Could not plan" />
      <Problem error={latest.error} title="Could not read the last plan" />
      <Problem error={discovered.error} title="Could not read the subitem setup" />
      {summary ? (
        <>
          <Grid head={["Board", "Create", "Update", "Unchanged", "Title differs", "Source item removed", "Groups", "Comments", "Files"]} align={["left", "right", "right", "right", "right", "right", "right", "right", "right"]} testId="dry-run" label="Plan by board">
            {summary.boards.map((b) => (
              <Row key={b.mondayBoardId}><Cell>{b.name}</Cell><Cell right>{b.creates}</Cell><Cell right>{b.updates}</Cell><Cell right>{b.unchanged}</Cell><Cell right>{b.drifted}</Cell><Cell right>{b.orphans}</Cell><Cell right>{b.groupWrites}</Cell><Cell right>{b.comments}</Cell><Cell right>{b.files}</Cell></Row>
            ))}
          </Grid>
          <Note data-testid="dry-run-totals">{plural(summary.plannedWrites, "planned change")}. Read from monday at {clock(summary.at)}{summary.mondayCalls !== undefined ? ` with ${plural(summary.mondayCalls, "call")}` : ""}.</Note>
          {summary.failures.map((f, i) => <div key={`${i}:${f}`} className="flex items-start gap-2"><span className="pt-1"><Mark kind="flag" /></span><div><Explain text={`Cannot plan ${f}`} /></div></div>)}
          {summary.boards.filter((b) => b.uncarried.length || b.notCarriedValues || b.notes?.length).map((b) => (
            <div key={b.mondayBoardId} className="text-[15px]">
              <strong>{b.name}:</strong> {[b.uncarried.length ? plural(b.uncarried.length, "field") + " not carried" : "", b.notCarriedValues ? plural(b.notCarriedValues, "value") + " not carried" : "", b.notes?.length ? plural(b.notes.length, "note") : ""].filter(Boolean).join(", ")}
              <ul className="ml-5 list-disc text-cake-muted">{b.uncarried.map((line, i) => <li key={`${i}:${line}`}>{line}</li>)}{(b.notes ?? []).map((line, i) => <li key={`note:${i}:${line}`} data-testid="dry-run-note">{line}</li>)}</ul>
            </div>
          ))}
          {latest.data ? (
            <Note data-testid="monday-budget">
              {heldSentence(run.data ? run.data.held : latest.data.held)} {latest.data.mondayCallsToday.toLocaleString("en")} of {latest.data.mondayLimit.calls.toLocaleString("en")} monday calls are used today (resets 00:00 UTC).
              {summary.mondayCalls !== undefined && latest.data.mondayCallsToday + summary.mondayCalls > latest.data.mondayLimit.calls ? " Another full read may run out of today’s calls." : ""}
            </Note>
          ) : null}
        </>
      ) : <Note>No plan yet.</Note>}
      <div className="flex flex-col gap-3 border-t border-cake-line pt-4">
        <label className="flex items-start gap-2.5"><input type="checkbox" className="mt-1 size-[18px] flex-none accent-cake-brand-500" checked={showValues} onChange={(e) => setShowValues(e.target.checked)} /><span>Show values<span className="block text-sm text-cake-muted">Includes item titles and personal data.</span></span></label>
        <Problem error={details.error} title="Could not read the values" />
        {showValues && details.isSuccess && details.data === null && summary ? <Note>Plan again to load values.</Note> : null}
        {showValues && details.data ? (
          <div className="flex flex-col gap-2 text-[15px]" data-testid="dry-run-values">
            {details.data.boards.map((b, i) => (
              <div key={`${i}:${b.name}`}>
                <strong>{b.name}</strong>
                {b.creates.length ? <p className="text-cake-muted">Create: {b.creates.join(", ")}</p> : null}
                {b.updates.length ? <p className="text-cake-muted">Update: {b.updates.join(", ")}</p> : null}
                {b.notCarried.map((line, i) => <p key={`${i}:${line}`} className="text-cake-muted">Not carried: {line}</p>)}
              </div>
            ))}
          </div>
        ) : null}
        <label className="flex items-start gap-2.5"><input type="checkbox" className="mt-1 size-[18px] flex-none accent-cake-brand-500" checked={latest.data?.carryArchived ?? false} disabled={setOptions.isPending} onChange={(e) => setOptions.mutate({ migrationId, carryArchived: e.target.checked })} /><span><strong>Carry archived items</strong><br /><Note>Imports as active items in “Archived in monday”. Limited to monday’s activity log. Apply with Move again.</Note></span></label>
        {option("prune", "Delete items removed from monday", "Delete Plaky items whose source item was removed from monday (destructive). Items people worked on in Plaky are kept.", prune)}
        {option("recreateDrifted", "Re-create items with changed titles", "Delete and re-create items whose titles differ from monday (destructive). Items that changed group are moved without this.", recreate)}
        {asking ? (
          <ConfirmDialog key={asking} testId="confirm-option" title={WARNING[asking].title} text={WARNING[asking].text} confirmLabel="Turn it on" cancelLabel="Keep it off"
            pending={setOptions.isPending} returnFocus={() => switches.current[asking]} onConfirm={() => set(asking, true)} onCancel={() => setAsking(null)} />
        ) : null}
        {prune || recreate ? <p className="flex items-start gap-2"><Mark kind="now" /><span>Destructive options are on for the next run.</span></p> : null}
        <Problem error={setOptions.error} title="Could not save that" />
      </div>
    </Block>
  );
}


export function Pairing({ params }: { params: Promise<{ id: string }> }) {
  const migrationId = useMigrationId(params);
  return (
    <Block level={1} title="Field pairing">
      <NeedsLink migrationId={migrationId}><PairingBody migrationId={migrationId} /></NeedsLink>
    </Block>
  );
}

function PairingBody({ migrationId }: { migrationId: number }) {
  const client = useTRPCClient();
  const preview = usePlakyRead("link.preview", migrationId, () => client.link.preview.mutate({ migrationId }));
  return (
    <>
      <Note>Review board links and field mapping.</Note>
      <Problem error={preview.error} title="Could not read the pairing" />
      {preview.isPending ? <Note>Reading Plaky…</Note> : preview.data ? <LinkTable preview={preview.data} /> : null}
      <div><Plain onClick={preview.read} disabled={preview.isPending}>Check again</Plain></div>
      <PairingEditor migrationId={migrationId} onSaved={preview.read} />
    </>
  );
}

export function PairingEditor({ migrationId, onSaved }: { migrationId: number; onSaved?: () => void }) {
  const trpc = useTRPC();
  const pairing = useQuery(trpc.link.pairing.queryOptions({ migrationId }));
  const save = useMutation(trpc.link.setPairing.mutationOptions({ onSuccess: () => { void pairing.refetch(); onSaved?.(); } }));
  if (pairing.error) return <Problem error={pairing.error} title="Could not read the field pairing" />;
  if (!pairing.data) return <Note>Reading the field pairing…</Note>;
  return (
    <div className="flex flex-col gap-5" data-testid="pairing-editor">
      <h2 className="text-[17px] font-medium">Where each field lands</h2>
      <Note>Choose a field or Don’t carry. Files move as attachments, without mapping. Changes apply on the next move.</Note>
      <Problem error={save.error} title="Could not change the pairing" />
      {pairing.data.boards.map((board) => (
        <div key={board.mondayBoardId} className="flex flex-col gap-2" data-testid={`pairing-${board.mondayBoardId}`}>
          <h3 className="text-[15px] font-semibold">{board.name}</h3>
          <Grid head={["monday field", "Lands in"]} testId={`pairing-grid-${board.mondayBoardId}`} label={`Where each ${board.name} field lands`}>
            {board.columns.map((c) => {
              const value = c.state === "skipped" ? "skip" : c.field?.key ?? "auto";
              const target = board.fields.find((f) => f.key === c.field?.key);
              const choose = (v: string): void => save.mutate({ migrationId, mondayBoardId: board.mondayBoardId, columnId: c.id, choice: v === "skip" ? { kind: "skip" } : v === "auto" ? { kind: "auto" } : { kind: "field", key: v } });
              return (
                <Row key={c.id}>
                  <Cell>{c.title} <span className="text-[15px] text-cake-muted">({c.type})</span></Cell>
                  <Cell>
                    <select aria-label={`Where ${c.title} lands`} className={fieldClass} value={value} disabled={save.isPending} onChange={(e) => choose(e.target.value)}>
                      <option value="auto">Automatic (same name)</option>
                      <option value="skip">Don’t carry</option>
                      {board.fields.map((f) => <option key={f.key} value={f.key}>{f.name} ({f.typeLabel})</option>)}
                    </select>
                    {c.state === "unpaired" && c.id.startsWith("__name_") ? <Note>Names kept as text land here once the board has a Text field named {c.title}.</Note> : c.state === "unpaired" ? <p className="mt-1 text-[15px]"><Mark kind="flag" /> Choose a field or Don’t carry before moving.</p> : null}
                    {target && (target.type === "STATUS" || target.type === "TAG") && c.labels.length ? (
                      <details className="mt-1 text-[15px]">
                        <summary className="cursor-pointer">Labels ({c.labels.length})</summary>
                        <ul className="mt-1 flex flex-col gap-1">
                          {c.labels.map((label) => (
                            <li key={label} className="flex flex-wrap items-center gap-2">
                              <span>{label} →</span>
                              <select aria-label={`${c.title} label ${label}`} className={fieldClass} value={c.labelMap[label] ?? label} disabled={save.isPending}
                                onChange={(e) => save.mutate({ migrationId, mondayBoardId: board.mondayBoardId, columnId: c.id, choice: { kind: "field", key: target.key }, labels: { ...c.labelMap, [label]: e.target.value } })}>
                                {[...new Set([label, ...target.labels])].map((l) => <option key={l} value={l}>{l === label ? `${l} (same name)` : l}</option>)}
                              </select>
                            </li>
                          ))}
                        </ul>
                      </details>
                    ) : null}
                  </Cell>
                </Row>
              );
            })}
          </Grid>
        </div>
      ))}
    </div>
  );
}

export function EraseMigration({ params }: { params: Promise<{ id: string }> }) {
  const migrationId = useMigrationId(params);
  return <EraseBlock migrationId={migrationId} onErased={() => window.location.replace("/")} />;
}

export function EraseBlock({ migrationId, onErased }: { migrationId: number; onErased: () => void }) {
  const trpc = useTRPC();
  const got = useQuery(trpc.connection.get.queryOptions({ migrationId }));
  const discovered = useQuery(trpc.discovery.manifest.queryOptions({ migrationId }));
  const catalog = useQuery({ ...trpc.discovery.catalog.queryOptions({ migrationId }), enabled: false });
  const [typed, setTyped] = useState("");
  const forget = useMutation(trpc.connection.forget.mutationOptions({ onSuccess: onErased }));
  const phrase = erasePhrase(migrationId);
  const m = got.data?.migration ?? null;
  const confirmation = confirmationState(m ? phrase : null, typed, forget.isPending);
  const spaceId = m?.plakySpaceId ?? discovered.data?.spaceId ?? null;
  const spaceTitle = catalog.data?.spaces.find((s) => s.id === spaceId)?.title;
  const space = spaceId === null ? "none chosen yet" : spaceTitle ? `${spaceTitle} (#${spaceId})` : `Space #${spaceId}`;
  const boards = discovered.data ? (discovered.data.manifest ? plural(discovered.data.manifest.boards.length, "board") + " read from monday" : "No boards read yet") : "Reading…";
  return (
    <Block level={1} title="Erase this migration’s data" testId="erase">
      <p>Erases this migration’s local records and logs. Save the report first. monday, Plaky and other migrations stay unchanged.</p>
      <Problem error={got.error} title="Could not read this migration" />
      <Problem error={discovered.error} title="Could not read this migration's boards" />
      {m === null || !got.data ? (got.isPending ? <Note>Reading…</Note> : null) : (
        <>
          <dl className="grid max-w-[640px] grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-1 rounded border border-cake-line bg-cake-grey-50 px-4 py-3 text-[15px]" data-testid="erase-scope">
            <dt className="text-cake-muted">Migration</dt><dd className="[overflow-wrap:anywhere]"><strong>Migration #{migrationId}</strong>, {m.name}</dd>
            <dt className="text-cake-muted">Connected as</dt><dd>monday account {got.data.connection.account}, Plaky user #{got.data.connection.plakyUserId}</dd>
            <dt className="text-cake-muted">Plaky Space</dt><dd className="[overflow-wrap:anywhere]">{space}</dd>
            <dt className="text-cake-muted">Boards</dt><dd>{boards}</dd>
            <dt className="text-cake-muted">Last changed</dt><dd>{clock(new Date(m.updatedAt).getTime(), undefined, true)}</dd>
          </dl>
          <label className="flex max-w-[520px] flex-col gap-1.5">
            <span>Type <strong>{phrase}</strong> to confirm</span>
            <input value={typed} onChange={(e) => setTyped(e.target.value)} aria-label="Confirmation phrase" autoComplete="off" spellCheck={false} className={fieldClass} />
          </label>
          <div>
            <Danger disabled={confirmation !== "confirmed"} onClick={() => forget.mutate({ migrationId, confirm: typed })}>
              {forget.isPending ? "Erasing…" : `Erase migration #${migrationId}`}
            </Danger>
          </div>
        </>
      )}
      <Problem error={forget.error} title="Could not erase" />
    </Block>
  );
}
