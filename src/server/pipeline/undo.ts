import { mappingUncertain } from "./mapping-state";
import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "@/db/client";
import { entityMappings, migrationLogs, migrationRuns } from "@/db/schema";
import { isOutcomeUnknown, isPlakyNotFound, isRateLimited, type PlakyClient, type PlakyItem } from "../clients/plaky";
import { PreconditionError } from "../errors";
import type { BoardSync } from "./config";
import type { PipelineLog } from "./events";
import { withBoardLocks } from "./load";
import { findField } from "./plan";
import { mappedFileIds } from "./file-map";
import { checkBeforeDelete, plakyWork, worked, workText, type OurFiles } from "./made-in-plaky";
import { DbLoadStore } from "./store-load";
import { clearSyncPoints, loadLinkConfig, markBoardUnapplied } from "./store";
import { asId, plakyFieldsFromBoard } from "./transform/mapping";
import { pyStrip } from "./transform/pystr";

type UndoItem = { mondayId: string; plakyId: number; title: string };
type UndoGroup = { plakyId: number; title: string };
type UndoWorked = UndoItem & { comments: number; files: number };
type UndoPreview = {
  board: { mondayBoardId: string; name: string; plakySpaceId: number; plakyBoardId: number };
  items: UndoItem[];
  groups: UndoGroup[];
  kept: string[];
  gone: string[];
  goneIds: string[];
  goneGroupIds: number[];
  keptItems: number;
  nested: (UndoItem & { parent: number })[];
  worked: UndoWorked[];
};
type UndoResult = UndoPreview & { deletedItems: number; deletedNested: number; deletedGroups: number; failures: string[]; reset: boolean };

export const undoChangedPlaky = (r: Pick<UndoResult, "deletedItems" | "deletedGroups" | "reset" | "goneIds">): boolean =>
  r.deletedItems + r.deletedGroups > 0 || (r.reset && r.goneIds.length > 0);

type Mapping = typeof entityMappings.$inferSelect;

const FORGET_SLICE = 500;

async function createdByMigration(db: Db, migrationId: number, code: "item.created" | "group.created", key: "plakyItemId" | "plakyGroupId", ids: ReadonlySet<number>): Promise<Set<number>> {
  if (!ids.size) return new Set();
  const rows = await db.select({ data: migrationLogs.data }).from(migrationLogs).innerJoin(migrationRuns, eq(migrationRuns.id, migrationLogs.runId))
    .where(and(eq(migrationRuns.migrationId, migrationId), eq(migrationLogs.code, code)));
  return new Set(rows.map((r) => (r.data as Record<string, unknown> | null)?.[key]).filter((id): id is number => typeof id === "number" && ids.has(id)));
}
type Row = { id: number; title: string; group: number | null; parent: number | null; mondayId: string | null; commentCount: number | null; fileCount: number | null };

function boardOf(config: { boards: readonly BoardSync[] }, mondayBoardId: string): BoardSync {
  const board = config.boards.find((b) => b.mondayBoardId === mondayBoardId);
  if (!board) throw new PreconditionError(`monday board ${mondayBoardId} is not linked in this migration`);
  return board;
}

const rowOf = (item: PlakyItem, idKey: string | null): Row => {
  const value = idKey === null ? undefined : (item.fields ?? []).find((f) => f.key === idKey)?.value;
  return {
    id: Number(item.id), title: item.title ?? "", group: asId(item.group), parent: asId(item.parent), mondayId: typeof value === "string" && pyStrip(value) ? pyStrip(value) : null,
    commentCount: item.commentCount ?? null, fileCount: item.fileCount ?? null,
  };
};

async function mappingsOf(db: Db, migrationId: number, board: BoardSync, onBoard: ReadonlySet<string>): Promise<{ items: Mapping[]; groups: Mapping[]; nested: Mapping[] }> {
  const type = board.subitemsOf ? "subitem" : "item";
  const all = await db.select().from(entityMappings).where(and(eq(entityMappings.migrationId, migrationId), inArray(entityMappings.entityType, ["item", "subitem", "group"])));
  return {
    items: all.filter((m) => m.entityType === type && (m.plakyParentId === board.plakyBoardId || (m.plakyParentId === null && onBoard.has(m.mondayId)))),
    groups: all.filter((m) => m.entityType === "group" && m.scope === board.mondayBoardId && m.plakyParentId === board.plakyBoardId),
    nested: board.subitemsOf ? [] : all.filter((m) => m.entityType === "subitem" && m.status === "committed" && m.plakyParentId === board.plakyBoardId),
  };
}

async function readBoard(plaky: PlakyClient, board: BoardSync): Promise<{ rows: Row[]; groups: Map<number, string>; archivedUnder: Map<number, number> }> {
  const plakyBoard = await plaky.getBoard(board.plakySpaceId, board.plakyBoardId).catch((error: unknown) => {
    if (isPlakyNotFound(error)) {
      throw new PreconditionError(`"${board.name}" is no longer in Plaky (board ${board.plakyBoardId} was deleted, or moved to another space), so there is nothing on it to undo.`);
    }
    throw error;
  });
  const idField = findField(plakyFieldsFromBoard(plakyBoard), board.mondayIdField);
  const items = await plaky.allItems(board.plakySpaceId, board.plakyBoardId, "INCLUDE");
  const groups = await plaky.allItemGroups(board.plakySpaceId, board.plakyBoardId);
  const archivedUnder = new Map<number, number>();
  for (const i of items) {
    const parent = asId(i.parent);
    if (i.archived && !i.deleted && parent !== null) archivedUnder.set(parent, (archivedUnder.get(parent) ?? 0) + 1);
  }
  return { rows: items.filter((i) => !i.archived && !i.deleted).map((i) => rowOf(i, idField?.key ?? null)), groups: new Map(groups.map((g) => [Number(g.id), g.title ?? ""])), archivedUnder };
}

export async function previewUndo(db: Db, migrationId: number, plaky: PlakyClient, mondayBoardId: string): Promise<UndoPreview> {
  return (await previewWith(db, migrationId, plaky, mondayBoardId)).preview;
}

async function previewWith(db: Db, migrationId: number, plaky: PlakyClient, mondayBoardId: string): Promise<{ preview: UndoPreview; byId: ReadonlyMap<number, Row>; ourFiles: OurFiles }> {
  const loaded = await loadLinkConfig(db, migrationId);
  if (!loaded) throw new PreconditionError("link first: this migration has no config");
  const board = boardOf(loaded.config, mondayBoardId);
  const { rows, groups, archivedUnder } = await readBoard(plaky, board);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const mapped = await mappingsOf(db, migrationId, board, new Set(rows.flatMap((r) => (r.mondayId ? [r.mondayId] : []))));
  const out: UndoPreview = { board: { mondayBoardId, name: board.name, plakySpaceId: board.plakySpaceId, plakyBoardId: board.plakyBoardId }, items: [], groups: [], kept: [], gone: [], goneIds: [], goneGroupIds: [], keptItems: 0, nested: [], worked: [] };
  const keep = (why: string): void => {
    out.kept.push(why);
    out.keptItems++;
  };

  const ours = new Set<number>();
  for (const m of mapped.items) {
    const label = `monday item ${m.mondayId}`;
    if (mappingUncertain(m)) {
      keep(`${label}: its last write is ${m.status}${m.lastError ? ` (${m.lastError.slice(0, 200)})` : ""}, so what Plaky holds for it is not known; not deleted`);
      continue;
    }
    const row = m.plakyId === null ? undefined : byId.get(m.plakyId);
    if (!row) {
      out.gone.push(`${label}: Plaky row ${m.plakyId ?? "?"} is not on the board any more`);
      out.goneIds.push(m.mondayId);
      continue;
    }
    if (row.mondayId !== m.mondayId) {
      keep(`${label}: Plaky row ${row.id} '${row.title}' carries Monday ID ${row.mondayId ?? "(none)"} now; not deleted`);
      continue;
    }
    ours.add(row.id);
  }
  const created = await createdByMigration(db, migrationId, "item.created", "plakyItemId", ours);
  for (const id of [...ours]) {
    if (created.has(id)) continue;
    ours.delete(id);
    const m = mapped.items.find((x) => x.plakyId === id)!;
    keep(`monday item ${m.mondayId}: Plaky row ${id} '${byId.get(id)!.title}' was not created by a run of this migration (it existed before, or its create was never confirmed); not deleted`);
  }
  const nestedOurs = new Map(mapped.nested.filter((m) => m.plakyId !== null).map((m) => [m.plakyId!, m.mondayId]));
  for (const id of [...ours]) {
    const foreign = rows.filter((r) => r.parent === id && !ours.has(r.id) && !nestedOurs.has(r.id));
    if (foreign.length) {
      ours.delete(id);
      keep(`Plaky row ${id} '${byId.get(id)!.title}': holds ${foreign.length} nested row(s) this migration did not write; not deleted`);
    } else if (archivedUnder.has(id)) {
      ours.delete(id);
      keep(`Plaky row ${id} '${byId.get(id)!.title}': holds ${archivedUnder.get(id)} archived nested row(s); not deleted`);
    }
  }
  const fileIds = await mappedFileIds(db, migrationId);
  const ourFiles: OurFiles = async () => fileIds;
  const at = { space: board.plakySpaceId, board: board.plakyBoardId };
  for (const id of [...ours]) {
    const row = byId.get(id)!;
    const own = await plakyWork(plaky, at, row, ourFiles);
    const why = worked(own) ? [workText(own)] : [];
    const total = { ...own };
    for (const n of rows.filter((r) => r.parent === id && nestedOurs.has(r.id))) {
      const work = await plakyWork(plaky, at, n, ourFiles);
      if (!worked(work)) continue;
      why.push(workText(work, n.title));
      total.comments += work.comments;
      total.files += work.files;
    }
    if (!why.length) continue;
    ours.delete(id);
    const mondayId = mapped.items.find((x) => x.plakyId === id)!.mondayId;
    keep(`'${row.title}' (monday ${mondayId}): ${why.join("; ")}; kept`);
    out.worked.push({ mondayId, plakyId: id, title: row.title, ...total });
  }
  const mondayOf = new Map(mapped.items.filter((m) => m.plakyId !== null && ours.has(m.plakyId)).map((m) => [m.plakyId!, m.mondayId]));
  out.items = rows.filter((r) => ours.has(r.id)).map((r) => ({ mondayId: mondayOf.get(r.id)!, plakyId: r.id, title: r.title }));
  out.nested = rows.filter((r) => r.parent !== null && ours.has(r.parent) && nestedOurs.has(r.id)).map((r) => ({ mondayId: nestedOurs.get(r.id)!, plakyId: r.id, title: r.title, parent: r.parent! }));

  const foreignIds = rows.filter((r) => r.mondayId !== null && !ours.has(r.id) && !nestedOurs.has(r.id) && !mapped.items.some((m) => m.plakyId === r.id || m.mondayId === r.mondayId));
  if (foreignIds.length) out.kept.push(`${foreignIds.length} row(s) carry a Monday ID this migration has no record of writing; not deleted`);

  const createdGroups = await createdByMigration(db, migrationId, "group.created", "plakyGroupId", new Set(mapped.groups.flatMap((m) => (m.plakyId === null ? [] : [m.plakyId]))));
  for (const m of mapped.groups) {
    if (m.plakyId === null || !createdGroups.has(m.plakyId)) continue;
    const title = groups.get(m.plakyId);
    if (title === undefined) {
      out.gone.push(`group ${m.plakyId}: not on the board any more`);
      out.goneGroupIds.push(m.plakyId);
      continue;
    }
    if (m.plakyId === board.seedGroupId) continue;
    const staying = rows.filter((r) => r.group === m.plakyId && !ours.has(r.id)).length;
    if (staying) out.kept.push(`group '${title}': still holds ${staying} row(s) that are not deleted; not deleted`);
    else out.groups.push({ plakyId: m.plakyId, title });
  }
  if (out.groups.length && out.groups.length === groups.size) {
    const last = out.groups.pop()!;
    out.kept.push(`group '${last.title}': the board's last group, which Plaky does not delete; it stays, empty, and the next move uses it`);
  }
  return { preview: out, byId, ourFiles };
}

const textOf = (error: unknown): string => (error instanceof Error ? error.message : String(error)).slice(0, 300);

type UndoExpected = { items: readonly number[]; groups: readonly number[] };

const sameIdSet = (a: readonly number[], b: readonly number[]): boolean => {
  if (a.length !== b.length) return false;
  const sortedB = [...b].sort((x, y) => x - y);
  return [...a].sort((x, y) => x - y).every((id, i) => id === sortedB[i]);
};

const stillAsShown = (expected: UndoExpected, preview: UndoPreview, byId: ReadonlyMap<number, Row>): boolean => {
  const worked = new Set(preview.worked.map((w) => w.plakyId));
  const holding = new Set(preview.worked.map((w) => byId.get(w.plakyId)?.group));
  return sameIdSet(expected.items.filter((id) => !worked.has(id)), preview.items.map((i) => i.plakyId))
    && sameIdSet(expected.groups.filter((id) => !holding.has(id)), preview.groups.map((g) => g.plakyId));
};

export async function applyUndo(
  db: Db, migrationId: number, plaky: PlakyClient, mondayBoardId: string, confirm: string, log: PipelineLog = () => undefined, expected?: UndoExpected,
  owner?: string,
): Promise<UndoResult> {
  const loaded = await loadLinkConfig(db, migrationId);
  if (!loaded) throw new PreconditionError("link first: this migration has no config");
  const board = boardOf(loaded.config, mondayBoardId);
  if (confirm.trim() !== board.name.trim()) throw new PreconditionError(`type the board's name, "${board.name}", to confirm`);
  const store = new DbLoadStore({ db, migrationId, ...(owner === undefined ? {} : { owner }) });
  return withBoardLocks(store, [{ space: board.plakySpaceId, board: board.plakyBoardId }], async () => {
    const { preview, byId, ourFiles } = await previewWith(db, migrationId, plaky, mondayBoardId);
    if (expected && !stillAsShown(expected, preview, byId)) {
      throw new PreconditionError("Plaky changed since the dry run (a run wrote to the board meanwhile): preview the undo again");
    }
    const result: UndoResult = { ...preview, deletedItems: 0, deletedNested: 0, deletedGroups: 0, failures: [], reset: false };
    const type = board.subitemsOf ? "subitem" : "item";
    const forget = async (mondayIds: readonly string[], entityType: "item" | "subitem" = type): Promise<void> => {
      for (let at = 0; at < mondayIds.length; at += FORGET_SLICE) {
        const slice = mondayIds.slice(at, at + FORGET_SLICE);
        await db.delete(entityMappings).where(and(eq(entityMappings.migrationId, migrationId), eq(entityMappings.entityType, entityType), eq(entityMappings.scope, ""), inArray(entityMappings.mondayId, slice)));
        await db.delete(entityMappings).where(and(eq(entityMappings.migrationId, migrationId), inArray(entityMappings.entityType, ["comment", "file"]), inArray(entityMappings.scope, slice)));
      }
    };
    const nestedUnder = new Map<number, string[]>();
    const nestedIds = new Set(preview.nested.map((n) => `${n.parent}/${n.plakyId}`));
    for (const n of preview.nested) nestedUnder.set(n.parent, [...(nestedUnder.get(n.parent) ?? []), n.mondayId]);
    const held = async (): Promise<boolean> => {
      let ok = false;
      try {
        ok = await store.heartbeat();
      } catch {
        ok = false;
      }
      if (!ok) result.failures.push(`stopped: the lease on Plaky board ${board.plakySpaceId}/${board.plakyBoardId} was lost; undo again to finish`);
      return ok;
    };
    await forget(preview.goneIds);
    if (preview.goneGroupIds.length) {
      await db.delete(entityMappings).where(and(eq(entityMappings.migrationId, migrationId), eq(entityMappings.entityType, "group"), eq(entityMappings.scope, board.mondayBoardId), inArray(entityMappings.plakyId, preview.goneGroupIds)));
    }
    if (preview.items.length || preview.groups.length) await clearSyncPoints(db, migrationId, [mondayBoardId]);
    const left = new Set(preview.items.map((i) => i.plakyId));
    let stopped = false;
    for (const item of preview.items) {
      if (!(await held())) {
        stopped = true;
        break;
      }
      try {
        const check = await checkBeforeDelete(plaky, { space: board.plakySpaceId, board: board.plakyBoardId }, item.plakyId, { ourFiles, ourNested: (n) => nestedIds.has(`${item.plakyId}/${Number(n.id)}`) });
        if (check.why.length) {
          result.kept.push(`'${item.title}' (monday ${item.mondayId}): ${check.why.join("; ")}; kept`);
          result.keptItems++;
          if (worked(check.work)) result.worked.push({ ...item, ...check.work });
          log({ level: "info", code: "undo.item_kept", board: board.name, message: `item '${item.title}' kept: ${check.why.join("; ")}`, data: { mondayItemId: item.mondayId, plakyItemId: item.plakyId } });
          continue;
        }
        await plaky.deleteItem(board.plakySpaceId, board.plakyBoardId, item.plakyId, { subitemsBehaviour: check.subitemsBehaviour });
      } catch (error) {
        if (!isPlakyNotFound(error)) {
          const why = isOutcomeUnknown(error) ? `delete dispatched, outcome unknown (${textOf(error)}); the next undo checks again` : textOf(error);
          result.failures.push(`item '${item.title}' (monday ${item.mondayId}): ${why}`);
          log({ level: isOutcomeUnknown(error) ? "ambiguous" : "error", code: "undo.item_failed", board: board.name, message: `item '${item.title}': ${why}`, data: { mondayItemId: item.mondayId, plakyItemId: item.plakyId } });
          if (isRateLimited(error)) {
            stopped = true;
            break;
          }
          continue;
        }
      }
      await forget([item.mondayId]);
      await forget(nestedUnder.get(item.plakyId) ?? [], "subitem");
      left.delete(item.plakyId);
      result.deletedItems++;
      result.deletedNested += nestedUnder.get(item.plakyId)?.length ?? 0;
      log({ level: "info", code: "undo.item_deleted", board: board.name, message: `item '${item.title}' deleted`, data: { mondayItemId: item.mondayId, plakyItemId: item.plakyId } });
    }
    if (left.size === 0 && preview.keptItems === 0) {
      await markBoardUnapplied(db, migrationId, mondayBoardId);
      result.reset = true;
    }
    const stillIn = stopped || !preview.groups.length ? new Set<number | null>() : new Set((await readBoard(plaky, board)).rows.map((r) => r.group));
    for (const group of stopped ? [] : preview.groups) {
      if (stillIn.has(group.plakyId)) {
        result.kept.push(`group '${group.title}': still holds rows; not deleted`);
        continue;
      }
      if (!(await held())) break;
      try {
        await plaky.deleteItemGroup(board.plakySpaceId, board.plakyBoardId, group.plakyId);
      } catch (error) {
        if (!isPlakyNotFound(error)) {
          result.failures.push(`group '${group.title}': ${textOf(error)}`);
          log({ level: "error", code: "undo.group_failed", board: board.name, message: `group '${group.title}': ${textOf(error)}` });
          if (isRateLimited(error)) break;
          continue;
        }
      }
      await db.delete(entityMappings).where(and(eq(entityMappings.migrationId, migrationId), eq(entityMappings.entityType, "group"), eq(entityMappings.scope, board.mondayBoardId), eq(entityMappings.plakyId, group.plakyId)));
      result.deletedGroups++;
      log({ level: "info", code: "undo.group_deleted", board: board.name, message: `group '${group.title}' deleted`, data: { plakyGroupId: group.plakyId } });
    }
    return result;
  });
}
