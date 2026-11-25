import { MONDAY_ID_FIELD, PARENT_ID_FIELD, PARENT_TITLE_FIELD } from "./names";
import { pyRepr } from "./transform/pyvalue";

export const TEAM_KEY = "team:";
export const FIELD_KEY = /^[a-z_]+-\d+$/;

const PEOPLE_FORMS = ["user_id", "email", "team_id", "team", "skip", "header", "stand_in"] as const;
type PeopleForm = (typeof PEOPLE_FORMS)[number];
export type PeopleEntry = Partial<Record<PeopleForm, string | number | boolean>>;
export type PeopleMap = Record<string, PeopleEntry>;

export type BoardSync = {
  name: string;
  mondayBoardId: string;
  plakySpaceId: number;
  plakyBoardId: number;
  fieldMap: Record<string, string>;
  skipColumns: string[];
  labelMap: Record<string, Record<string, string>>;
  mondayIdField: string | null;
  subitemsOf: string | null;
  nested: boolean;
  parentTitleField: string | null;
  parentIdField: string | null;
  syncGroups: boolean;
  syncSubscribers: boolean;
  syncComments: boolean;
  syncFiles: boolean;
  seedGroupId: number | null;
  applied: boolean;
};

export type SyncConfig = { boards: BoardSync[]; people: PeopleMap };

const BOARD_KEYS = [
  "name", "monday_board_id", "plaky_space_id", "plaky_board_id", "field_map", "skip_columns", "label_map",
  "monday_id_field", "subitems_of", "parent_title_field", "parent_id_field", "sync_groups", "sync_subscribers",
  "sync_comments", "sync_files", "seed_group_id", "applied",
] as const;
const TOP_LEVEL_KEYS = ["boards", "people"] as const;
const REMOVED_KEYS: Record<string, string> = {
  nest_under_parent: "was removed in 0.4.0: subitems go to a board of their own",
};

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);
const truthy = (v: unknown): boolean => !(v === null || v === undefined || v === false || v === 0 || v === "" || (Array.isArray(v) && v.length === 0) || (isObj(v) && Object.keys(v).length === 0));

function matched(a: readonly string[], b: readonly string[], alo: number, ahi: number, blo: number, bhi: number): number {
  let [besti, bestj, size] = [alo, blo, 0];
  let run = new Map<number, number>();
  for (let i = alo; i < ahi; i++) {
    const next = new Map<number, number>();
    for (let j = blo; j < bhi; j++) {
      if (a[i] !== b[j]) continue;
      const k = (run.get(j - 1) ?? 0) + 1;
      next.set(j, k);
      if (k > size) [besti, bestj, size] = [i - k + 1, j - k + 1, k];
    }
    run = next;
  }
  return size === 0 ? 0 : size + matched(a, b, alo, besti, blo, bestj) + matched(a, b, besti + size, ahi, bestj + size, bhi);
}

function closeMatch(key: string, known: readonly string[]): string | undefined {
  const word = Array.from(key);
  let best: string | undefined;
  let bestScore = 0.6;
  for (const k of known) {
    const chars = Array.from(k);
    const score = (2 * matched(chars, word, 0, chars.length, 0, word.length)) / (chars.length + word.length);
    if (score > bestScore || (score === bestScore && (best === undefined || k > best))) [best, bestScore] = [k, score];
  }
  return best;
}

function pyInt(value: unknown): number | undefined {
  const n =
    typeof value === "number" ? Math.trunc(value)
    : typeof value === "boolean" ? Number(value)
    : typeof value === "string" && /^[+-]?\d+(?:_\d+)*$/.test(value.trim()) ? Number(value.trim().replaceAll("_", ""))
    : NaN;
  return Number.isSafeInteger(n) ? n : undefined;
}

const APP_KEYS = ["nested"] as const;

function refuseUnknownKeys(entry: Obj, known: readonly string[], path: string, where: string): void {
  for (const key of Object.keys(entry)) {
    const removed = REMOVED_KEYS[key];
    if (removed) throw new Error(`${path}: ${where} sets '${key}', which ${removed}`);
    if ((APP_KEYS as readonly string[]).includes(key) && known === BOARD_KEYS) continue;
    if (!known.includes(key)) {
      const close = closeMatch(key, known);
      throw new Error(`${path}: ${where} has an unknown key '${key}'${close ? ` (did you mean '${close}'?)` : ""}. Known keys: ${known.join(", ")}`);
    }
  }
}

function parsePeople(value: unknown, path: string): PeopleMap {
  if (value === null || value === undefined) return {};
  if (!isObj(value)) throw new Error(`${path}: 'people' must be a JSON object`);
  const out: PeopleMap = {};
  for (const [key, entry] of Object.entries(value)) {
    const forms = isObj(entry) ? Object.keys(entry) : [];
    if (!isObj(entry) || forms.length !== 1 || !(PEOPLE_FORMS as readonly string[]).includes(forms[0]!)) {
      throw new Error(`${path}: people[${pyRepr(key)}] must be one of ${PEOPLE_FORMS.map((f) => `{"${f}": ...}`).join(", ")}`);
    }
    const form = forms[0]! as PeopleForm;
    const target = entry[form];
    if (form === "stand_in" && key.startsWith(TEAM_KEY)) throw new Error(`${path}: people[${pyRepr(key)}] is a monday team; stand_in is for a person`);
    const valid =
      form === "skip" || form === "header" ? target === true
      : form === "user_id" || form === "team_id" || form === "stand_in" ? isInt(target) && target > 0
      : typeof target === "string" && target.trim() !== "";
    if (!valid) throw new Error(`${path}: people[${pyRepr(key)}].${form} has an invalid value ${pyRepr(target)}`);
    out[key] = { [form]: target as string | number | boolean };
  }
  return out;
}

function jsonBool(entry: Obj, index: number, path: string, key: string, fallback: boolean): boolean {
  const value = key in entry ? entry[key] : fallback;
  if (typeof value !== "boolean") throw new Error(`${path}: boards[${index}].${key} must be a JSON boolean`);
  return value;
}

export function parseSyncConfig(raw: unknown, path = "config"): SyncConfig {
  if (!isObj(raw)) throw new Error(`${path}: top level must be a JSON object`);
  refuseUnknownKeys(raw, TOP_LEVEL_KEYS, path, "the top level");
  const entries = raw.boards;
  if (!Array.isArray(entries) || entries.length === 0) throw new Error(`${path}: 'boards' must be a non-empty list`);
  const boards: BoardSync[] = entries.map((entry: unknown, index) => {
    if (!isObj(entry)) throw new Error(`${path}: boards[${index}] must be a JSON object`);
    refuseUnknownKeys(entry, BOARD_KEYS, path, `boards[${index}]`);
    const missing = ["monday_board_id", "plaky_space_id", "plaky_board_id"].filter((k) => entry[k] === undefined || entry[k] === null || entry[k] === "");
    if (missing.length) throw new Error(`${path}: boards[${index}] is missing [${missing.map((m) => `'${m}'`).join(", ")}]`);
    const ids: Record<string, number> = {};
    for (const key of ["plaky_space_id", "plaky_board_id"]) {
      const n = pyInt(entry[key]);
      if (n === undefined) throw new Error(`${path}: boards[${index}].${key} must be an integer`);
      if (n <= 0) throw new Error(`${path}: boards[${index}].${key} must be a real id`);
      ids[key] = n;
    }
    const fieldMap = (truthy(entry.field_map) ? entry.field_map : {}) as unknown;
    if (!isObj(fieldMap) || Object.values(fieldMap).some((v) => typeof v !== "string")) throw new Error(`${path}: boards[${index}].field_map must map strings to strings`);
    const skip = (truthy(entry.skip_columns) ? entry.skip_columns : []) as unknown;
    if (!Array.isArray(skip) || !skip.every((v) => typeof v === "string")) throw new Error(`${path}: boards[${index}].skip_columns must be a list of strings`);
    const labelMap = (truthy(entry.label_map) ? entry.label_map : {}) as unknown;
    if (!isObj(labelMap) || Object.values(labelMap).some((v) => !isObj(v) || Object.values(v).some((x) => typeof x !== "string"))) {
      throw new Error(`${path}: boards[${index}].label_map must map strings to string mappings`);
    }
    const optionalString = (key: string, fallback: string | null): string | null => {
      const value = key in entry ? entry[key] : fallback;
      if (value !== null && typeof value !== "string") throw new Error(`${path}: boards[${index}].${key} must be a string or null`);
      return value;
    };
    const mondayIdField = optionalString("monday_id_field", MONDAY_ID_FIELD);
    const parentTitleField = optionalString("parent_title_field", PARENT_TITLE_FIELD);
    const parentIdField = optionalString("parent_id_field", PARENT_ID_FIELD);
    const subitemsOf = entry.subitems_of ?? null;
    if (subitemsOf !== null && typeof subitemsOf !== "string") throw new Error(`${path}: boards[${index}].subitems_of must be a string or null`);
    const nested = jsonBool(entry, index, path, "nested", false);
    if (nested && !subitemsOf) throw new Error(`${path}: boards[${index}] sets 'nested' but no 'subitems_of': only a subitem board can nest under its parent`);
    const seed = entry.seed_group_id ?? null;
    if (seed !== null && (typeof seed !== "number" || !Number.isInteger(seed) || seed <= 0)) {
      throw new Error(`${path}: boards[${index}].seed_group_id must be a positive integer or null`);
    }
    const mondayBoardId = String(entry.monday_board_id);
    return {
      name: typeof entry.name === "string" && entry.name ? entry.name : mondayBoardId,
      mondayBoardId,
      plakySpaceId: ids.plaky_space_id!,
      plakyBoardId: ids.plaky_board_id!,
      fieldMap: { ...(fieldMap as Record<string, string>) },
      skipColumns: [...skip] as string[],
      labelMap: Object.fromEntries(Object.entries(labelMap as Record<string, Record<string, string>>).map(([k, v]) => [k, { ...v }])),
      mondayIdField,
      subitemsOf: subitemsOf || null,
      nested,
      parentTitleField,
      parentIdField,
      syncGroups: jsonBool(entry, index, path, "sync_groups", true),
      syncSubscribers: jsonBool(entry, index, path, "sync_subscribers", false),
      syncComments: jsonBool(entry, index, path, "sync_comments", false),
      syncFiles: jsonBool(entry, index, path, "sync_files", false),
      seedGroupId: seed,
      applied: jsonBool(entry, index, path, "applied", false),
    };
  });
  validateBoards(boards, path);
  return { boards, people: parsePeople(raw.people, path) };
}

function validateBoards(boards: BoardSync[], path = "config"): void {
  const seenSources = new Map<string, number>();
  boards.forEach((board, index) => {
    const previous = seenSources.get(board.mondayBoardId);
    if (previous === undefined) seenSources.set(board.mondayBoardId, index);
    else throw new Error(`${path}: boards[${index}].monday_board_id duplicates boards[${previous}] (${board.mondayBoardId})`);
  });
  const bySource = new Map(boards.map((b) => [b.mondayBoardId, b]));
  for (const board of boards) {
    const chain = new Set<string>();
    let cursor: BoardSync | undefined = board;
    while (cursor?.subitemsOf) {
      if (chain.has(cursor.mondayBoardId)) throw new Error(`${path}: subitems_of relationship for '${board.name}' contains a cycle`);
      chain.add(cursor.mondayBoardId);
      cursor = bySource.get(cursor.subitemsOf);
    }
  }
  for (const board of boards) {
    if (board.subitemsOf && !bySource.has(board.subitemsOf)) throw new Error(`${path}: '${board.name}' refers to missing parent monday board ${pyRepr(board.subitemsOf)}`);
    if (board.nested) {
      const parent = bySource.get(board.subitemsOf ?? "");
      if (parent && (parent.plakySpaceId !== board.plakySpaceId || parent.plakyBoardId !== board.plakyBoardId)) {
        throw new Error(`${path}: '${board.name}' is nested but names Plaky space/board ${board.plakySpaceId}/${board.plakyBoardId}, not its parent's Plaky board ${parent.plakySpaceId}/${parent.plakyBoardId}`);
      }
    }
  }
  const seenTargets = new Map<string, BoardSync>();
  for (const board of boards) {
    const target = `${board.plakySpaceId}/${board.plakyBoardId}`;
    const first = seenTargets.get(target);
    if (!first) seenTargets.set(target, board);
    else if (!((board.nested && board.subitemsOf === first.mondayBoardId) || (first.nested && first.subitemsOf === board.mondayBoardId))) {
      throw new Error(`${path}: '${first.name}' and '${board.name}' both name Plaky space/board ${target}; each monday board, and each subitem board, needs a Plaky board of its own`);
    }
  }
}

function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (isObj(v)) return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`;
  return JSON.stringify(v) ?? "null";
}

export function boardsWritingDifferently(prev: SyncConfig, next: SyncConfig): string[] {
  const writes = (b: BoardSync): string => canonical({ ...b, name: null, seedGroupId: null, applied: null });
  if (canonical(prev.people) !== canonical(next.people)) return next.boards.map((b) => b.mondayBoardId);
  const before = new Map(prev.boards.map((b) => [b.mondayBoardId, writes(b)]));
  return next.boards.filter((b) => before.get(b.mondayBoardId) !== writes(b)).map((b) => b.mondayBoardId);
}
