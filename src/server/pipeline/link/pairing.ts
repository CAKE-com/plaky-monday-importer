import { SYNTHETIC_COLUMNS } from "../extract";
import { dropped, importable, isSubitemBoard, type DiscoveredBoard, type Manifest } from "../manifest";
import { isNameColumn } from "../name-fields";
import { MONDAY_ID_FIELD, PARENT_ID_FIELD, PARENT_TITLE_FIELD } from "../names";
import { PLAKY_TYPE_LABEL, compatibleTypes, importLabel } from "../transform/compat";
import { labelIndex, normalizeTitle, spellingKey, type PlakyField } from "../transform/mapping";
import { strOf } from "../transform/pyvalue";
import { asList, asMap } from "./config";
import type { BoardLink, JsonObject, LinkResult, SeededBoard } from "./types";

const typeLabel = (plakyType: string | null): string => PLAKY_TYPE_LABEL[plakyType ?? ""] ?? (plakyType || "?");
const aField = (label: string): string => `${/^[AEIOU]/.test(label) ? "an" : "a"} ${label} field`;

function fix(target: PlakyField, wanted: string | null): string {
  return `In Plaky: on the '${target.name}' header open the ⌄ menu -> Change field type -> ${typeLabel(wanted)} -> Convert.`;
}

export function checkField(
  title: string,
  mondayType: string,
  expected: string | null,
  target: PlakyField,
  labels: readonly string[],
  wanted = typeLabel(expected),
): [problem: string | null, warning: string | null] {
  if (expected && target.type !== expected) {
    if (!compatibleTypes(mondayType).includes(target.type)) {
      return [
        `${title} -> '${target.name}': expected ${expected}, got ${target.type}; monday ${mondayType} values cannot be stored there. ${fix(target, wanted)}`,
        null,
      ];
    }
    return [null, `${title} -> '${target.name}' is ${typeLabel(target.type)}, not ${wanted}: carried, but as ${typeLabel(target.type)}. ${fix(target, wanted)}`];
  }
  if ((target.type === "STATUS" || target.type === "TAG") && labels.length) {
    const index = labelIndex(target);
    const missing = labels.filter((label) => !target.labels.includes(label) && !index.has(spellingKey(label)));
    if (missing.length) {
      const how = target.type === "TAG" ? `on a seed row click the '${target.name}' cell, type the label and press Enter` : "field header ⌄ -> Field settings";
      return [
        `${title} -> '${target.name}' has no label(s) ${strOf(missing)}, and Plaky's API cannot create one. Add each in Plaky (${how}).`,
        null,
      ];
    }
  }
  return [null, null];
}

export function matchFields(board: DiscoveredBoard, seeded: SeededBoard, previous: JsonObject | null = null): BoardLink {
  const byName = new Map<string, PlakyField[]>();
  for (const target of seeded.fields) {
    const name = normalizeTitle(target.name);
    byName.set(name, [...(byName.get(name) ?? []), target]);
  }
  const byKey = new Map(seeded.fields.map((f) => [f.key, f]));
  const prev: JsonObject = previous ?? {};
  const sameBoard = prev.plaky_board_id === undefined || prev.plaky_board_id === seeded.plakyBoardId;
  const byKeyHere = (key: string): unknown => (sameBoard ? prev[key] : undefined);
  const remembered = new Map<string, unknown>(sameBoard ? Object.entries(asMap(prev.field_map)) : []);

  const keyFor = (name: string, rememberedKey?: unknown): string | null => {
    if (typeof rememberedKey === "string" && rememberedKey && byKey.has(rememberedKey)) return rememberedKey;
    const candidates = byName.get(normalizeTitle(name)) ?? [];
    return candidates.length === 1 ? candidates[0]!.key : null;
  };

  const skippedBefore = new Set<unknown>(Array.isArray(prev.skip_columns) ? prev.skip_columns : []);
  const importableColumns = importable(board);
  const keptOut = importableColumns.filter((c) => skippedBefore.has(c.id) && !Object.hasOwn(SYNTHETIC_COLUMNS, c.id)).map((c) => c.id);
  const fieldMap: Record<string, string> = {};
  const unmatched: string[] = [];
  const warnings: string[] = [];
  for (const column of importableColumns) {
    if (keptOut.includes(column.id)) continue;
    const key = keyFor(column.fieldName, remembered.get(column.id));
    if (key === null && isNameColumn(column.id)) continue;
    if (key === null) {
      unmatched.push(
        `${column.title} -> no Plaky field named '${column.fieldName}' and none recorded from a previous link. In Plaky, add ` +
          `${aField(importLabel(column.plakyType, column.importAs))} named '${column.fieldName}' to the board: the + at the right end of its header row.`,
      );
      continue;
    }
    fieldMap[column.id] = key;
    const renames = asMap(asMap(prev.label_map)[column.id]);
    const labels = column.labels.map((l) => (typeof renames[l] === "string" ? (renames[l] as string) : l));
    const [problem, warning] = checkField(column.title, column.type, column.plakyType, byKey.get(key)!, [...new Set(labels)], importLabel(column.plakyType, column.importAs));
    if (problem) unmatched.push(problem);
    if (warning) warnings.push(warning);
  }

  const mondayIdKey = keyFor(MONDAY_ID_FIELD, byKeyHere("monday_id_field"));
  const flat = isSubitemBoard(board) && !board.nested;
  const parentTitleKey = flat ? keyFor(PARENT_TITLE_FIELD, byKeyHere("parent_title_field")) : null;
  const parentIdKey = flat ? keyFor(PARENT_ID_FIELD, byKeyHere("parent_id_field")) : null;
  for (const [name, key] of [[MONDAY_ID_FIELD, mondayIdKey], [PARENT_TITLE_FIELD, parentTitleKey], [PARENT_ID_FIELD, parentIdKey]] as const) {
    const target = key === null ? undefined : byKey.get(key);
    if (target !== undefined && target.type !== "STRING") unmatched.push(`${name} -> expected STRING, got ${target.type}. ${fix(target, "STRING")}`);
  }
  if (flat) {
    if (parentTitleKey === null) unmatched.push(`${PARENT_TITLE_FIELD} -> no Plaky field named '${PARENT_TITLE_FIELD}' for the flat subitem parent link`);
    if (parentIdKey === null) unmatched.push(`${PARENT_ID_FIELD} -> no Plaky field named '${PARENT_ID_FIELD}' for the flat subitem parent link`);
  }

  const rememberedGroup = byKeyHere("seed_group_id");
  const importableIds = new Set(importableColumns.map((c) => c.id));
  return {
    mondayBoardId: board.id,
    name: board.name,
    plakyBoardId: seeded.plakyBoardId,
    fieldMap,
    unmatched,
    warnings,
    skipColumns: [
      ...dropped(board).map((c) => c.id),
      ...Object.keys(SYNTHETIC_COLUMNS).filter((id) => !importableIds.has(id)),
      ...keptOut,
    ],
    seedItemIds: board.nested ? [] : [...seeded.seedItemIds],
    subitemsOf: board.parentBoardId,
    nested: board.nested,
    mondayIdKey,
    parentTitleKey,
    parentIdKey,
    seedGroupId: seeded.seedGroupId || (typeof rememberedGroup === "number" && Number.isInteger(rememberedGroup) ? rememberedGroup : null),
  };
}

export function pairBoards(manifest: Manifest, seeded: ReadonlyMap<string, SeededBoard>, previous: JsonObject | null = null): LinkResult {
  const byBoard = new Map(asList(previous?.boards).map((entry) => [strOf(entry.monday_board_id), entry]));
  const result: LinkResult = { links: [], missing: [] };
  for (const board of manifest.boards) {
    const match = seeded.get(board.id) ?? (board.nested && board.parentBoardId !== null ? seeded.get(board.parentBoardId) : undefined);
    if (match === undefined) result.missing.push([board.id, board.name]);
    else result.links.push(matchFields(board, match, byBoard.get(board.id) ?? null));
  }
  return result;
}
