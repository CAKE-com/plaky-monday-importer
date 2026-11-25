"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { Fragment, useCallback, useId, useRef, useState, useSyncExternalStore } from "react";
import { label } from "@/lib/people-entry";
import { ANY_ORDER, IMPORT_STEPS, INSTRUCTIONS_FILE, ONCE, instructionsText, typeLines, type SeedBoard } from "@/lib/seed-steps";
import { costSentence, dailyLimit, discoverCalls } from "@/lib/monday-budget";
import { useTRPC } from "@/lib/trpc";
import { zip } from "@/lib/zip";
import { Block, Cell, Details, Explain, Go, Grid, Mark, Note, Plain, plural, Problem, Quiet, Row, Section, Status } from "./bits";
import { fieldClass } from "./bits";
import { useSave } from "./use-save";
import { SetupWatch, setupReadiness, type ScanCause } from "./setup-state";
import { SearchSelect } from "./search-select";
import { useClock } from "./subscriptions";

const WATCH_MS = 30_000;
const WATCH_SLOW_MS = 120_000;
const CSV = "text/csv;charset=utf-8";
const MAX_BOARDS = 500;

type Subitems = "board" | "nested";
type Options = { syncComments: boolean; syncFiles: boolean; syncSubscribers: boolean; withCreated: boolean; withLink: boolean; subitems: Subitems };
const SUBITEMS_CHOICES: readonly { value: Subitems; label: string }[] = [
  { value: "board", label: "Subitems: separate board" },
  { value: "nested", label: "Subitems: nested under the parent. Fields are shared; deeper levels use separate boards." },
];

export function BoardsSection({ migrationId, linked, onLinked, watchMs }: { migrationId: number; linked: boolean; onLinked: () => void; watchMs?: number }) {
  const trpc = useTRPC();
  const saved = useQuery({ ...trpc.discovery.manifest.queryOptions({ migrationId }), staleTime: 5_000 });
  const [navigation, setNavigation] = useState<"current" | "picking" | "repairing">("current");
  const seedFailures = saved.data?.seedFailures ?? [];
  const queryClient = useQueryClient();
  const dismiss = useMutation(trpc.link.dismissSeedFailures.mutationOptions({ onSuccess: async () => {
    const key = trpc.discovery.manifest.queryKey({ migrationId });
    await queryClient.cancelQueries({ queryKey: key });
    queryClient.setQueryData(key, (old) => (old ? { ...old, seedFailures: [] } : old));
  } }));
  const manifest = saved.data?.manifest ?? null;
  if (linked && navigation === "repairing") {
    return (
      <Section migrationId={migrationId} n={2} title="Set up boards" state="open">
        <Destination migrationId={migrationId} spaceId={saved.data?.spaceId ?? null} />
        <Note>Import the deleted board’s setup file, then link it again.</Note>
        {manifest ? (
          <Setup key={migrationId} migrationId={migrationId} items={new Map(manifest.boards.map((b) => [b.id, b.items]))} again onLinked={() => { setNavigation("current"); onLinked(); }} onChoose={() => undefined} watchMs={watchMs} />
        ) : <Note>Reading…</Note>}
        <div><Quiet onClick={() => setNavigation("current")}>Back</Quiet></div>
      </Section>
    );
  }
  if (linked) {
    const boards = manifest?.boards ?? [];
    const setUp = setUpBoards(boards, true);
    const items = setUp.reduce((n, b) => n + b.items, 0);
    const notSetUp = boards.filter((b) => !setUp.includes(b)).map((b) => b.name);
    const counted = setUp.length === boards.length ? `${plural(boards.length, "board")} set up in Plaky` : `${setUp.length} of ${plural(boards.length, "board")} set up in Plaky (not set up: ${notSetUp.join(", ")})`;
    return (
      <>
        <Section migrationId={migrationId}
          n={2} title="Set up boards" state="closed"
          summary={<>{manifest ? `${counted} · ${plural(items, "item")}` : "set up in Plaky"}<PeopleLine migrationId={migrationId} /></>}
        />
        <Problem error={saved.error} title="Could not read this migration's boards" />
        <Details title="Board recovery" className="mb-4 print:hidden"><p>Destination board deleted?</p><div><Quiet onClick={() => setNavigation("repairing")}>Set up a deleted board again</Quiet></div></Details>
        {seedFailures.length ? (
          <div className="mb-4 flex flex-col gap-1.5 rounded border border-cake-line bg-white px-6 py-4" data-testid="seed-failures">
            <p className="flex items-start gap-2"><span className="pt-1"><Mark kind="flag" /></span><strong className="font-medium">{plural(seedFailures.length, "imported example row")} could not be deleted from Plaky. Delete {seedFailures.length === 1 ? "it" : "them"} by hand:</strong></p>
            <ul className="ml-6 flex flex-col gap-1 text-[15px]">{seedFailures.map((f, i) => <li key={`${i}:${f}`}><Explain text={f} /></li>)}</ul>
            <div><Quiet onClick={() => dismiss.mutate({ migrationId })} disabled={dismiss.isPending}>Done, I deleted {seedFailures.length === 1 ? "it" : "them"}</Quiet></div>
            <Problem error={dismiss.error} title="Could not save that" />
          </div>
        ) : null}
      </>
    );
  }
  return (
    <Section migrationId={migrationId} n={2} title="Set up boards" state="open">
      <Problem error={saved.error} title="Could not read this migration" />
      {saved.isPending ? <Note>Reading…</Note> : !manifest || navigation === "picking" ? (
        <Picker migrationId={migrationId} saved={saved.data ?? null} onRead={() => { setNavigation("current"); void saved.refetch(); }} onSplit={() => void saved.refetch()} />
      ) : (
        <><Destination migrationId={migrationId} spaceId={saved.data?.spaceId ?? null} />
        <Setup key={migrationId} migrationId={migrationId} items={new Map(manifest.boards.map((b) => [b.id, b.items]))} onLinked={onLinked} onChoose={() => setNavigation("picking")} watchMs={watchMs} /></>
      )}
    </Section>
  );
}

function Destination({ migrationId, spaceId }: { migrationId: number; spaceId: number | null }) {
  const trpc = useTRPC();
  const stored = useQuery(trpc.connection.get.queryOptions({ migrationId }));
  const env = useQuery(trpc.connection.env.queryOptions());
  const catalog = useQuery({ ...trpc.discovery.catalog.queryOptions({ migrationId }), enabled: false });
  if (spaceId === null) return null;
  const connection = stored.data?.connection;
  const base = connection ? connection.plakyWebBase ?? (connection.typedPlakyKey ? null : env.data?.plakyWebBase ?? null) : null;
  const name = catalog.data?.spaces.find(s => s.id === spaceId)?.title;
  const label = name ? `${name} (#${spaceId})` : `Space #${spaceId}`;
  return <div className="rounded-md border border-cake-brand-100 bg-cake-brand-50 p-3 text-sm" data-testid="setup-destination">
    <p>Destination Plaky Space: <strong>{base ? <a href={`${base}/spaces/${spaceId}`} target="_blank" rel="noreferrer">{label}</a> : label}</strong></p>
    {!base ? <p>Use the Plaky workspace connected above.</p> : null}
  </div>;
}

type Saved = { spaceId: number | null; options: Options; selected: string[]; pick?: string[] | null; draft?: { boards: string[]; spaceId: number | null; options?: Options | undefined } | null };
type DraftInput = { migrationId: number; boards: string[]; spaceId: number | null; options?: Options };
type Space = { id: number; title: string; defaultSpace: boolean; closed: boolean };

function spaceOptions(spaces: readonly Space[]): { id: number; label: string }[] {
  const count = new Map<string, number>();
  for (const s of spaces) count.set(s.title, (count.get(s.title) ?? 0) + 1);
  return [...spaces]
    .sort((a, b) => Number(b.defaultSpace) - Number(a.defaultSpace) || a.title.localeCompare(b.title, undefined, { sensitivity: "base" }) || a.id - b.id)
    .map((s) => ({ id: s.id, label: `${s.title}${(count.get(s.title) ?? 0) > 1 ? ` (#${s.id})` : ""}${s.closed ? " (closed)" : ""}${s.defaultSpace ? " (default)" : ""}` }));
}

function Picker({ migrationId, saved, onRead, onSplit = () => undefined }: { migrationId: number; saved: Saved | null; onRead: () => void; onSplit?: () => void }) {
  const trpc = useTRPC();
  const spaceFieldId = useId();
  const catalog = useQuery(trpc.discovery.catalog.queryOptions({ migrationId }));
  const [picked, setPicked] = useState<Set<string> | undefined>();
  const [space, setSpace] = useState<number | undefined>();
  const [opts, setOpts] = useState<Partial<Options>>({});
  const read = useMutation(trpc.discovery.run.mutationOptions({ onSuccess: onRead }));
  const today = useQuery({ ...trpc.plan.latest.queryOptions({ migrationId }), staleTime: 5_000 });
  const boards = (catalog.data?.boards ?? []).filter((b) => b.selectable).sort((a, b) => a.workspace.localeCompare(b.workspace));
  const outside = new Map<string, string[]>();
  for (const b of catalog.data?.boards ?? []) {
    if (b.selectable || b.kind === "sub_items_board") continue;
    const why = b.why ?? "not a board";
    outside.set(why, [...(outside.get(why) ?? []), b.name]);
  }
  const known = new Set(boards.map((b) => b.id));
  const selected = picked ?? new Set((saved?.draft?.boards ?? (saved?.selected.length ? saved.selected : (saved?.pick ?? (boards.length > MAX_BOARDS ? [] : boards.map((b) => b.id))))).filter((id) => known.has(id)));
  const workspaces = [...new Set(boards.map((b) => b.workspace))];
  const split = useMutation(trpc.discovery.split.mutationOptions({ onSuccess: () => { setPicked(undefined); onSplit(); } }));
  const spaces = spaceOptions(catalog.data?.spaces ?? []);
  const listed = (id: number | null | undefined): number | undefined => (spaces.some((s) => s.id === id) ? (id ?? undefined) : undefined);
  const decided = space !== undefined || saved?.draft != null || (saved?.selected.length ?? 0) > 0;
  const storedSpace = saved?.draft ? saved.draft.spaceId : (saved?.spaceId ?? null);
  const wanted = space ?? storedSpace;
  const spaceId = listed(wanted) ?? (decided ? undefined : spaces[0]?.id);
  const spaceGone = catalog.data !== undefined && spaces.length > 0 && spaceId === undefined;
  const spaceLabel = spaces.find((s) => s.id === spaceId)?.label;
  const draft = useMutation(trpc.discovery.draft.mutationOptions());
  const saving = useRef<{ busy: boolean; next: DraftInput | null }>({ busy: false, next: null });
  const send = (input: DraftInput): void => {
    const queue = saving.current;
    if (queue.busy) {
      queue.next = input;
      return;
    }
    queue.busy = true;
    void draft.mutateAsync(input).catch(() => undefined).finally(() => {
      queue.busy = false;
      const next = queue.next;
      queue.next = null;
      if (next) send(next);
    });
  };
  const keep = (boardIds: ReadonlySet<string>, chosen: number | undefined, options: Options | undefined = Object.keys(opts).length ? o : undefined): void => {
    if (boardIds.size <= MAX_BOARDS) send({ migrationId, boards: [...boardIds], spaceId: chosen ?? null, ...(options ? { options } : {}) });
  };
  const first = !saved?.selected.length;
  const held = saved?.draft?.options;
  const o: Options = {
    syncComments: opts.syncComments ?? held?.syncComments ?? (first ? true : saved.options.syncComments), syncFiles: opts.syncFiles ?? held?.syncFiles ?? (first ? true : saved.options.syncFiles),
    syncSubscribers: opts.syncSubscribers ?? held?.syncSubscribers ?? saved?.options.syncSubscribers ?? false, withCreated: opts.withCreated ?? held?.withCreated ?? saved?.options.withCreated ?? true,
    withLink: opts.withLink ?? held?.withLink ?? saved?.options.withLink ?? true, subitems: opts.subitems ?? held?.subitems ?? saved?.options.subitems ?? "board",
  };
  const choose = (change: Partial<Options>): void => {
    if (!catalog.data) return;
    setOpts({ ...opts, ...change });
    keep(selected, spaceId, { ...o, ...change });
  };
  const pick = (next: Set<string>): void => { setPicked(next); keep(next, spaceId); };
  const toggle = (id: string, on: boolean): void => {
    const next = new Set(selected);
    if (on) next.add(id);
    else next.delete(id);
    pick(next);
  };
  const over = selected.size > MAX_BOARDS;
  const items = boards.filter((b) => selected.has(b.id)).reduce((n, b) => n + b.items, 0);
  const cost = discoverCalls(boards.filter((b) => selected.has(b.id)).map((b) => b.items));
  const option = (key: Exclude<keyof Options, "subitems">, label: string) => (
    <label className="flex min-h-10 items-center gap-2"><input type="checkbox" className="size-[18px] accent-cake-brand-500" checked={o[key]} disabled={!catalog.data} onChange={(e) => choose({ [key]: e.target.checked })} />{label}</label>
  );
  return (
    <>
      <Note>Select boards to move. Subitems follow their board.</Note>
      <Problem error={catalog.error} title="Could not list the boards" />
      {boards.length ? (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <Plain onClick={() => pick(new Set(boards.map((b) => b.id)))}>Select all</Plain>
          <Plain onClick={() => pick(new Set())} disabled={!selected.size}>Clear</Plain>
          <span className="text-sm" data-testid="board-count">{selected.size} of max {MAX_BOARDS} boards selected{over ? `. Deselect ${plural(selected.size - MAX_BOARDS, "board")} to read.` : ""}</span>
        </div>
      ) : null}
      {catalog.isPending ? <Note>Reading the monday account…</Note> : (
        <Grid head={["Board", "Items"]} align={["left", "right"]} testId="pick-boards" label="Boards to move">
          {boards.map((b, at) => (
            <Fragment key={b.id}>
            {workspaces.length > 1 && boards[at - 1]?.workspace !== b.workspace ? (
              <Row><Cell><strong data-testid="workspace-heading">{b.workspace}</strong></Cell><Cell right>{""}</Cell></Row>
            ) : null}
            <Row>
              <Cell>
                <label className="flex items-start gap-2.5">
                  <input type="checkbox" className="mt-1 size-[18px] flex-none accent-cake-brand-500" checked={selected.has(b.id)} onChange={(e) => toggle(b.id, e.target.checked)} />
                  <span>
                    {b.name}
                    {b.folder ? <span className="ml-2 text-[15px] text-cake-muted">in {b.folder}</span> : null}
                    {b.privacy ? <span className="block text-[15px] text-cake-muted" data-testid={`privacy-${b.id}`}>{b.privacy}. Set access in Plaky after import.</span> : null}
                  </span>
                </label>
              </Cell>
              <Cell right>{b.items}</Cell>
            </Row>
            </Fragment>
          ))}
        </Grid>
      )}
      {(workspaces.length > 1 && !saved?.pick && !saved?.selected.length) || split.data ? (
        <Block title={`These boards are in ${workspaces.length} workspaces`} testId="split">
          <Note>Optional: create a separate migration for each monday workspace.</Note>
          {split.data ? (
            <ul className="flex flex-col gap-1" data-testid="split-done">
              {split.data.migrations.map((m) => <li key={m.migrationId}><Link prefetch={false} href={`/migrations/${m.migrationId}`}>{m.workspace} ({plural(m.boards, "board")})</Link>{m.migrationId === migrationId ? " — this migration" : ""}</li>)}
            </ul>
          ) : <div><Plain onClick={() => split.mutate({ migrationId })} disabled={split.isPending}>{split.isPending ? "Splitting…" : "Make one migration per workspace"}</Plain></div>}
          <Problem error={split.error} title="Could not split" />
        </Block>
      ) : null}
      {outside.size ? (
        <p className="text-[15px] text-cake-muted" data-testid="pick-outside">Not moved: {[...outside].map(([why, names]) => `${names.join(", ")} (${why})`).join("; ")}.</p>
      ) : null}
      {catalog.isPending ? null : (
        <>
          {spaceGone ? <div data-testid="space-gone" role="status"><Note>{wanted === null ? "Choose a Plaky Space to continue." : "The Plaky Space saved for this migration is no longer in Plaky. Choose a Space to continue."}</Note></div> : null}
          <div className="flex w-full min-w-0 flex-col gap-2">
            <label htmlFor={spaceFieldId}>Destination Plaky Space</label>
            <select id={spaceFieldId} aria-label="Destination Plaky Space" className={`${fieldClass} w-full min-w-0 max-w-full truncate`} value={String(spaceId ?? "")}
              onChange={(e) => { const id = Number(e.target.value); setSpace(id); keep(selected, id); }}>
              {spaceId === undefined ? <option value="" disabled>Choose a Space</option> : null}
              {spaces.map((s) => <option key={s.id} value={String(s.id)}>{s.label}</option>)}
            </select>
          </div>
        </>
      )}
      <div><Quiet onClick={() => void catalog.refetch()} disabled={catalog.isFetching || read.isPending}>{catalog.isFetching ? "Refreshing boards and Spaces…" : "Refresh boards and Spaces"}</Quiet></div>
      <details>
        <summary className="min-h-8 cursor-pointer">Comments, files and other options</summary>
        <div className="mt-2 grid gap-x-6 sm:grid-cols-2">
          {option("syncComments", "Updates, as comments")}
          {option("syncFiles", "Files")}
          {option("syncSubscribers", "Item followers")}
          {option("withCreated", "Original creator and date")}
          {option("withLink", "Link to monday")}
        </div>
        <div className="mt-2 flex flex-col gap-1" role="radiogroup" aria-label="Subitems" data-testid="subitems">
          {SUBITEMS_CHOICES.map((c) => (
            <label key={c.value} className="flex min-h-10 items-start gap-2">
              <input type="radio" name="subitems" value={c.value} className="mt-1 size-[18px] flex-none accent-cake-brand-500" checked={o.subitems === c.value} disabled={!catalog.data} onChange={() => choose({ subitems: c.value })} />
              {c.label}
            </label>
          ))}
        </div>
      </details>
      {catalog.isPending ? null : (
        <div className="flex flex-wrap items-center gap-5">
          <Go disabled={read.isPending || draft.isPending || !spaceId || selected.size === 0 || over} onClick={() => read.mutate({ migrationId, boardIds: [...selected], spaceId: spaceId!, options: o })}>
            {read.isPending ? "Reading the boards…" : `Read ${plural(selected.size, "board")}`}
          </Go>
          <Note><span data-testid="read-destination">{spaceLabel ? `Boards go to ${spaceLabel}.` : "Choose a Plaky Space first."}</span> {plural(items, "item")}. <span data-testid="read-cost">{costSentence(cost, today.data?.mondayCallsToday ?? null, today.data?.mondayLimit ?? dailyLimit(null))}</span></Note>
        </div>
      )}
      <Problem error={read.error} title="Could not read the boards" />
      <Problem error={draft.error} title="Could not save your selection" />
    </>
  );
}

type Scanned = { preview?: Parameters<typeof setupReadiness>[0]; readiness?: readonly { key: string; done: boolean }[] };

function tagsToConvert<I extends { key: string; done: boolean }>(readiness: readonly I[] | undefined): I[] {
  return (readiness ?? []).filter((i) => i.key.endsWith(":status-types") && !i.done);
}

const idle = (): null => null;

function usePlakyWatch(scan: (input: { migrationId: number; background?: boolean }, cause: ScanCause) => void, migrationId: number, everyMs: number): void {
  const watching = useCallback(() => {
    scan({ migrationId }, "open");
    const timer = setInterval(() => scan({ migrationId, background: true }, "timer"), everyMs);
    const back = (): void => scan({ migrationId, background: true }, "focus");
    document.addEventListener("visibilitychange", back);
    window.addEventListener("focus", back);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", back);
      window.removeEventListener("focus", back);
    };
  }, [scan, migrationId, everyMs]);
  useSyncExternalStore(watching, idle, idle);
}

const STATE_TEXT: Record<string, string> = { active: "active in monday", pending: "invited in monday, not joined", inactive: "deactivated in monday", team: "a team in monday" };

function Setup({ migrationId, items, onLinked, onChoose, again = false, watchMs = WATCH_MS }: { migrationId: number; items: ReadonlyMap<string, number>; onLinked: () => void; onChoose: () => void; again?: boolean; watchMs?: number | undefined }) {
  const trpc = useTRPC();
  const download = useSave();
  const [watch] = useState(() => new SetupWatch());
  const wake = (): void => watch.wake(Date.now());
  const save: typeof download.save = (name, body, type) => { wake(); download.save(name, body, type); };
  const guide = useQuery(trpc.provision.guide.queryOptions({ migrationId }));
  const detect = useMutation(trpc.provision.detect.mutationOptions({ onSettled: (_data, error): void => {
    watch.scanned(!error);
    if (watch.pendingScan) scan({ migrationId });
  } }));
  const commit = useMutation(trpc.link.commit.mutationOptions({
    onSuccess: (r) => { if (r.status === "linked") onLinked(); },
    onSettled: (result): void => {
      watch.linked();
      if (result?.status !== "linked" && watch.pendingScan) scan({ migrationId });
    },
  }));
  const { mutate: detectBoards } = detect;
  const { mutate: commitBoards } = commit;
  const linkWhenReady = useCallback((scanned: Scanned | undefined): void => {
    if (again || !scanned || setupReadiness(scanned.preview, watch.tagsKept, tagsToConvert(scanned.readiness).length) !== "ready") return;
    if (watch.link(true)) commitBoards({ migrationId, force: false });
  }, [again, watch, commitBoards, migrationId]);
  const scan = useCallback((input: { migrationId: number; background?: boolean }, cause: ScanCause = "manual"): void => {
    if (watch.scan(cause, Date.now(), document.hidden)) detectBoards(input, { onSuccess: linkWhenReady });
  }, [watch, detectBoards, linkWhenReady]);
  const link = useCallback((input: { migrationId: number; force: boolean }) => {
    if (watch.link(false)) commitBoards(input);
  }, [watch, commitBoards]);
  const preview = detect.data?.preview;
  const found = new Set((preview?.links ?? []).map((l) => l.mondayBoardId));
  const stillCalled = new Map((preview?.links ?? []).flatMap((l) => (typeof l.plakyTitle === "string" && l.plakyTitle.trim() !== l.name.trim() ? [[l.mondayBoardId, l.plakyTitle.trim() || "New board"] as const] : [])));
  const boards = guide.data?.boards ?? [];
  const allFound = boards.length > 0 && boards.every((b) => found.has(b.id));

  const slow = watch.pace === "slow";
  usePlakyWatch(scan, migrationId, slow ? (watchMs === WATCH_MS ? WATCH_SLOW_MS : watchMs * 4) : watchMs);
  const checkedAt = detect.isSuccess ? detect.submittedAt : null;
  const now = useClock(1_000);

  const [keepTags, setKeepTags] = useState(false);
  const asTag = tagsToConvert(detect.data?.readiness);
  const readiness = setupReadiness(preview, keepTags, asTag.length);
  const clear = readiness === "ready";
  const keepAsTag = (): void => {
    watch.keepTags();
    setKeepTags(true);
    linkWhenReady(detect.isSuccess ? detect.data : undefined);
  };
  const waiting = allFound && !clear && !commit.isPending;
  const linkError = commit.error && !(detect.isSuccess && detect.submittedAt > commit.submittedAt) ? commit.error : null;
  const fixes = new Map((preview?.links ?? []).map((l) => [l.mondayBoardId, l.unmatched]));
  const listed = new Set([...fixes.values()].flat());
  const elsewhere = (preview?.blocking ?? []).filter((b) => !listed.has(b));

  const gone = new Set((preview?.gone ?? []).map((g) => g.id));
  const hints = new Map<string, string[]>();
  for (const h of preview?.hints ?? []) hints.set(h.id, [...(hints.get(h.id) ?? []), h.text]);
  const movedBefore = (preview?.hints ?? []).some((h) => h.kind === "moved-before");
  const offered = (b: (typeof boards)[number]): boolean => Boolean(b.fileName && b.csv && (!b.linked || gone.has(b.id)));
  const todo = boards.filter((b) => !found.has(b.id) && !hints.has(b.id) && offered(b));
  const withFile = boards.filter(offered).length;
  const scanned = Boolean(detect.data || detect.error);
  const downloadAll = (): void => {
    const only = todo.length === 1 ? todo[0]! : null;
    if (only) save(only.fileName!, () => only.csv!, CSV);
    else save(`plaky-boards-${migrationId}.zip`, () => zip([...todo.map((b) => ({ name: b.fileName!, text: b.csv! })), { name: INSTRUCTIONS_FILE, text: instructionsText(todo) }]), "application/zip");
  };

  return (
    <>
      <Note>Import the setup files in Plaky. Items and attachments move afterward.</Note>
      <Problem error={guide.error} title="Could not read the boards" />
      <Problem error={download.error} title="Could not save the file" />
      {todo.length ? (
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2" data-testid="download-all">
          <Go disabled={!scanned} onClick={downloadAll}>
            {!scanned ? "Checking Plaky first…" : todo.length === 1 ? `Download ${todo[0]!.fileName}`
              : todo.length === withFile ? `Download all ${todo.length} files (.zip)` : `Download the ${todo.length} files still to import (.zip)`}
          </Go>

        </div>
      ) : null}
      {todo.length ? (
        <Block title={todo.length === 1 ? "Then, in Plaky" : "Then, for each file, in Plaky"} testId="setup-steps">
          <ol className="flex list-decimal flex-col gap-2 pl-5">{IMPORT_STEPS.map((s) => <li key={s}>{s}</li>)}</ol>
          <Note>{todo.length > 1 ? `${ANY_ORDER} ${ONCE}` : ONCE}</Note>
        </Block>
      ) : null}
      <Grid head={["Board", "Items", "In Plaky"]} align={["left", "right", "left"]} testId="setup-boards">
        {boards.map((b) => (
          <Row key={b.id}>
            <Cell>{b.name}</Cell>
            <Cell right>{items.get(b.id) ?? ""}</Cell>
            <Cell>
              {fixes.get(b.id)?.length ? <Status kind="flag"><strong>Needs a fix</strong></Status>
                : found.has(b.id) && stillCalled.has(b.id) ? <Status kind="now"><strong>Rename “{stillCalled.get(b.id)}” to “{b.name}”</strong></Status>
                : found.has(b.id) ? <Status kind="done">Found</Status> : gone.has(b.id) ? <Status kind="now"><strong>Deleted in Plaky: import again</strong></Status>
                  : hints.has(b.id) ? <Status kind="flag"><strong>In Plaky already?</strong></Status>
                  : offered(b) ? <Status kind="now"><strong>To import</strong></Status> : <Status kind="next">{b.linked ? "Linked" : "Comes with its board"}</Status>}
              {fixes.get(b.id)?.length ? <ul className="mt-1.5 flex flex-col gap-1 text-[15px]">{fixes.get(b.id)!.map((f, i) => <li key={`${i}:${f}`}><Explain text={f} /></li>)}</ul> : null}
              {hints.has(b.id) ? <ul className="mt-1.5 flex flex-col gap-1 text-[15px]" data-testid={`hint-${b.id}`}>{hints.get(b.id)!.map((h) => <li key={h}>{h}.</li>)}</ul> : null}
            </Cell>
          </Row>
        ))}
      </Grid>

      {todo.map((b) => <BoardTypes key={b.id} board={b} save={save} />)}

      <PeopleChoices migrationId={migrationId} linked={false} onChanged={() => scan({ migrationId })} />

      {asTag.length && !keepTags ? (
        <Block title="Convert to Status before linking" testId="as-tag">
          {asTag.map((i) => <div key={i.key} className="flex items-start gap-2"><span className="pt-1"><Mark kind="now" /></span><div><strong>{boards.find((b) => b.id === i.board)?.name ?? i.board}:</strong> <Explain text={i.text} /></div></div>)}
          <Note>Change the type before linking. This page checks automatically.</Note>
          <div><Plain onClick={keepAsTag}>Keep it as Tag and link</Plain></div>
        </Block>
      ) : null}
      {(preview?.links ?? []).flatMap((l) => l.warnings.map((w) => `${l.name}: ${w}`)).map((w, i) => <div key={`${i}:${w}`} className="text-sm text-cake-muted"><Explain text={w} /></div>)}

      {elsewhere.length ? (
        <ul className="flex flex-col gap-1.5" data-testid="blocking">
          {elsewhere.map((b, i) => <li key={`${i}:${b}`} className="flex items-start gap-2"><span className="pt-1"><Mark kind="flag" /></span><div><Explain text={b} /></div></li>)}
        </ul>
      ) : null}
      {commit.data?.status === "blocked" ? commit.data.blocking.map((b, i) => <div key={`${i}:${b}`} className="flex items-start gap-2"><span className="pt-1"><Mark kind="flag" /></span><div><Explain text={b} /></div></div>) : null}
      {movedBefore ? (
        <div className="flex flex-wrap items-center gap-4" data-testid="link-existing">
          <span>Existing boards found. Link them instead of importing again.</span>
          <Plain onClick={() => link({ migrationId, force: false })} disabled={commit.isPending || detect.isPending}>Link with the boards in Plaky</Plain>
        </div>
      ) : null}
      {commit.data?.status === "confirm" || preview?.needsConfirm ? (
        <div className="flex flex-wrap items-center gap-4" data-testid="confirm-relink">
          <span>This replaces earlier board links and may redirect later updates.</span>
          <Plain onClick={() => link({ migrationId, force: true })} disabled={commit.isPending || detect.isPending}>Link anyway</Plain>
        </div>
      ) : null}
      <Problem error={linkError} title="Could not link" />
      <Problem error={detect.error} title="Could not check Plaky" />

      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-[15px]" data-testid="watch">
        <Mark kind={allFound && !waiting ? "done" : "now"} />
        <span role="status">
          {commit.isPending ? "Linking the boards…" : again && allFound && !preview?.needsConfirm ? `All boards are still in Plaky.` : waiting
            ? `All ${plural(boards.length, "board")} found. Fix the issues above to link.`
            : allFound ? `All ${plural(boards.length, "board")} found in Plaky.`
              : `Checking Plaky automatically. ${found.size} of ${plural(boards.length, "board")} found.`}
        </span>
        {checkedAt !== null && !detect.isPending ? <span className="text-cake-muted" data-testid="last-checked">Last checked {agoText(now - checkedAt)}.</span> : null}
        <Quiet onClick={() => { wake(); scan({ migrationId }); }} disabled={detect.isPending || commit.isPending}>{detect.isPending ? "Checking…" : "Check now"}</Quiet>
        {again ? null : <Quiet onClick={onChoose}>Choose other boards</Quiet>}
      </div>
    </>
  );
}


export function setUpBoards<B extends { plakyBoardId: number | null; nested: boolean }>(boards: readonly B[], linked: boolean): B[] {
  return boards.filter((b) => !linked || b.plakyBoardId !== null || b.nested);
}

export function agoText(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1_000));
  return s < 60 ? `${s} s ago` : `${Math.floor(s / 60)} min ago`;
}

function BoardTypes({ board, save }: { board: SeedBoard; save: ReturnType<typeof useSave>["save"] }) {
  const lines = typeLines(board.checklist).filter((line) => line.typeLabel && line.typeLabel !== "Text");
  const textFields = board.checklist.filter((field) => field.typeLabel === "Text").length;
  return (
    <Block title={board.name} testId={`setup-board-${board.id}`}>
      <p className="text-[15px]">
        <button type="button" className="text-left text-cake-brand-550 underline underline-offset-3" onClick={() => save(board.fileName!, () => board.csv!, CSV)}>{board.fileName}</button>
        {" "}→ rename “New board” to <strong>“{board.name}”</strong>
      </p>
      <div>
        <p>Name stays Item names. Leave {plural(textFields, "field")} as Text, including Monday ID.</p>
        {lines.length ? <p className="mt-2">Use <strong>Create New Field</strong> for:</p> : null}
        <ol className="mt-2.5 text-[15px]" data-testid={`types-${board.id}`}>
          {lines.map((l) => (
            <li key={l.field} className="flex flex-wrap gap-x-2 border-t border-cake-line py-1.5">
              <span>{l.field} → {l.master ? <strong>{l.typeLabel}</strong> : l.typeLabel}{l.typeLabel === "Link" ? " (scroll the menu)" : ""}</span>
            </li>
          ))}
        </ol>
      </div>
      {board.lossy?.length ? (
        <details className="text-[15px]" data-testid={`lossy-${board.id}`}><summary className="cursor-pointer">Conversions</summary>
          <ul className="ml-5 list-disc">{board.lossy.map((l) => <li key={l}>{l}</li>)}</ul>
        </details>
      ) : null}
    </Block>
  );
}

function PeopleLine({ migrationId }: { migrationId: number }) {
  const trpc = useTRPC();
  const people = useQuery(trpc.people.list.queryOptions({ migrationId }));
  const rows = people.data?.rows ?? [];
  if (people.error) return <> · people choices unavailable; reload to retry</>;
  if (!rows.length) return null;
  const count = (c: string, kind: "person" | "team"): number => rows.filter((r) => r.choice === c && r.kind === kind).length;
  const who = (c: string): string => [count(c, "person") ? plural(count(c, "person"), "person", "people") : "", count(c, "team") ? plural(count(c, "team"), "team", "teams") : ""].filter(Boolean).join(" and ");
  const persons = count("team", "person");
  const teams = count("team", "team");
  const parts = [
    who("user") ? `${who("user")} given to a Plaky user` : "",
    who("header") ? `${who("header")} with the name kept as text` : "",
    who("unassigned") ? `${who("unassigned")} left unassigned` : "",
    persons ? `${plural(persons, "person", "people")} on ${persons === 1 ? "a placeholder team" : "placeholder teams"}` : "",
    teams ? `${plural(teams, "team", "teams")} on the Plaky team of the same name` : "",
  ].filter(Boolean);
  return parts.length ? <> · {parts.join(", ")}</> : null;
}

export function PeopleChoices({ migrationId, linked, onChanged }: { migrationId: number; linked: boolean; onChanged?: () => void }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const people = useQuery(trpc.people.list.queryOptions({ migrationId }));
  const changed = () => { void people.refetch(); void queryClient.invalidateQueries(trpc.provision.guide.queryFilter({ migrationId })); onChanged?.(); };
  const choose = useMutation(trpc.people.match.mutationOptions({ onSuccess: changed }));
  const everyone = useMutation(trpc.people.matchAll.mutationOptions({ onSuccess: changed }));
  if (!people.data?.rows.length) return <Problem error={people.error} title="Could not read the people" />;
  const busy = choose.isPending || everyone.isPending;
  const hasTeams = people.data.rows.some((r) => r.kind === "team");
  return (
    <Details title="Review people and teams" testId="people">
      <Note>
        Choose how to handle unmatched people{hasTeams ? " and teams" : ""}. Names are kept as text by default.
        {linked ? " Add the name field in Plaky if it is missing." : ""} Placeholder teams must be created in Plaky.
      </Note>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-[15px]" data-testid="people-everyone">
        <span>Apply to all:</span>
        <Quiet disabled={busy} onClick={() => everyone.mutate({ migrationId, to: "header" })}>Keep names as text</Quiet>
        <Quiet disabled={busy} onClick={() => everyone.mutate({ migrationId, to: "team" })}>Use placeholder teams</Quiet>
        <Quiet disabled={busy} onClick={() => everyone.mutate({ migrationId, to: "unassigned" })}>Leave unassigned</Quiet>
      </div>
      <Grid head={[hasTeams ? "Person or team in monday" : "Person in monday", "Their tasks go to"]}>
        {people.data.rows.map((r) => {
          const value = r.choice === "user" && r.plakyUserId !== null ? String(r.plakyUserId) : r.choice;
          return (
            <Row key={r.mondayUserId}>
              <Cell>
                <span className="flex flex-col"><span>{r.name}</span><span className="text-sm text-cake-muted">{STATE_TEXT[r.state] ?? r.state}{r.email ? `, ${r.email}` : ""}{r.kind === "team" ? `, ${plural(r.members.length, "person", "people")}` : ""}</span></span>
              </Cell>
              <Cell>
                <SearchSelect label={`Who takes over ${r.name}’s tasks`} searchLabel={`Search people for ${r.name}`} searchPlaceholder="Search people" hideLabel value={value} disabled={busy}
                  options={[
                    { value: "header", label: label("header") },
                    { value: "unassigned", label: label("unassigned") },
                    { value: "team", label: label("team", { placeholder: r.placeholder ?? r.name, mustExist: linked && !r.teamExists, team: r.kind === "team" }), disabled: linked && !r.teamExists },
                    ...(r.choice === "other" ? [{ value: "other", label: label("other", { other: r.other }), disabled: true }] : []),
                    ...people.data.users.map((u) => ({ value: String(u.id), label: `${u.name}, ${u.email}` })),
                  ]}
                  onChange={(v) => choose.mutate({ migrationId, mondayUserId: r.mondayUserId, to: v === "unassigned" || v === "header" || v === "team" ? v : Number(v) })} />
                {r.choice === "team" && !r.teamExists && r.placeholder ? (
                  r.kind === "team" ? (
                    <p className="mt-2 flex items-start gap-2 text-[15px]"><Mark kind="now" /><span>In Plaky, create a team named exactly <strong>{r.placeholder}</strong>{r.members.length ? `, with its people: ${r.members.join(", ")}` : ""}.</span></p>
                  ) : (
                    <p className="mt-2 flex items-start gap-2 text-[15px]"><Mark kind="now" /><span>In Plaky, create a team named exactly <strong>{r.placeholder}</strong>, then remove yourself from it so nobody is notified.</span></p>
                  )
                ) : null}
                {r.problem ? <div className="mt-2 text-sm"><Explain text={r.problem} /></div> : null}
              </Cell>
            </Row>
          );
        })}
      </Grid>
      <Problem error={[choose.error, everyone.error]} title="Could not save that" />
      <Problem error={people.error} title="Could not read the people again, so this shows what was last read" />
    </Details>
  );
}
