import { and, eq, inArray, ne } from "drizzle-orm";
import type { Db } from "@/db/client";
import { migrationBoards, migrations } from "@/db/schema";
import { PreconditionError } from "../errors";
import { realClock, type Clock } from "../clients/http";
import type { MondayClient } from "../clients/monday";
import type { PlakyClient } from "../clients/plaky";
import type { BoardSync, PeopleMap } from "./config";
import type { SinceByBoard } from "./changes";
import { discover, mondaySource, withHandLists, withItemCounts } from "./discover";
import type { PipelineLog } from "./events";
import { extractBoard, splitLevels, type BoardExtract } from "./extract";
import { baseBoardId, isLevelEntry, levelOfEntry, levelTwoId } from "./names";
import type { ItemFilters } from "./scope";
import { boardHints, decideRelink, deleteSeeds, isReady, linkManifest, liveKeysOf, recordPairings, type RelinkDecision } from "./link";
import { applyPlans, withBoardLocks, type ApplyPlansResult, type BoardKey } from "./load";
import { keepPairings, type Manifest } from "./manifest";
import { AssetFetcher, DocAwareSource, mondayAssetUrls } from "./assets";
import { syncNameFields } from "./people-match";
import { irRows, loadDirectory, planBoards, plannedWrites, type BoardPlan } from "./plan";
import { DbLoadStore } from "./store-load";
import { readFileMap } from "./file-map";
import { accountSlug, ensureConnection, forgetPlakyBoard, getMigration, setSeedFailures, setStatusUnlessOtherRun, loadLinkConfig, loadManifest, markBoardApplied, markBoardUnapplied, saveDiscovery, saveIr, saveLinkConfig, saveManifest, setAccountSlug, setStatus } from "./store";
import { verify, type Receipt } from "./verify";
import { appliedState } from "./board-state";

type Since = string | null | SinceByBoard;

export type Deps = {
  db: Db;
  migrationId: number;
  monday: MondayClient;
  plaky: PlakyClient;
  log: PipelineLog;
  signal?: AbortSignal | undefined;
};

export class ExtractCache {
  private readonly boards = new Map<string, Promise<BoardExtract>>();
  private readonly levels = new Map<string, Promise<ReturnType<typeof splitLevels>>>();
  private scopes: Promise<{ filters: ItemFilters; parentOf: Map<string, string>; archived: boolean }> | undefined;
  constructor(
    private readonly deps: Pick<Deps, "db" | "migrationId" | "monday">,
    private readonly since: Since = null,
  ) {}
  sinceFor(board: Pick<BoardSync, "mondayBoardId"> & Partial<Pick<BoardSync, "applied">>): string | null {
    if ((board.applied !== undefined && appliedState({ applied: board.applied }) === "untouched") || this.since === null) return null;
    return typeof this.since === "string" ? this.since : (this.since.get(board.mondayBoardId) ?? null);
  }
  read = (board: Pick<BoardSync, "mondayBoardId"> & Partial<Pick<BoardSync, "applied">>): Promise<BoardExtract> => {
    let found = this.boards.get(board.mondayBoardId);
    if (!found) {
      found = this.extract(board);
      this.boards.set(board.mondayBoardId, found);
      found.catch(() => this.boards.delete(board.mondayBoardId));
    }
    return found;
  };
  private scoping(): Promise<{ filters: ItemFilters; parentOf: Map<string, string>; archived: boolean }> {
    return (this.scopes ??= (async () => {
      const { db, migrationId } = this.deps;
      const [{ options }, loaded] = await Promise.all([getMigration(db, migrationId), loadLinkConfig(db, migrationId)]);
      return { archived: options.carryArchived === true, filters: options.filters ?? {}, parentOf: new Map((loaded?.config.boards ?? []).flatMap((b) => (b.subitemsOf ? [[b.mondayBoardId, b.subitemsOf] as const] : []))) };
    })());
  }
  private async extract(board: Pick<BoardSync, "mondayBoardId"> & Partial<Pick<BoardSync, "applied">>): Promise<BoardExtract> {
    const { filters, parentOf, archived } = await this.scoping();
    const base = baseBoardId(board.mondayBoardId);
    if (parentOf.get(levelTwoId(base)) === base) {
      let read = this.levels.get(base);
      if (!read) {
        const carried = Math.max(2, ...[...parentOf.keys()].filter((id) => baseBoardId(id) === base).map(levelOfEntry));
        read = extractBoard(this.deps.monday, base, { since: null, archived, allLevels: true }).then((full) => splitLevels(full, levelTwoId(base), filters[base], carried));
        this.levels.set(base, read);
        read.catch(() => this.levels.delete(base));
      }
      const { top, second, rest } = await read;
      const level = levelOfEntry(board.mondayBoardId);
      return level === 1 ? top : level === 2 ? second : rest.get(level)!;
    }
    const filter = filters[board.mondayBoardId];
    const parent = parentOf.get(board.mondayBoardId);
    const parentFiltered = parent !== undefined && filters[parent] !== undefined;
    if (!filter && !parentFiltered) return extractBoard(this.deps.monday, board.mondayBoardId, { since: this.sinceFor(board), archived });
    const parentsOut = parentFiltered ? new Set((await this.read({ mondayBoardId: parent })).outOfScope) : undefined;
    return extractBoard(this.deps.monday, board.mondayBoardId, { since: null, archived, scope: { ...(filter ? { filter } : {}), ...(parentsOut ? { parentsOut } : {}) } });
  }
}

export type Identity = {
  connection: { mondayAccountId: string; mondayUserId: string; mondayTimeZone: string | null; plakyUserId: number; mondayAccountSlug: string | null; mondayTier: string | null; mondayAccountUid: string | null; mondayUserUid: string | null };
  account: string | null; user: string | null; zone: string | null; plakyUser: string | null;
};
export async function identify(monday: MondayClient, plaky: PlakyClient): Promise<Identity> {
  const [me, zone, user] = await Promise.all([monday.me(), monday.timeZone(), plaky.getCurrentUser()]);
  return {
    connection: {
      mondayAccountId: me.account ?? "unknown", mondayUserId: me.email ?? me.name ?? "unknown", mondayTimeZone: zone, plakyUserId: Number(user.id), mondayAccountSlug: me.slug, mondayTier: me.tier,
      mondayAccountUid: me.accountId ?? null, mondayUserUid: me.userId ?? null,
    },
    account: me.account, user: me.email ?? me.name, zone, plakyUser: user.email ?? user.name ?? null,
  };
}

export async function connect(db: Db, monday: MondayClient, plaky: PlakyClient): Promise<{ connectionId: number } & Omit<Identity, "connection">> {
  const { connection, ...who } = await identify(monday, plaky);
  return { connectionId: await ensureConnection(db, connection), ...who };
}

export async function discoverStep(deps: Deps, o: { extras?: Iterable<string>; only?: Iterable<string>; listArchived?: boolean; handLists?: boolean; setup?: Parameters<typeof saveDiscovery>[3] } = {}): Promise<Manifest> {
  const { db, migrationId, monday, plaky, log } = deps;
  const directory = await loadDirectory(plaky);
  const subitems = o.setup?.options.subitems ?? (await getMigration(db, migrationId)).options.subitems ?? "board";
  const linkedNested = ((await loadLinkConfig(db, migrationId))?.config.boards ?? []).filter((b) => b.nested && isLevelEntry(b.mondayBoardId)).map((b) => baseBoardId(b.mondayBoardId));
  let fresh = await discover({ monday: mondaySource(monday), directory }, { extras: o.extras ?? ["created", "link"], levels: true, keepNested: new Set(linkedNested), subitems, ...(o.only ? { only: o.only } : {}), ...(o.listArchived ? { listArchived: true } : {}) });
  if (o.handLists) {
    try {
      const automations = new Map<string, Awaited<ReturnType<MondayClient["boardAutomations"]>>>();
      for (const b of fresh.boards) if (b.parentBoardId === null) automations.set(b.id, await monday.boardAutomations(b.id));
      fresh = withHandLists(fresh, automations, await monday.searchDashboards());
    } catch (error) {
      log({ level: "warn", code: "discover.hand_lists_unread", message: `Could not read the boards' automations or the dashboards (${error instanceof Error ? error.message : String(error)}); check them in monday by hand.` });
    }
  }
  if (o.handLists) {
    try {
      fresh = await withItemCounts(fresh, monday);
    } catch (error) {
      log({ level: "warn", code: "discover.archived_unread", message: `Could not count the archived items (${error instanceof Error ? error.message : String(error)}); check monday's archive by hand.` });
    }
  }
  const previous = await loadManifest(db, migrationId);
  const merged = previous ? keepPairings(fresh, previous) : { manifest: fresh, kept: 0, unread: [] };
  if (merged.kept) log({ level: "info", code: "discover.pairings_kept", message: `Kept ${merged.kept} board pairing(s) from the earlier discovery.` });
  for (const b of merged.unread) log({ level: "info", code: "discover.unread_kept", board: b.name, message: `${b.name} was not read this time and is kept as recorded.` });
  if (o.setup) await saveDiscovery(db, migrationId, merged.manifest, o.setup);
  else await saveManifest(db, migrationId, merged.manifest);
  await syncNameFields(db, migrationId);
  if ((await accountSlug(db, migrationId)) === null) {
    try {
      const { slug } = await monday.me();
      if (slug) await setAccountSlug(db, migrationId, slug);
    } catch (error) {
      log({ level: "warn", code: "discover.slug_unread", message: `Could not read the monday account's address; links to monday items stay off (${error instanceof Error ? error.message : String(error)}).` });
    }
  }
  await setStatus(db, migrationId, "discovered");
  return (await loadManifest(db, migrationId)) ?? merged.manifest;
}

type LinkStepResult =
  | { ok: true; boards: number; deletedSeeds: number; seedFailures: string[]; decision: RelinkDecision }
  | { ok: false; reason: "blocked"; blocking: string[] }
  | { ok: false; reason: "confirm" };

type LinkLookups = {
  itemIds?: ((boardId: string) => Promise<Set<string>>) | undefined;
  noMonday?: boolean | undefined;
  homes?: Map<string, number[]> | undefined;
};

async function linkOutcome(deps: Deps, o: LinkLookups & { preview?: boolean; refused?: string[]; previewHomes?: Map<string, number[]> } = {}) {
  const { db, migrationId, monday, plaky, log } = deps;
  const migration = await getMigration(db, migrationId);
  const manifest = await loadManifest(db, migrationId);
  if (!manifest) throw new PreconditionError("discover first: this migration has no manifest");
  if (migration.plakySpaceId === null) throw new Error("this migration has no Plaky space");
  const previous = (await loadLinkConfig(db, migrationId))?.legacy ?? null;
  const outcome = await linkManifest(plaky, manifest, migration.plakySpaceId, previous, {
    ...(o.noMonday ? {} : {
      itemIds: async (boardId: string) => {
        if (isLevelEntry(boardId)) {
          const level = levelOfEntry(boardId);
          return new Set([...(await monday.itemLevels(baseBoardId(boardId)))].filter(([, l]) => l === level).map(([id]) => id));
        }
        return o.itemIds ? o.itemIds(boardId) : new Set((await monday.itemTitles(baseBoardId(boardId))).keys());
      },
      itemBoards: (ids: readonly string[]) => monday.activeItemBoards(ids),
    }),
    preview: o.preview ?? false,
    ...(o.preview ? { ...(o.noMonday && o.homes ? { knownHomes: o.homes } : {}), ...(o.previewHomes ? { homes: o.previewHomes } : {}), ...(o.refused ? { refused: o.refused } : {}) } : {}),
    comments: migration.options.syncComments,
    files: migration.options.syncFiles,
    subscribers: migration.options.syncSubscribers,
    people: migration.people as PeopleMap,
    log,
  });
  return { migration, manifest, previous, outcome };
}

async function boardsRecordedElsewhere(db: Deps["db"], migrationId: number, plakyBoardIds: readonly number[]): Promise<Map<number, string[]>> {
  const out = new Map<number, string[]>();
  if (!plakyBoardIds.length) return out;
  const rows = await db.select({ board: migrationBoards.plakyBoardId, id: migrations.id, name: migrations.name }).from(migrationBoards)
    .innerJoin(migrations, eq(migrations.id, migrationBoards.migrationId))
    .where(and(inArray(migrationBoards.plakyBoardId, [...plakyBoardIds]), ne(migrationBoards.migrationId, migrationId)));
  for (const r of rows) if (r.board !== null) out.set(r.board, [...(out.get(r.board) ?? []), `#${r.id} '${r.name}'`]);
  return out;
}

export async function previewLink(deps: Deps, o: LinkLookups = {}) {
  const homes = new Map<string, number[]>();
  const refused: string[] = [];
  const { manifest, previous, outcome } = await linkOutcome(deps, { ...o, preview: true, previewHomes: homes, refused });
  if (!o.noMonday && o.homes) {
    o.homes.clear();
    for (const [id, where] of homes) o.homes.set(id, where);
  }
  const decision = outcome.built ? decideRelink(previous, outcome.built.config as Record<string, unknown>, liveKeysOf(outcome.seeded)) : null;
  const elsewhere = await boardsRecordedElsewhere(deps.db, deps.migrationId, outcome.result.links.map((l) => l.plakyBoardId));
  return {
    links: outcome.result.links.map((l) => ({
      mondayBoardId: l.mondayBoardId, name: l.name, plakyBoardId: l.plakyBoardId, paired: Object.keys(l.fieldMap).length,
      plakyTitle: outcome.seeded.get(l.mondayBoardId)?.title ?? null,
      unmatched: l.unmatched, warnings: [...l.warnings, ...(elsewhere.get(l.plakyBoardId) ?? []).map((m) => `Plaky board ${l.plakyBoardId} is also recorded for migration ${m}: both would write to it`)], seedRows: l.seedItemIds.length, ready: isReady(l), subitemsOf: l.subitemsOf,
    })),
    missing: outcome.result.missing.map(([id, name]) => ({ id, name })),
    gone: manifest.boards.filter((b) => !b.nested && outcome.gone.has(b.id) && !outcome.seeded.has(b.id)).map((b) => ({ id: b.id, name: b.name, plakyBoardId: outcome.gone.get(b.id)! })),
    hints: boardHints(manifest, outcome.result.missing.map(([id]) => id), outcome.unmarked, new Set(manifest.boards.flatMap((b) => (b.plakyBoardId === null ? [] : [b.plakyBoardId]))), homes),
    blocking: [...refused, ...outcome.blocking],
    peopleWarnings: outcome.peopleWarnings,
    wanted: manifest.boards.length,
    needsConfirm: decision?.action === "confirm",
    changes: decision?.action === "write" ? decision.changes : null,
  };
}

export async function linkStep(deps: Deps, o: { force?: boolean } = {}): Promise<LinkStepResult> {
  const { db, migrationId, plaky, log } = deps;
  const { migration, manifest, previous, outcome } = await linkOutcome(deps);
  const unseeded = new Map([...outcome.gone].filter(([boardId]) => !outcome.seeded.has(boardId)));
  const current = unseeded.size ? recordPairings(manifest, [], unseeded) : manifest;
  if (unseeded.size) await saveManifest(db, migrationId, current);
  for (const [boardId, plakyBoardId] of unseeded) {
    await forgetPlakyBoard(db, migrationId, plakyBoardId);
    await markBoardUnapplied(db, migrationId, boardId);
  }
  if (!outcome.built) {
    const gone = manifest.boards.filter((b) => !b.nested && unseeded.has(b.id))
      .map((b) => `${b.name}: Plaky board ${unseeded.get(b.id)} is not in this space any more (deleted, or moved to another space). Import its file again, then link.`);
    return { ok: false, reason: "blocked", blocking: [...gone, ...outcome.blocking] };
  }
  const missing = outcome.result.missing.filter(([id]) => !manifest.boards.some((b) => b.id === id && b.nested));
  if (missing.length && !o.force) {
    return { ok: false, reason: "blocked", blocking: missing.map(([, name]) => `${name}: not found in Plaky yet. Import its file into the space (the Boards step offers it), then link again.`) };
  }
  const decision = decideRelink(previous, outcome.built.config as Record<string, unknown>, liveKeysOf(outcome.seeded), o.force ?? false);
  if (decision.action === "confirm") return { ok: false, reason: "confirm" };
  const before = new Map((await loadLinkConfig(db, migrationId))?.config.boards.map((b) => [b.mondayBoardId, b.plakyBoardId]) ?? []);
  await saveManifest(db, migrationId, recordPairings(current, outcome.result.links));
  await saveLinkConfig(db, migrationId, outcome.built.config as Record<string, unknown>);
  for (const link of outcome.result.links) {
    const old = before.get(link.mondayBoardId);
    if (old === undefined || old === link.plakyBoardId) continue;
    await forgetPlakyBoard(db, migrationId, old);
    await markBoardUnapplied(db, migrationId, link.mondayBoardId);
    log({ level: "info", code: "link.repaired", board: link.name, message: `${link.name}: paired with Plaky board ${link.plakyBoardId} in place of board ${old}; the next run reads it in full.` });
  }
  const { deleted, failures } = await deleteSeeds(plaky, migration.plakySpaceId!, outcome.result.links);
  for (const failure of failures) log({ level: "warn", code: "link.seed_delete_failed", message: failure });
  await setSeedFailures(db, migrationId, failures);
  log({ level: "info", code: "link.done", message: `Linked ${outcome.result.links.length} board(s); deleted ${deleted} seed row(s).` });
  await setStatus(db, migrationId, "linked");
  return { ok: true, boards: outcome.result.links.length, deletedSeeds: deleted, seedFailures: failures, decision };
}

export type Extracts = Pick<ExtractCache, "read">;

export type PlanStepResult = { plans: BoardPlan[]; failures: string[]; plannedWrites: number; cache: Extracts };

export async function planStep(deps: Deps, o: {
  cache?: Extracts; since?: Since;
  ownRunId?: number;
  settleStatus?: boolean;
} = {}): Promise<PlanStepResult> {
  const { db, migrationId, plaky } = deps;
  const migration = await getMigration(db, migrationId);
  const loaded = await loadLinkConfig(db, migrationId);
  if (!loaded) throw new PreconditionError("link first: this migration has no config");
  const since = o.since ?? migration.options.since;
  const cache = o.cache ?? new ExtractCache(deps, since);
  const points = new Map((await db.select({ id: migrationBoards.mondayBoardId, at: migrationBoards.syncedReadAt }).from(migrationBoards).where(eq(migrationBoards.migrationId, migrationId)))
    .map((b) => [b.id, b.at?.toISOString() ?? null]));
  const { plans, failures } = await planBoards(cache.read, plaky, loaded.config, {
    allowDuplicateImport: migration.options.allowDuplicateImport,
    docs: true,
    rich: true,
    links: true,
    parentTitles: (boardId, only) => (only ? deps.monday.itemNames(only, boardId) : deps.monday.itemTitles(boardId)),
    mondayOrder: async (boardId) => [...(await deps.monday.itemTitles(boardId)).keys()],
    syncPoint: (boardId) => points.get(boardId) ?? null,
  });
  const delta = async (board: BoardSync): Promise<boolean> => (cache instanceof ExtractCache ? Boolean((await cache.read(board)).isDelta) : since !== null && appliedState(board) === "written");
  for (const plan of plans) if (!(await delta(plan.config))) await saveIr(db, migrationId, plan.config.mondayBoardId, irRows(plan));
  for (const failure of failures) deps.log({ level: "error", code: "plan.board_failed", message: `cannot plan ${failure}` });
  if (o.settleStatus !== false) await setStatusUnlessOtherRun(db, migrationId, "planned", o.ownRunId ?? null, { quiet: true });
  return { plans, failures, plannedWrites: plannedWrites(plans, { prune: migration.options.prune, recreateDrifted: migration.options.recreateDrifted }), cache };
}

type ApplyStepResult = {
  planned: PlanStepResult;
  applied: ApplyPlansResult | null;
};

async function waitForLateWrites(store: DbLoadStore, boards: readonly BoardKey[], clock: Clock, deps: Pick<Deps, "log" | "signal">): Promise<boolean> {
  const deadline = await store.landingDeadline(boards);
  if (deadline !== null && deadline > clock.now()) {
    deps.log({
      level: "info", code: "apply.waiting_for_late_writes",
      message: `Waiting ${Math.ceil((deadline - clock.now()) / 1000)} s before reading Plaky: an earlier run sent an item write whose answer never came back, and Plaky may still apply it. Reading the board after that keeps the item from being created twice.`,
    });
    while (clock.now() < deadline && !deps.signal?.aborted) await clock.sleep(Math.min(1_000, deadline - clock.now()));
    if (deps.signal?.aborted) return false;
  }
  await store.forgetLanded(boards);
  return true;
}

export async function applyStep(
  deps: Deps,
  o: { cache?: Extracts; since?: Since; progress?: () => void; confirm?: (planned: PlanStepResult) => boolean | Promise<boolean>; owner?: string;
    unattended?: boolean; clock?: Clock } = {},
): Promise<ApplyStepResult> {
  const { db, migrationId, monday, plaky, log, signal } = deps;
  const migration = await getMigration(db, migrationId);
  const loaded = await loadLinkConfig(db, migrationId);
  if (!loaded) throw new PreconditionError("link first: this migration has no config");
  const clock = o.clock ?? realClock;
  const store = new DbLoadStore({ db, migrationId, now: () => clock.now(), ...(o.owner === undefined ? {} : { owner: o.owner }) });
  const markApplied = store.markApplied.bind(store);
  store.markApplied = async (board) => {
    await markBoardApplied(db, migrationId, board.mondayBoardId);
    await markApplied(board);
  };
  store.markUnapplied = async (board) => {
    await markBoardUnapplied(db, migrationId, board.mondayBoardId);
  };
  const boards = loaded.config.boards.map((b) => ({ space: b.plakySpaceId, board: b.plakyBoardId }));
  return withBoardLocks(store, boards, async () => {
    if (!(await waitForLateWrites(store, boards, clock, deps))) {
      await setStatus(db, migrationId, "interrupted");
      return { planned: { plans: [], failures: [], plannedWrites: 0, cache: o.cache ?? new ExtractCache(deps, o.since ?? migration.options.since) }, applied: null };
    }
    const planned = await planStep(deps, { ...(o.cache ? { cache: o.cache } : {}), ...(o.since ? { since: o.since } : {}), settleStatus: false });
    if (!planned.plans.length) {
      if (signal?.aborted) await setStatus(db, migrationId, "interrupted");
      else if (planned.failures.length) await setStatus(db, migrationId, "failed");
      return { planned, applied: null };
    }
    if (o.confirm && !(await o.confirm(planned))) return { planned, applied: null };
    await setStatus(db, migrationId, "running");
    let applied: ApplyPlansResult;
    try {
      applied = await applyPlans(
        planned.plans,
        { plaky, store, log, ...(o.progress ? { progress: o.progress } : {}), fetcher: new DocAwareSource(new AssetFetcher({ fetchAssetUrls: mondayAssetUrls(monday) }), monday) },
        { prune: migration.options.prune && !o.unattended, recreateDrifted: migration.options.recreateDrifted && !o.unattended, signal },
      );
    } catch (error) {
      await setStatus(db, migrationId, "failed").catch(() => undefined);
      throw error;
    }
    const failed = planned.failures.length > 0 || applied.results.some((r) => r.result.failures.length || r.result.ambiguous.length);
    const interrupted = applied.notStarted.length > 0 || applied.results.some((r) => r.result.stopped || r.result.rateLimited);
    await setStatus(db, migrationId, interrupted ? "interrupted" : failed ? "failed" : "completed");
    return { planned, applied };
  });
}

export async function verifyStep(deps: Deps, o: { cache?: Extracts } = {}): Promise<Receipt> {
  const { db, migrationId, plaky, monday } = deps;
  const loaded = await loadLinkConfig(db, migrationId);
  if (!loaded) throw new PreconditionError("link first: this migration has no config");
  const manifest = await loadManifest(db, migrationId);
  const cache = o.cache ?? new ExtractCache(deps);
  const docs = new DocAwareSource(new AssetFetcher({ fetchAssetUrls: mondayAssetUrls(monday) }), monday);
  return verify(cache.read, plaky, loaded.config, manifest ? { boards: manifest.boards.map((b) => ({ id: b.id, dropped: b.columns.filter((c) => c.plakyType === null).map((c) => ({ title: c.title, type: c.type, reason: c.reason ?? "" })) })) } : null, { parentTitles: (boardId) => monday.itemTitles(boardId), docs: true, rich: true, filesMapped: (mondayItemId) => readFileMap(db, migrationId, mondayItemId), fileMeta: (assetId) => docs.meta(assetId) });
}
