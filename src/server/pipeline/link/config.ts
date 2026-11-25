import { FIELD_KEY, parseSyncConfig, type PeopleMap, type SyncConfig } from "../config";
import { truthy } from "../transform/pystr";
import { strOf } from "../transform/pyvalue";
import type { JsonObject, LegacyConfig, SeededBoard, BoardLink } from "./types";

export const HAND_SET = ["label_map", "sync_groups", "sync_subscribers", "sync_comments", "sync_files", "applied"] as const;

export function buildConfig(
  links: readonly BoardLink[],
  space: number,
  people: PeopleMap | null = null,
  options: { previous?: JsonObject | null; comments?: boolean | null; files?: boolean | null; subscribers?: boolean } = {},
): LegacyConfig {
  const earlier = new Map(asList(options.previous?.boards).map((entry) => [strOf(entry.monday_board_id), entry]));

  const optionsOf = (link: BoardLink): JsonObject => {
    const kept: JsonObject = Object.fromEntries(Object.entries(earlier.get(link.mondayBoardId) ?? {}).filter(([key]) => (HAND_SET as readonly string[]).includes(key)));
    if (!Object.hasOwn(kept, "sync_comments")) kept.sync_comments = false;
    if (!Object.hasOwn(kept, "sync_files")) kept.sync_files = false;
    if (options.comments !== undefined && options.comments !== null) kept.sync_comments = options.comments;
    if (options.files !== undefined && options.files !== null) kept.sync_files = options.files;
    if (options.subscribers) kept.sync_subscribers = true;
    else if (options.subscribers === false) delete kept.sync_subscribers;
    return kept;
  };

  return {
    ...(people && Object.keys(people).length ? { people: { ...people } } : {}),
    boards: links.map((link) => ({
      name: link.name,
      monday_board_id: link.mondayBoardId,
      plaky_space_id: space,
      plaky_board_id: link.plakyBoardId,
      field_map: { ...link.fieldMap },
      skip_columns: [...link.skipColumns],
      monday_id_field: link.mondayIdKey,
      ...(link.seedGroupId ? { seed_group_id: link.seedGroupId } : {}),
      ...optionsOf(link),
      ...(link.subitemsOf
        ? link.nested
          ? { subitems_of: link.subitemsOf, nested: true, sync_groups: false }
          : { subitems_of: link.subitemsOf, parent_title_field: link.parentTitleKey, parent_id_field: link.parentIdKey }
        : {}),
    })),
  };
}

export const toSyncConfig = (config: LegacyConfig): SyncConfig => parseSyncConfig(config, "link config");

const LINKED_KEYS = ["monday_id_field", "parent_title_field", "parent_id_field"] as const;

function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((v, i) => same(v, b[i]));
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null || Array.isArray(b)) return false;
  const left = Object.entries(a);
  return left.length === Object.keys(b).length && left.every(([k, v]) => Object.hasOwn(b, k) && same(v, (b as JsonObject)[k]));
}

export const asList = (value: unknown): JsonObject[] => (Array.isArray(value) ? (value as JsonObject[]) : []);
export const asMap = (value: unknown): JsonObject => (truthy(value) ? (value as JsonObject) : {});

export function safeChanges(existing: JsonObject, built: JsonObject, liveKeys: ReadonlyMap<string, ReadonlySet<string>>): string[] | null {
  if (!Object.keys(existing).every((k) => k === "boards" || k === "people")) return null;
  const now = new Map(asList(built.boards).map((b) => [strOf(b.monday_board_id), b]));
  const old = asList(existing.boards);
  const changes: string[] = [];
  for (const entry of old) {
    const boardId = strOf(entry.monday_board_id);
    const next = now.get(boardId);
    if (next === undefined) return null;
    if (same(next, entry)) continue;
    const pairs = (e: JsonObject): Map<string, unknown> => {
      const out = new Map<string, unknown>(Object.entries(asMap(e.field_map)));
      for (const k of LINKED_KEYS) out.set(k, e[k] ?? null);
      return out;
    };
    const before = pairs(entry);
    const after = pairs(next);
    const unkeyed = { field_map: null, ...Object.fromEntries(LINKED_KEYS.map((k) => [k, null])) };
    if (!same({ ...entry, ...unkeyed }, { ...next, ...unkeyed })) return null;
    const live = liveKeys.get(boardId) ?? new Set<string>();
    const kept = [...before].filter(([, key]) => key !== null && ((typeof key === "string" && live.has(key)) || !FIELD_KEY.test(strOf(key)))).map(([column]) => column);
    if (kept.some((column) => !same(after.get(column) ?? null, before.get(column)))) return null;
    const repaired = [...before].filter(([column, key]) => !same(after.get(column) ?? null, key)).map(([column]) => column);
    if (repaired.some((column) => (after.get(column) ?? null) === null)) return null;
    changes.push(...repaired.map((c) => `${strOf(entry.name)}: ${strOf(before.get(c))} -> ${strOf(after.get(c))}`));
    changes.push(...[...after.keys()].filter((c) => !before.has(c)).map((c) => `${strOf(entry.name)}: ${c} -> ${strOf(after.get(c))}`));
  }
  const people = asMap(built.people);
  if (Object.entries(asMap(existing.people)).some(([key, value]) => !same(people[key] ?? null, value))) return null;
  const paired = new Set(old.map((b) => strOf(b.monday_board_id)));
  return [...[...now].filter(([key]) => !paired.has(key)).map(([, b]) => strOf(b.name)), ...changes];
}

export const liveKeysOf = (seeded: ReadonlyMap<string, SeededBoard>): Map<string, Set<string>> =>
  new Map([...seeded].map(([boardId, found]) => [boardId, new Set(found.fields.map((f) => f.key))]));

export type RelinkDecision =
  | { action: "write"; changes: string[] | null }
  | { action: "reuse" }
  | { action: "confirm" };

export function decideRelink(existing: JsonObject | null, built: JsonObject, liveKeys: ReadonlyMap<string, ReadonlySet<string>>, force = false): RelinkDecision {
  const changes = existing !== null && Object.keys(existing).length ? safeChanges(existing, built, liveKeys) : null;
  if (existing !== null && !force && changes === null) return { action: "confirm" };
  if (existing !== null && same(existing, built)) return { action: "reuse" };
  return { action: "write", changes: changes?.length ? changes : null };
}
