import { currentManualTasks } from "../../lib/manual-work";
import { isLevelEntry } from "./names";
import { ITEM_TITLE_HEADER, MONDAY_ID_FIELD, PARENT_ID_FIELD, PARENT_TITLE_FIELD } from "./names";
import { PLAKY_TYPE_LABEL, compatibleTypes } from "./transform/compat";
import { isDict, pyOr, pyStr, truthy } from "./transform/pystr";
import { pyRepr } from "./transform/pyvalue";

export const TESTED_MAX_COLUMNS = 80;
export const TESTED_MAX_LABELS = 60;
export const SEED_ROW_LIMIT = 3000;
export const FREE_PLAN_FIELDS = 6;

export type ImportAs = "Assignee" | "Due Date" | "Dropdown";

export type ColumnPlan = {
  id: string;
  title: string;
  type: string;
  fieldName: string;
  plakyType: string | null;
  reason: string | null;
  labels: readonly string[];
  labelCollisions: readonly string[];
  importAs?: ImportAs;
  assigned?: readonly string[];
};

export function columnPlan(init: Pick<ColumnPlan, "id" | "title" | "type" | "fieldName" | "plakyType"> & Partial<ColumnPlan>): ColumnPlan {
  return { reason: null, labels: [], labelCollisions: [], ...init };
}

export type DiscoveredBoard = {
  id: string;
  name: string;
  itemsCount: number;
  columns: readonly ColumnPlan[];
  subitemBoardId: string | null;
  parentBoardId: string | null;
  plakyBoardId: number | null;
  hierarchyType: string;
  carriesLevelTwo?: boolean;
  levelBoards?: boolean;
  byHand: readonly string[];
  nested: boolean;
  nestedColumns: readonly ColumnPlan[];
  archivedItems: number;
  deletedItems: number;
  archivedGroups: readonly string[];
};

export function discoveredBoard(init: Pick<DiscoveredBoard, "id" | "name"> & Partial<DiscoveredBoard>): DiscoveredBoard {
  return { itemsCount: 0, columns: [], subitemBoardId: null, parentBoardId: null, plakyBoardId: null, hierarchyType: "classic", byHand: [], nested: false, nestedColumns: [], archivedItems: 0, deletedItems: 0, archivedGroups: [], ...init };
}

export type DiscoveredPerson = {
  id: string;
  kind: string;
  name: string;
  email: string | null;
  state: string;
  placeholder: string | null;
  members: readonly string[];
  boards: readonly string[];
};

export function discoveredPerson(init: Pick<DiscoveredPerson, "id" | "kind" | "name"> & Partial<DiscoveredPerson>): DiscoveredPerson {
  return { email: null, state: "active", placeholder: null, members: [], boards: [], ...init };
}

export type SkippedBoard = { id: string; name: string; kind: string; reason: string };

export type Manifest = {
  boards: readonly DiscoveredBoard[];
  skipped: readonly SkippedBoard[];
  generatedAt: string;
  people: readonly DiscoveredPerson[];
};

export function manifest(init: Partial<Manifest> = {}): Manifest {
  return { boards: [], skipped: [], generatedAt: "", people: [], ...init };
}

export const isSubitemBoard = (board: Pick<DiscoveredBoard, "parentBoardId">): boolean => board.parentBoardId !== null;
export const isImportable = (column: Pick<ColumnPlan, "plakyType" | "type">): boolean => column.type !== "file" && column.plakyType !== null;
export const importable = (board: Pick<DiscoveredBoard, "columns">): ColumnPlan[] => board.columns.filter(isImportable);
export const dropped = (board: Pick<DiscoveredBoard, "columns">): ColumnPlan[] => board.columns.filter((c) => !isImportable(c));
export const seededColumns = (board: Pick<DiscoveredBoard, "columns" | "nestedColumns">): ColumnPlan[] => [...importable(board), ...(board.nestedColumns ?? []).filter(isImportable)];

type SeedShape = Pick<DiscoveredBoard, "parentBoardId" | "columns"> & Partial<Pick<DiscoveredBoard, "nested" | "nestedColumns">>;

export function seedHeaders(board: SeedShape): string[] {
  const headers = [ITEM_TITLE_HEADER, MONDAY_ID_FIELD];
  if (isSubitemBoard(board) && !board.nested) headers.push(PARENT_TITLE_FIELD, PARENT_ID_FIELD);
  return [...headers, ...seededColumns({ columns: board.columns, nestedColumns: board.nestedColumns ?? [] }).map((c) => c.fieldName)];
}

export const fieldCount = (board: SeedShape): number => seedHeaders(board).length - 1;

function freePlanWarning(board: SeedShape): string | null {
  const fields = fieldCount(board);
  return fields > FREE_PLAN_FIELDS ? `${fields} fields: Plaky's Free plan allows ${FREE_PLAN_FIELDS} per board, so this board needs Plaky Pro, Business or Enterprise.` : null;
}

export const seedRowsNeeded = (board: Pick<DiscoveredBoard, "columns" | "nestedColumns">): number => Math.max(1, ...seededColumns(board).map((c) => c.labels.length));

export function boardWarnings(board: DiscoveredBoard, options: { planLimit?: boolean } = {}): string[] {
  if (isLevelEntry(board.id)) return [];
  const planLimit = options.planLimit ?? true;
  const out: string[] = [];
  if (board.hierarchyType === "multi_level") {
    out.push(board.levelBoards
      ? "a multi-level board whose subitems have subitems: Plaky nests one level, so nothing nests here, and each level goes on a board of its own, linked by Parent Item."
      : board.carriesLevelTwo
      ? "a multi-level board: its first two levels migrate, level 2 as subitems. Plaky nests one level of subitems, so deeper items have nowhere to go: each is listed, and its comments and files stay in monday."
      : "a multi-level board: only its top-level items migrate. Plaky nests one level of subitems, and the deeper levels have nowhere to go.");
  }
  const columns = seedHeaders(board).length;
  const freePlan = freePlanWarning(board);
  if (planLimit && freePlan) out.push(freePlan);
  const timelines = importable(board)
    .filter((c) => c.plakyType === "TIMELINE")
    .map(
      (c) =>
        compatibleTypes(c.type)
          .filter((t) => t !== "TIMELINE")
          .map((t) => (Object.hasOwn(PLAKY_TYPE_LABEL, t) ? PLAKY_TYPE_LABEL[t] : t))
          .join(" or ") + ` for '${c.fieldName}'`,
    )
    .join("; ");
  if (timelines) {
    out.push(`Timeline fields need a paid Plaky plan. On Free, pick another type for each in the import dialog (${timelines}); link reports the change.`);
  }
  if (columns > TESTED_MAX_COLUMNS) {
    out.push(`${columns} fields: past the ${TESTED_MAX_COLUMNS} verified on this plan. Plaky caps fields per board by subscription, so check the board after import.`);
  }
  for (const column of importable(board)) {
    if (column.labelCollisions.length) {
      out.push(
        `'${column.fieldName}' has labels that collapse under matching normalization (${column.labelCollisions.join(", ")}); ` +
          "all exact spellings are seeded, but matching uses the exact spelling; rename the monday labels to distinct names before using aliases or normalized matching.",
      );
    }
    if (column.labels.length > SEED_ROW_LIMIT) {
      out.push(
        `'${column.fieldName}' has ${column.labels.length} values, over the CSV import's ${SEED_ROW_LIMIT.toLocaleString("en-US")}-row limit. ` +
          "Its vocabulary cannot be seeded in one upload; split the file or create the field by hand.",
      );
    } else if (column.labels.length > TESTED_MAX_LABELS) {
      out.push(`'${column.fieldName}' has ${column.labels.length} values, past the ${TESTED_MAX_LABELS} verified. Expected to work; confirm after import.`);
    }
  }
  return out;
}

export const totalItems = (m: Pick<Manifest, "boards">): number => m.boards.reduce((sum, b) => sum + b.itemsCount, 0);

export function manifestWarnings(m: Pick<Manifest, "boards">): string[] {
  const out = m.boards.flatMap((board) => boardWarnings(board, { planLimit: false }).map((warning) => `${board.name}: ${warning}`));
  const crowded = m.boards.filter((b) => !(isLevelEntry(b.id) && b.nested) && fieldCount(b) > FREE_PLAN_FIELDS);
  if (crowded.length) {
    const named = crowded.map((b) => `${b.name} (${fieldCount(b)})`).join(", ");
    out.push(
      `${crowded.length} board(s) have more fields than the ${FREE_PLAN_FIELDS} per board that Plaky's Free plan allows, so they need Plaky Pro, Business or Enterprise: ${named}`,
    );
  }
  return out;
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

const columnJson = (c: ColumnPlan): Json => ({
  id: c.id,
  title: c.title,
  type: c.type,
  field_name: c.fieldName,
  plaky_type: c.plakyType,
  reason: c.reason,
  labels: [...c.labels],
  label_collisions: [...c.labelCollisions],
  ...(c.importAs ? { import_as: c.importAs } : {}),
  ...(c.assigned ? { assigned: [...c.assigned] } : {}),
});

export function toJson(m: Manifest): Json {
  return {
    generated_at: m.generatedAt,
    boards: m.boards.map((b) => ({
      id: b.id,
      name: b.name,
      items_count: b.itemsCount,
      subitem_board_id: b.subitemBoardId,
      parent_board_id: b.parentBoardId,
      plaky_board_id: b.plakyBoardId,
      hierarchy_type: b.hierarchyType,
      by_hand: [...b.byHand],
      columns: b.columns.map(columnJson),
      ...(b.nested ? { nested: true } : {}),
      ...(b.nestedColumns.length ? { nested_columns: b.nestedColumns.map(columnJson) } : {}),
      ...(b.carriesLevelTwo ? { carries_level_two: true } : {}),
      ...(b.levelBoards ? { level_boards: true } : {}),
      ...(b.archivedItems ? { archived_items: b.archivedItems } : {}),
      ...(b.deletedItems ? { deleted_items: b.deletedItems } : {}),
      ...(b.archivedGroups.length ? { archived_groups: [...b.archivedGroups] } : {}),
    })),
    skipped: m.skipped.map((s) => ({ id: s.id, name: s.name, kind: s.kind, reason: s.reason })),
    people: m.people.map((p) => ({
      id: p.id,
      kind: p.kind,
      name: p.name,
      email: p.email,
      state: p.state,
      placeholder: p.placeholder,
      members: [...p.members],
      boards: [...p.boards],
    })),
  };
}

export const toJsonText = (m: Manifest): string =>
  JSON.stringify(toJson(m), null, 2).replace(/[\u007f-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`) + "\n";

export class ManifestError extends Error {
  override name = "ManifestError";
}

function pyInt(value: unknown): number {
  if (typeof value === "boolean") return Number(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new ManifestError(`cannot convert ${pyStr(value)} to integer`);
    return Math.trunc(value);
  }
  if (typeof value === "string") {
    if (!/^\s*[+-]?\d+\s*$/.test(value)) throw new ManifestError(`invalid literal for int() with base 10: ${pyRepr(value)}`);
    return Number(value);
  }
  throw new ManifestError("int() argument must be a string, a bytes-like object or a real number");
}

export function parseManifest(raw: unknown, path = "migration.json"): Manifest {
  if (!isDict(raw)) throw new ManifestError(`${path}: the top level must be a JSON object`);

  const objects = (key: string): Record<string, unknown>[] => {
    const value = pyOr(raw[key], []);
    if (!Array.isArray(value) || !value.every(isDict)) throw new ManifestError(`${path}: '${key}' must be a list of JSON objects`);
    return value as Record<string, unknown>[];
  };
  const strings = (value: unknown, where: string): string[] => {
    const list = pyOr(value, []);
    if (!Array.isArray(list) || !list.every((v) => typeof v === "string")) throw new ManifestError(`${where} must be a list of strings`);
    return list as string[];
  };
  const optionalString = (value: unknown, where: string): string | null => {
    if (value === null || value === undefined) return null;
    if (typeof value !== "string") throw new ManifestError(`${where} must be a string or null`);
    return value;
  };

  const boards = objects("boards").map((b, index): DiscoveredBoard => {
    const where = `${path}: boards[${index}]`;
    if (typeof b["id"] !== "string" || typeof b["name"] !== "string") throw new ManifestError(`${where} needs a string 'id' and 'name'`);
    const columnsOf = (key: string): Record<string, unknown>[] => {
      const list = pyOr(b[key], []);
      if (!Array.isArray(list)) throw new ManifestError(`${where}.${key} must be a list`);
      list.forEach((c, at) => {
        if (!isDict(c) || !["id", "title", "type", "field_name"].every((k) => typeof c[k] === "string")) {
          throw new ManifestError(`${where}.${key}[${at}] needs a string 'id', 'title', 'type' and 'field_name'`);
        }
      });
      return list as Record<string, unknown>[];
    };
    const columns = columnsOf("columns");
    const nestedColumns = columnsOf("nested_columns");
    const parseColumn = (key: string) => (c: Record<string, unknown>, at: number): ColumnPlan => ({
      id: c["id"] as string,
      title: c["title"] as string,
      type: c["type"] as string,
      fieldName: c["field_name"] as string,
      plakyType: optionalString(c["plaky_type"], `${where}.${key}[${at}].plaky_type`),
      reason: optionalString(c["reason"], `${where}.${key}[${at}].reason`),
      labels: strings(c["labels"], `${where}.${key}[${at}].labels`),
      labelCollisions: strings(c["label_collisions"], `${where}.${key}[${at}].label_collisions`),
      ...(c["import_as"] ? { importAs: optionalString(c["import_as"], `${where}.${key}[${at}].import_as`) as ImportAs } : {}),
      ...(c["assigned"] === undefined ? {} : { assigned: strings(c["assigned"], `${where}.${key}[${at}].assigned`) }),
    });
    let itemsCount: number;
    let plakyBoardId: number | null;
    try {
      itemsCount = pyInt(pyOr(b["items_count"], 0));
      plakyBoardId = b["plaky_board_id"] !== null && b["plaky_board_id"] !== undefined ? pyInt(b["plaky_board_id"]) : null;
    } catch (error) {
      throw new ManifestError(`${where}: ${(error as Error).message}`);
    }
    return {
      id: b["id"],
      name: b["name"],
      itemsCount,
      subitemBoardId: optionalString(b["subitem_board_id"], `${where}.subitem_board_id`),
      parentBoardId: optionalString(b["parent_board_id"], `${where}.parent_board_id`),
      plakyBoardId,
      hierarchyType: pyStr(pyOr(b["hierarchy_type"], "classic")),
      byHand: currentManualTasks(strings(b["by_hand"], `${where}.by_hand`)),
      columns: columns.map(parseColumn("columns")),
      nested: b["nested"] === true,
      nestedColumns: nestedColumns.map(parseColumn("nested_columns")),
      ...(b["carries_level_two"] === true ? { carriesLevelTwo: true } : {}),
      ...(b["level_boards"] === true ? { levelBoards: true } : {}),
      archivedItems: typeof b["archived_items"] === "number" ? b["archived_items"] : 0,
      deletedItems: typeof b["deleted_items"] === "number" ? b["deleted_items"] : 0,
      archivedGroups: Array.isArray(b["archived_groups"]) ? b["archived_groups"].filter((g): g is string => typeof g === "string") : [],
    };
  });

  const skipped = objects("skipped").map((s, index): SkippedBoard => {
    for (const key of ["id", "name", "kind", "reason"]) {
      if (!Object.hasOwn(s, key)) throw new ManifestError(`${path}: skipped[${index}] has no '${key}'`);
    }
    return { id: pyStr(s["id"]), name: pyStr(s["name"]), kind: pyStr(s["kind"]), reason: pyStr(s["reason"]) };
  });

  const people = objects("people").map((p, index): DiscoveredPerson => {
    if (p["id"] === null || p["id"] === undefined) throw new ManifestError(`${path}: people[${index}] has no 'id'`);
    const where = `${path}: people[${index}]`;
    return {
      id: pyStr(p["id"]),
      kind: pyStr(pyOr(p["kind"], "person")),
      name: pyStr(pyOr(p["name"], p["id"])),
      email: optionalString(p["email"], `${where}.email`),
      state: pyStr(pyOr(p["state"], "active")),
      placeholder: optionalString(p["placeholder"], `${where}.placeholder`),
      members: strings(p["members"], `${where}.members`),
      boards: (truthy(p["boards"]) ? (p["boards"] as unknown[]) : []).map(pyStr),
    };
  });

  return { boards, skipped, generatedAt: pyStr(pyOr(raw["generated_at"], "")), people };
}

export function parseManifestText(text: string, path = "migration.json"): Manifest {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new ManifestError(`${path}: invalid JSON (${(error as Error).message})`);
  }
  return parseManifest(raw, path);
}

export function keepPairings(fresh: Manifest, previous: Pick<Manifest, "boards">): { manifest: Manifest; kept: number; unread: DiscoveredBoard[] } {
  const paired = previous.boards.filter((b) => b.plakyBoardId !== null);
  const known = new Map(paired.map((b) => [b.id, b.plakyBoardId]));
  if (!known.size) return { manifest: fresh, kept: 0, unread: [] };
  const read = new Set(fresh.boards.map((b) => b.id));
  const unread = paired.filter((b) => !read.has(b.id));
  const boards = fresh.boards.map((b) => (known.has(b.id) ? { ...b, plakyBoardId: known.get(b.id) ?? null } : b));
  return { manifest: { ...fresh, boards: [...boards, ...unread] }, kept: known.size, unread };
}
