import { isHeader } from "@/lib/people-entry";
import { TEAM_KEY, type BoardSync, type PeopleMap } from "./config";
import { SYNTHETIC_COLUMNS, type BoardExtract, type ColumnValue, type ExtractedColumn } from "./extract";
import { columnPlan, type ColumnPlan, type DiscoveredBoard, type Manifest } from "./manifest";
import { RESERVED_FIELD_NAMES } from "./names";
import { normalizeTitle, personRefs, type PlakyField } from "./transform/mapping";

export const nameColumnId = (columnId: string): string => `__name_${columnId}`;

const assigns = (column: Pick<ExtractedColumn, "id" | "type">): boolean => (column.type === "people" || column.type === "person" || column.type === "team") && !Object.hasOwn(SYNTHETIC_COLUMNS, column.id);

const keyOf = ([kind, id]: readonly [string, string]): string | null => (kind === "person" ? id : kind === "team" ? `${TEAM_KEY}${id}` : null);

const NAME_REASON = "the names of people or teams Plaky cannot assign, kept as text: their Person cell stays empty";

function withNames(board: DiscoveredBoard): DiscoveredBoard {
  const strip = (columns: readonly ColumnPlan[]): ColumnPlan[] => columns.filter((c) => !columns.some((p) => p.plakyType === "PERSON" && nameColumnId(p.id) === c.id));
  const own = strip(board.columns);
  const nested = strip(board.nestedColumns);
  const taken = new Set([...RESERVED_FIELD_NAMES, ...own.map((c) => c.fieldName), ...nested.map((c) => c.fieldName)].map(normalizeTitle));
  const unique = (name: string): string => {
    let candidate = name;
    for (let n = 2; taken.has(normalizeTitle(candidate)); n++) candidate = `${name} (${n})`;
    taken.add(normalizeTitle(candidate));
    return candidate;
  };
  const add = (columns: readonly ColumnPlan[]): ColumnPlan[] =>
    columns.flatMap((c) =>
      c.plakyType === "PERSON" && !Object.hasOwn(SYNTHETIC_COLUMNS, c.id)
        ? [c, columnPlan({ id: nameColumnId(c.id), title: `${c.title} (name)`, type: "text", fieldName: unique(`${c.fieldName} (name)`), plakyType: "STRING", reason: NAME_REASON })]
        : [c],
    );
  return { ...board, columns: add(own), nestedColumns: add(nested) };
}

function nestedNames(sub: DiscoveredBoard, parent: DiscoveredBoard | undefined): DiscoveredBoard {
  const lists = [parent?.columns ?? [], parent?.nestedColumns ?? []];
  const own = sub.columns.filter((c) => !sub.columns.some((p) => p.plakyType === "PERSON" && nameColumnId(p.id) === c.id));
  const columns = own.flatMap((c) => {
    if (c.plakyType !== "PERSON") return [c];
    const names = lists.flatMap((list) => {
      const field = list.find((p) => p.plakyType === "PERSON" && p.fieldName === c.fieldName);
      return field ? list.filter((p) => p.id === nameColumnId(field.id)) : [];
    })[0];
    return names ? [c, { ...names, id: nameColumnId(c.id), title: `${c.title} (name)` }] : [c];
  });
  return { ...sub, columns };
}

export function withNameFields(manifest: Manifest): Manifest {
  const boards = manifest.boards.map((b) => (b.nested ? b : withNames(b)));
  return { ...manifest, boards: boards.map((b) => (b.nested ? nestedNames(b, boards.find((p) => p.id === b.parentBoardId)) : b)) };
}

export const isNameColumn = (columnId: string): boolean => columnId.startsWith(nameColumnId(""));

export function nameFieldNamed(title: string, fieldMap: Readonly<Record<string, string>>, fields: readonly PlakyField[]): PlakyField | null {
  const used = new Set(Object.values(fieldMap));
  const named = fields.filter((f) => f.type === "STRING" && !used.has(f.key) && normalizeTitle(f.name) === normalizeTitle(title));
  return named.length === 1 ? named[0]! : null;
}

export function withNameKeys(extract: BoardExtract, sync: Pick<BoardSync, "fieldMap" | "skipColumns">, fields: readonly PlakyField[]): Readonly<Record<string, string>> {
  const found = extract.board.columns.flatMap((c) => {
    const id = nameColumnId(c.id);
    if (!assigns(c) || !Object.hasOwn(sync.fieldMap, c.id) || Object.hasOwn(sync.fieldMap, id) || sync.skipColumns.includes(id)) return [];
    const named = nameFieldNamed(`${c.title} (name)`, sync.fieldMap, fields);
    return named ? [[id, named.key] as const] : [];
  });
  const once = found.filter(([, key]) => found.filter(([, other]) => other === key).length === 1);
  return once.length ? { ...sync.fieldMap, ...Object.fromEntries(once) } : sync.fieldMap;
}

export function withNameValues(extract: BoardExtract, fieldMap: Readonly<Record<string, string>>, people: PeopleMap): BoardExtract {
  const named = extract.board.columns.filter((c) => assigns(c) && Object.hasOwn(fieldMap, nameColumnId(c.id)));
  if (!named.length) return extract;
  const kept = (id: string): boolean => Object.hasOwn(people, id) && isHeader(people[id]);
  const nameOf = (key: string): string => {
    if (!key.startsWith(TEAM_KEY)) return (Object.hasOwn(extract.users, key) ? extract.users[key]?.name?.trim() : "") || `monday user ${key}`;
    const id = key.slice(TEAM_KEY.length);
    return (Object.hasOwn(extract.teams, id) ? extract.teams[id]?.name?.trim() : "") || `monday team ${id}`;
  };
  const columns: ExtractedColumn[] = extract.board.columns.flatMap((c) =>
    named.includes(c) ? [c, { id: nameColumnId(c.id), title: `${c.title} (name)`, type: "text", settingsStr: "{}", settings: null }] : [c],
  );
  const items = extract.items.map((item) => {
    const values: Record<string, ColumnValue> = { ...item.columnValues };
    for (const c of named) {
      const cell = item.columnValues[c.id];
      if (cell === undefined) continue;
      const keys = [...new Set(personRefs(cell).map(keyOf).filter((key): key is string => key !== null && kept(key)))];
      values[nameColumnId(c.id)] = { id: nameColumnId(c.id), type: "text", text: keys.map(nameOf).join(", "), value: null };
    }
    return { ...item, columnValues: values };
  });
  return { ...extract, board: { ...extract.board, columns }, items };
}

export function namesWithoutField(extract: BoardExtract, fieldMap: Readonly<Record<string, string>>, people: PeopleMap, skipColumns: readonly string[] = []): string[] {
  const kept = (id: string): boolean => Object.hasOwn(people, id) && isHeader(people[id]);
  return extract.board.columns.flatMap((c) => {
    if (!assigns(c) || !Object.hasOwn(fieldMap, c.id) || Object.hasOwn(fieldMap, nameColumnId(c.id)) || skipColumns.includes(nameColumnId(c.id))) return [];
    const held = extract.items.filter((item) => item.columnValues[c.id] && personRefs(item.columnValues[c.id]!).some((ref) => { const key = keyOf(ref); return key !== null && kept(key); })).length;
    return held ? [`${c.title}: ${held} item(s) name someone whose name is kept as text, and the board has no field '${c.title} (name)' for it: add a Text field of that name in Plaky (the + at the right end of the header row), then move again`] : [];
  });
}
