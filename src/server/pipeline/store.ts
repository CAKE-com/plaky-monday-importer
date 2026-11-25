import { createHash } from "node:crypto";
import { hostname } from "node:os";
import { and, asc, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import type { Db } from "@/db/client";
import { connections, entityMappings, irItems, migrationBoards, migrationColumns, migrationLogs, migrationRuns, migrations, mondayUsage, type DraftOptions } from "@/db/schema";
import { PreconditionError } from "../errors";
import { logger, redact, redactString, registerSecret } from "../redact";
import type { PipelineEvent } from "./events";
import { boardWarnings, parseManifest, toJson, type Manifest } from "./manifest";
import { boardsWritingDifferently, parseSyncConfig, type SyncConfig } from "./config";
import type { IrRow } from "./plan";
import { RUN_REACHED_FROM, type RunOutcome } from "../jobs/run-state";
import { REACHED_FROM } from "./status";
import { appliedSet, pairingSet, syncPointSet, syncPointsCleared } from "./board-state";

type Options = typeof migrations.$inferInsert.options;
export const DEFAULT_OPTIONS: Options = {
  syncComments: false, syncFiles: false, syncSubscribers: false, syncGroups: true, withCreated: true, withLink: true,
  prune: false, recreateDrifted: false, allowDuplicateImport: false, since: null, subitems: "board",
};
type Status = (typeof migrations.$inferSelect)["status"];

export async function ensureConnection(
  db: Db,
  c: { mondayAccountId: string; mondayUserId: string; mondayTimeZone: string | null; plakyUserId: number; mondayAccountSlug?: string | null; mondayTier?: string | null; label?: string; mondayAccountUid?: string | null; mondayUserUid?: string | null },
  keys: Partial<Typed> = {},
): Promise<number> {
  const found = c.mondayAccountUid && c.mondayUserUid
    ? await db.select().from(connections).where(and(
      eq(connections.mondayAccountUid, c.mondayAccountUid), eq(connections.mondayUserUid, c.mondayUserUid), eq(connections.plakyUserId, c.plakyUserId),
      keys.plakyWebBase ? eq(connections.plakyWebBase, keys.plakyWebBase) : isNull(connections.plakyWebBase),
    )).orderBy(asc(connections.id)).limit(1)
    : [];
  if (found[0]) {
    if (c.mondayAccountSlug && c.mondayAccountSlug !== found[0].mondayAccountSlug) await db.update(connections).set({ mondayAccountSlug: c.mondayAccountSlug }).where(eq(connections.id, found[0].id));
    if (c.mondayTier && c.mondayTier !== found[0].mondayTier) await db.update(connections).set({ mondayTier: c.mondayTier }).where(eq(connections.id, found[0].id));
    return found[0].id;
  }
  const [row] = await db.insert(connections).values({ ...c, label: c.label ?? `monday ${c.mondayAccountId}` }).returning({ id: connections.id });
  return row!.id;
}

export type Keys = { mondayToken: string | null; plakyKey: string | null };
export type Typed = Keys & { plakyWebBase: string | null };

export async function saveKeys(db: Db, connectionId: number, keys: Partial<Typed>): Promise<void> {
  registerSecret(keys.mondayToken);
  registerSecret(keys.plakyKey);
  const set = {
    ...(keys.mondayToken !== undefined ? { mondayToken: keys.mondayToken || null } : {}),
    ...(keys.plakyKey !== undefined ? { plakyKey: keys.plakyKey || null } : {}),
    ...(keys.plakyWebBase !== undefined ? { plakyWebBase: keys.plakyWebBase || null } : {}),
  };
  if (!Object.keys(set).length) return;
  const before = (await db.select({ mondayToken: connections.mondayToken, plakyKey: connections.plakyKey }).from(connections).where(eq(connections.id, connectionId)).limit(1))[0];
  await db.update(connections).set(set).where(eq(connections.id, connectionId));
  const replaced = (["mondayToken", "plakyKey"] as const).some((k) => set[k] !== undefined && before?.[k] && before[k] !== set[k]);
  if (replaced) await db.$client.execute("PRAGMA wal_checkpoint(TRUNCATE)").catch(() => undefined);
}

export async function keysFor(db: Db, migrationId: number): Promise<Typed> {
  const row = (await db.select({ mondayToken: connections.mondayToken, plakyKey: connections.plakyKey, plakyWebBase: connections.plakyWebBase }).from(migrations)
    .innerJoin(connections, eq(connections.id, migrations.connectionId)).where(eq(migrations.id, migrationId)).limit(1))[0];
  registerSecret(row?.mondayToken);
  registerSecret(row?.plakyKey);
  return { mondayToken: row?.mondayToken ?? null, plakyKey: row?.plakyKey ?? null, plakyWebBase: row?.plakyWebBase ?? null };
}

export async function setAccountSlug(db: Db, migrationId: number, slug: string): Promise<void> {
  const { connectionId } = await getMigration(db, migrationId);
  await db.update(connections).set({ mondayAccountSlug: slug }).where(eq(connections.id, connectionId));
}

export async function accountSlug(db: Db, migrationId: number): Promise<string | null> {
  const { connectionId } = await getMigration(db, migrationId);
  return (await db.select({ slug: connections.mondayAccountSlug }).from(connections).where(eq(connections.id, connectionId)).limit(1))[0]?.slug ?? null;
}

export async function createMigration(db: Db, m: { connectionId: number; name: string; plakySpaceId: number | null; options?: Partial<Options> }): Promise<number> {
  const [row] = await db.insert(migrations).values({ connectionId: m.connectionId, name: m.name, plakySpaceId: m.plakySpaceId, options: { ...DEFAULT_OPTIONS, ...m.options } }).returning({ id: migrations.id });
  return row!.id;
}

export async function getMigration(db: Db, id: number): Promise<typeof migrations.$inferSelect> {
  const row = (await db.select().from(migrations).where(eq(migrations.id, id)).limit(1))[0];
  if (!row) throw new Error(`no migration ${id}`);
  return row;
}

export async function renameMigration(db: Db, id: number, name: string): Promise<void> {
  await db.update(migrations).set({ name: name.slice(0, 80), updatedAt: new Date() }).where(eq(migrations.id, id));
}

export async function mondayTierOf(db: Db, migrationId: number): Promise<string | null> {
  const row = (await db.select({ tier: connections.mondayTier }).from(migrations).innerJoin(connections, eq(connections.id, migrations.connectionId)).where(eq(migrations.id, migrationId)).limit(1))[0];
  return row?.tier ?? null;
}

export async function updateSetup(db: Db, id: number, setup: { plakySpaceId?: number | null; options?: Partial<Options> }): Promise<void> {
  const current = await getMigration(db, id);
  await db.update(migrations).set({
    ...(setup.plakySpaceId === undefined ? {} : { plakySpaceId: setup.plakySpaceId }),
    options: { ...current.options, ...setup.options },
    updatedAt: new Date(),
  }).where(eq(migrations.id, id));
}

export function planSetup(migration: { options: Record<string, unknown>; people: Record<string, unknown> }): string {
  const sorted = (value: unknown): unknown =>
    Array.isArray(value) ? value.map(sorted)
      : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => [k, sorted(v)]))
        : value;
  const options = Object.fromEntries(Object.entries(migration.options).filter(([key]) => key !== "draft" && key !== "pick"));
  return createHash("sha256").update(JSON.stringify(sorted({ options, people: migration.people }))).digest("hex").slice(0, 16);
}

type StatusOptions = { quiet?: boolean };

export async function saveDraft(db: Db, id: number, draft: Draft): Promise<void> {
  const given = sql`json(${JSON.stringify({ boards: draft.boards, spaceId: draft.spaceId, ...(draft.options ? { options: draft.options } : {}) })})`;
  const value = draft.options ? given : sql`CASE WHEN ${migrations.options} -> '$.draft.options' IS NULL THEN ${given} ELSE json_set(${given}, '$.options', ${migrations.options} -> '$.draft.options') END`;
  await db.update(migrations).set({ options: sql`json_set(${migrations.options}, '$.draft', ${value})`, updatedAt: new Date() }).where(eq(migrations.id, id));
}

type Draft = NonNullable<Options["draft"]>;

const DRAFT_SUPERSEDED = "the choices changed while the boards were read: nothing was saved from this read. Read the boards again to use the new choices.";

export async function saveDiscovery(db: Db, id: number, manifest: Manifest, setup: { plakySpaceId: number; options: DraftOptions; draft: Draft }): Promise<void> {
  const o = setup.options;
  const bool = (v: boolean) => sql`json(${v ? "true" : "false"})`;
  const unchanged = sql`json(${migrations.options} -> '$.draft') IS json(${JSON.stringify(setup.draft)})`;
  const options = sql`CASE WHEN ${unchanged}
    THEN json_set(${migrations.options}, '$.syncComments', ${bool(o.syncComments)}, '$.syncFiles', ${bool(o.syncFiles)}, '$.syncSubscribers', ${bool(o.syncSubscribers)},
      '$.withCreated', ${bool(o.withCreated)}, '$.withLink', ${bool(o.withLink)}, '$.subitems', ${o.subitems})
    ELSE json('draft superseded') END`;
  try {
    await db.batch([
      db.update(migrations).set({ plakySpaceId: setup.plakySpaceId, options, manifest: toJson(manifest) as Record<string, unknown>, updatedAt: new Date() }).where(eq(migrations.id, id)),
      ...manifestRows(db, id, manifest),
    ]);
  } catch (error) {
    const still = (await db.select({ same: sql<number>`${unchanged}` }).from(migrations).where(eq(migrations.id, id)).limit(1))[0]?.same;
    if (!still) throw new PreconditionError(DRAFT_SUPERSEDED);
    throw error;
  }
}

async function moveStatus(db: Db, id: number, status: Status, unless?: SQL, o: StatusOptions = {}): Promise<void> {
  const allowed = REACHED_FROM[status];
  const moved = await db.update(migrations).set({ status, updatedAt: new Date() }).where(and(eq(migrations.id, id), inArray(migrations.status, [...allowed]), unless)).returning({ id: migrations.id });
  if (moved.length || o.quiet) return;
  const from = (await db.select({ status: migrations.status }).from(migrations).where(eq(migrations.id, id)).limit(1))[0]?.status;
  if (from !== undefined && from !== status && !allowed.includes(from)) logger.warn(`migration ${id}: status ${from} cannot become ${status}; left as it is`);
}

export async function setStatus(db: Db, id: number, status: Status, o: StatusOptions = {}): Promise<void> {
  await moveStatus(db, id, status, undefined, o);
}

export async function setStatusUnlessOtherRun(db: Db, id: number, status: Status, ownRunId: number | null = null, o: StatusOptions = {}): Promise<void> {
  await moveStatus(db, id, status, sql`NOT EXISTS (SELECT 1 FROM ${migrationRuns} WHERE ${migrationRuns.migrationId} = ${id} AND ${migrationRuns.status} = 'running' AND ${migrationRuns.id} <> ${ownRunId ?? -1})`, o);
}

export async function saveManifest(db: Db, id: number, manifest: Manifest): Promise<void> {
  await db.batch([
    db.update(migrations).set({ manifest: toJson(manifest) as Record<string, unknown>, updatedAt: new Date() }).where(eq(migrations.id, id)),
    ...manifestRows(db, id, manifest),
  ]);
}

function manifestRows(db: Db, id: number, manifest: Manifest): BatchItem<"sqlite">[] {
  return manifest.boards.flatMap((board) => {
    const values = {
      mondayBoardName: board.name, hierarchyType: board.hierarchyType, itemsCount: board.itemsCount, subitemsOf: board.parentBoardId,
      byHand: [...board.byHand], warnings: boardWarnings(board),
    };
    const rowId = sql`(SELECT ${migrationBoards.id} FROM ${migrationBoards} WHERE ${migrationBoards.migrationId} = ${id} AND ${migrationBoards.mondayBoardId} = ${board.id})`;
    const writes: BatchItem<"sqlite">[] = [
      db.insert(migrationBoards).values({ migrationId: id, mondayBoardId: board.id, ...values }).onConflictDoUpdate({ target: [migrationBoards.migrationId, migrationBoards.mondayBoardId], set: values }),
      pairingSet(db, id, board.id, board.plakyBoardId),
      db.delete(migrationColumns).where(eq(migrationColumns.migrationBoardId, rowId)),
    ];
    if (board.columns.length) {
      writes.push(db.insert(migrationColumns).values(board.columns.map((c, position) => ({
        migrationBoardId: rowId, mondayColumnId: c.id, title: c.title, mondayType: c.type, fieldName: c.fieldName,
        plakyType: c.plakyType as (typeof migrationColumns.$inferInsert)["plakyType"], reason: c.reason, labels: [...c.labels],
        labelCollisions: [...c.labelCollisions], position,
      }))));
    }
    return writes;
  });
}

export async function loadManifest(db: Db, id: number): Promise<Manifest | null> {
  const raw = (await getMigration(db, id)).manifest;
  return raw ? parseManifest(raw, `migration ${id} manifest`) : null;
}

export async function saveLinkConfig(db: Db, id: number, legacy: Record<string, unknown>): Promise<SyncConfig> {
  const config = parseSyncConfig(legacy, `migration ${id} config`);
  const previous = await loadLinkConfig(db, id);
  const differing = previous ? boardsWritingDifferently(previous.config, config) : [];
  await db.batch([
    ...(differing.length ? [syncPointsCleared(db, id, differing)] : []),
    db.update(migrations).set({ linkConfig: legacy, people: config.people as Record<string, Record<string, unknown>>, updatedAt: new Date() }).where(eq(migrations.id, id)),
    ...config.boards.flatMap((b) => [
      db.update(migrationBoards).set({
        fieldMap: b.fieldMap, skipColumns: b.skipColumns, labelMap: b.labelMap, mondayIdFieldKey: b.mondayIdField,
        parentTitleFieldKey: b.parentTitleField, parentIdFieldKey: b.parentIdField, seedGroupId: b.seedGroupId,
      }).where(and(eq(migrationBoards.migrationId, id), eq(migrationBoards.mondayBoardId, b.mondayBoardId))),
      pairingSet(db, id, b.mondayBoardId, b.plakyBoardId),
      appliedSet(db, id, b.mondayBoardId, b.applied),
    ]),
  ] as unknown as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]]);
  return config;
}

export async function loadLinkConfig(db: Db, id: number): Promise<{ legacy: Record<string, unknown>; config: SyncConfig } | null> {
  const legacy = (await getMigration(db, id)).linkConfig;
  return legacy ? { legacy, config: parseSyncConfig(legacy, `migration ${id} config`) } : null;
}

export async function markBoardApplied(db: Db, id: number, mondayBoardId: string): Promise<void> {
  const loaded = await loadLinkConfig(db, id);
  if (!loaded) return;
  const boards = (loaded.legacy.boards as Record<string, unknown>[]).map((b) => (String(b.monday_board_id) === mondayBoardId ? { ...b, applied: true } : b));
  await db.batch([
    db.update(migrations).set({ linkConfig: { ...loaded.legacy, boards } }).where(eq(migrations.id, id)),
    appliedSet(db, id, mondayBoardId, true),
  ]);
}

export async function markBoardUnapplied(db: Db, id: number, mondayBoardId: string): Promise<void> {
  const loaded = await loadLinkConfig(db, id);
  const row = [appliedSet(db, id, mondayBoardId, false), syncPointsCleared(db, id, [mondayBoardId])] as const;
  if (!loaded) {
    await db.batch([...row]);
    return;
  }
  const boards = (loaded.legacy.boards as Record<string, unknown>[]).map((b) => (String(b.monday_board_id) === mondayBoardId ? { ...b, applied: false } : b));
  await db.batch([db.update(migrations).set({ linkConfig: { ...loaded.legacy, boards } }).where(eq(migrations.id, id)), ...row]);
}

export async function setSeedFailures(db: Db, id: number, failures: readonly string[]): Promise<void> {
  await db.update(migrations).set({ seedFailures: [...failures] }).where(eq(migrations.id, id));
}

export async function forgetPlakyBoard(db: Db, id: number, plakyBoardId: number): Promise<void> {
  const rows = await db.select({ mondayId: entityMappings.mondayId }).from(entityMappings)
    .where(and(eq(entityMappings.migrationId, id), inArray(entityMappings.entityType, ["item", "subitem"]), eq(entityMappings.plakyParentId, plakyBoardId)));
  const items = rows.map((r) => r.mondayId);
  for (let start = 0; start < items.length; start += 500) {
    await db.delete(entityMappings).where(and(eq(entityMappings.migrationId, id), inArray(entityMappings.entityType, ["comment", "file"]), inArray(entityMappings.scope, items.slice(start, start + 500))));
  }
  await db.delete(entityMappings).where(and(eq(entityMappings.migrationId, id), inArray(entityMappings.entityType, ["item", "subitem", "group"]), eq(entityMappings.plakyParentId, plakyBoardId)));
}

export async function setSyncPoints(db: Db, id: number, mondayBoardIds: readonly string[], readAt: number): Promise<void> {
  if (!mondayBoardIds.length) return;
  await syncPointSet(db, id, mondayBoardIds, readAt);
}

export async function clearSyncPoints(db: Db, id: number, mondayBoardIds?: readonly string[]): Promise<void> {
  if (mondayBoardIds && !mondayBoardIds.length) return;
  await syncPointsCleared(db, id, mondayBoardIds);
}

export async function saveIr(db: Db, id: number, mondayBoardId: string, rows: IrRow[]): Promise<void> {
  const board = (await db.select({ id: migrationBoards.id }).from(migrationBoards).where(and(eq(migrationBoards.migrationId, id), eq(migrationBoards.mondayBoardId, mondayBoardId))).limit(1))[0];
  if (!board) return;
  const replace: BatchItem<"sqlite">[] = [db.delete(irItems).where(eq(irItems.migrationBoardId, board.id))];
  for (let i = 0; i < rows.length; i += 200) replace.push(db.insert(irItems).values(rows.slice(i, i + 200).map((r) => ({ ...r, migrationBoardId: board.id }))));
  await db.batch(replace as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]]);
}

const utcDay = (at: number): string => new Date(at).toISOString().slice(0, 10);

export async function recordMondayCall(db: Db, at: number = Date.now(), n = 1): Promise<void> {
  await db.insert(mondayUsage).values({ day: utcDay(at), calls: n }).onConflictDoUpdate({ target: mondayUsage.day, set: { calls: sql`${mondayUsage.calls} + ${n}` } });
}

export async function mondayCallsOn(db: Db, at: number = Date.now()): Promise<number> {
  return (await db.select({ calls: mondayUsage.calls }).from(mondayUsage).where(eq(mondayUsage.day, utcDay(at))).limit(1))[0]?.calls ?? 0;
}

type RunKind = (typeof migrationRuns.$inferInsert)["kind"];

export const RUN_HEARTBEAT_MS = 20_000;
type Beats = WeakMap<Db, Map<number, ReturnType<typeof setInterval>>>;
const allBeats: Beats = ((globalThis as { __mmwRunBeats?: Beats }).__mmwRunBeats ??= new WeakMap());
const beatsOf = (db: Db): Map<number, ReturnType<typeof setInterval>> => {
  let beats = allBeats.get(db);
  if (!beats) allBeats.set(db, (beats = new Map()));
  return beats;
};

export const ownRunIds = (db: Db): number[] => [...beatsOf(db).keys()];

export const PROCESS_TOKEN: string = ((globalThis as { __mmwProcessToken?: string }).__mmwProcessToken ??= crypto.randomUUID());

export async function startRun(db: Db, migrationId: number, kind: RunKind): Promise<number> {
  const [row] = await db.insert(migrationRuns).values({ migrationId, kind, status: "running", heartbeatAt: new Date(), ownerHost: hostname(), ownerPid: process.pid, ownerToken: PROCESS_TOKEN })
    .returning({ id: migrationRuns.id });
  const runId = row!.id;
  const beat = setInterval(() => {
    void db.update(migrationRuns).set({ heartbeatAt: new Date() }).where(and(eq(migrationRuns.id, runId), eq(migrationRuns.status, "running"))).catch(() => undefined);
  }, RUN_HEARTBEAT_MS);
  (beat as { unref?: () => void }).unref?.();
  beatsOf(db).set(runId, beat);
  return runId;
}

export async function finishRun(
  db: Db, runId: number, status: RunOutcome,
  extra: { plannedWrites?: number; counts?: Record<string, number>; receipt?: unknown } = {},
): Promise<void> {
  const beats = beatsOf(db);
  clearInterval(beats.get(runId));
  beats.delete(runId);
  const finished = await db.update(migrationRuns).set({ status, finishedAt: new Date(), ...extra }).where(and(eq(migrationRuns.id, runId), inArray(migrationRuns.status, [...RUN_REACHED_FROM[status]]))).returning({ id: migrationRuns.id });
  if (!finished.length && Object.keys(extra).length) await db.update(migrationRuns).set(extra).where(eq(migrationRuns.id, runId));
}

export function boardIdsByName(rows: readonly { mondayBoardName: string; id: number }[]): Map<string, number> {
  const out = new Map<string, number>();
  const shared = new Set<string>();
  for (const r of rows) {
    if (out.has(r.mondayBoardName)) shared.add(r.mondayBoardName);
    out.set(r.mondayBoardName, r.id);
  }
  for (const name of shared) out.delete(name);
  return out;
}

const LOG_INSERT_RETRIES = 1;

export function dbLog(db: Db, runId: number, boardIds: ReadonlyMap<string, number> = new Map()): { log: (event: PipelineEvent) => void; flush: () => Promise<void> } {
  let queue: Promise<unknown> = Promise.resolve();
  let lost = 0;
  const insert = async (event: PipelineEvent): Promise<void> => {
    const row = {
      runId, level: event.level, code: event.code, message: redactString(event.message), data: event.data === undefined ? null : (redact(event.data) as Record<string, unknown>),
      migrationBoardId: event.board ? (boardIds.get(event.board) ?? null) : null,
    };
    for (let attempt = 0; ; attempt++) {
      try {
        await db.insert(migrationLogs).values(row);
        return;
      } catch (error) {
        if (attempt >= LOG_INSERT_RETRIES) throw error;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }
  };
  return {
    log(event) {
      queue = queue.then(() => insert(event)).catch(() => void lost++);
    },
    flush: async () => {
      let counted = false;
      for (;;) {
        const seen = queue;
        await seen;
        if (lost && !counted) {
          counted = true;
          const n = lost;
          lost = 0;
          queue = queue.then(() => insert({ level: "error", code: "log.lost", message: `${n} log event(s) could not be saved.`, data: { lost: n } })).catch(() => void (lost += n));
        } else if (seen === queue) return;
      }
    },
  };
}
