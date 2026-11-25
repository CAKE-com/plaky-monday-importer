import type { ExtractedColumn } from "../extract";
import { isDict, parseJsonOrdered, pyOr, pyStr, pyStrip, type OrderedJson } from "./pystr";

export const COMPAT: Readonly<Record<string, readonly string[]>> = {
  name: [],
  text: ["STRING", "RICH_TEXT"],
  long_text: ["RICH_TEXT", "STRING"],
  numbers: ["NUMBER", "STRING"],
  status: ["STATUS", "TAG", "STRING"],
  dropdown: ["TAG", "STRING"],
  tags: ["TAG", "STRING"],
  checkbox: ["STATUS", "STRING", "RICH_TEXT", "TAG"],
  color_picker: ["STRING", "RICH_TEXT"],
  people: ["PERSON"],
  date: ["DATE_TIME", "STRING"],
  timeline: ["TIMELINE", "DATE_TIME", "STRING"],
  week: ["TIMELINE", "STRING"],
  link: ["LINK", "STRING"],
  email: ["STRING", "RICH_TEXT"],
  phone: ["STRING", "RICH_TEXT"],
  location: ["STRING", "RICH_TEXT"],
  country: ["STRING", "RICH_TEXT"],
  hour: ["STRING", "RICH_TEXT"],
  world_clock: ["STRING", "RICH_TEXT"],
  rating: ["NUMBER", "STRING"],
  vote: ["NUMBER", "STRING"],
  doc: ["STRING", "LINK"],
  dependency: ["STRING", "RICH_TEXT"],
  board_relation: ["STRING", "RICH_TEXT"],
  creation_log: ["DATE_TIME", "STRING"],
  last_updated: ["DATE_TIME", "STRING"],
  formula: ["STRING", "RICH_TEXT", "NUMBER"],
  mirror: ["STRING", "RICH_TEXT"],
  item_id: ["STRING", "RICH_TEXT", "NUMBER"],
  person: ["PERSON"],
  team: ["PERSON", "STRING", "RICH_TEXT"],
  auto_number: [],
  progress: [],
  time_tracking: [],
  file: [],
  subtasks: [],
  button: [],
  integration: [],
  direct_doc: [],
  group: [],
  item_assignees: ["STRING", "RICH_TEXT"],
  unsupported: [],
};

const LOSSY_REASON: Readonly<Record<string, string>> = {
  mirror: "carried as text, the linked items' values as they are when the move runs, not kept in step (Plaky has no mirror field, and its API cannot create one)",
  board_relation: "carried as text, the linked items' names, with no link to the other board's items (Plaky has no connected-boards field, and its API cannot create one)",
  dependency: "carried as text, the names of the items it depends on, with no live dependency (Plaky has no dependency field, and its API cannot create one)",
  formula: "carried as its value when the move runs, with no formula (Plaky has no formula field, and its API cannot create one)",
  doc: "a link to the monday doc; with Files on, its content also arrives as \"<doc name>.md\" on the item (formatting as markdown)",
  location: "the address as text; no map position",
  country: "the country's name; no country code",
  vote: "the number of votes; not who voted",
  creation_log: "when the item was made in monday, as a date; who made it only when \"Who created each item, and when\" is ticked in Boards",
  phone: "the number as monday shows it; no country code",
};

export const lossyColumns = (columns: readonly { title: string; type: string; plakyType: string | null }[]): string[] =>
  columns.flatMap((c) => (c.plakyType !== null && LOSSY_REASON[c.type] ? [`${c.title}: ${LOSSY_REASON[c.type]}`] : []));

export const UNMAPPABLE_REASON: Readonly<Record<string, string>> = {
  auto_number: "monday computes it at render time and does not expose it via the API",
  progress: "monday computes it in its UI; the API returns no value for it",
  time_tracking: "a running timer's duration changes every second, so the item could never settle; excluded deliberately",
  file: "Plaky has no file field: with sync_files on, the files arrive as item files",
  subtasks: "subitems import onto their own Plaky board instead",
  button: "a button carries no value",
  integration: "managed by the integration; the value cannot be read or set",
  direct_doc: "a monday doc, which Plaky cannot hold; an item description travels as the Description field",
  group: "the item's group; the item lands in the matching Plaky group",
  unsupported: "monday's API cannot read this column type",
  name: "becomes the Plaky item title",
};

export const PLAKY_TYPE_LABEL: Readonly<Record<string, string>> = {
  STRING: "Text",
  RICH_TEXT: "Rich Text",
  NUMBER: "Numbers",
  STATUS: "Status",
  TAG: "Tag",
  PERSON: "Person",
  DATE_TIME: "Date",
  TIMELINE: "Timeline",
  LINK: "Link",
};

export const UNKNOWN_FALLBACK: readonly string[] = ["STRING", "RICH_TEXT"];

export function compatibleTypes(mondayType: string): readonly string[] {
  return Object.hasOwn(COMPAT, mondayType) ? (COMPAT[mondayType] ?? UNKNOWN_FALLBACK) : UNKNOWN_FALLBACK;
}

export function preferredType(mondayType: string): string | null {
  return compatibleTypes(mondayType)[0] ?? null;
}

const asMap = (v: OrderedJson | undefined): Map<string, OrderedJson> | null => (v instanceof Map ? v : null);

export const importLabel = (plakyType: string | null, importAs?: string | null): string =>
  importAs ?? (Object.hasOwn(PLAKY_TYPE_LABEL, plakyType ?? "") ? (PLAKY_TYPE_LABEL[plakyType ?? ""] ?? "") : (plakyType ?? ""));

export function singleSelect(column: Pick<ExtractedColumn, "settings" | "settingsStr">): boolean {
  let settings: unknown = column.settings;
  if (!isDict(settings) || settings["limit_select"] === undefined) {
    try {
      settings = JSON.parse(column.settingsStr || "{}");
    } catch {
      return false;
    }
  }
  return isDict(settings) && settings["limit_select"] === true && Number(settings["label_limit_count"]) === 1;
}

const CREATED_BY = "__created_by";

export const fieldTypesFor = (column: Pick<ExtractedColumn, "id" | "type" | "settings" | "settingsStr">): readonly string[] =>
  column.type === "dropdown" && singleSelect(column) ? [...compatibleTypes(column.type), "STATUS"]
    : column.id === CREATED_BY ? ["STRING", ...compatibleTypes(column.type)]
    : compatibleTypes(column.type);

export function labelTitles(column: Pick<ExtractedColumn, "settings" | "settingsStr">): Map<string, string> {
  const typed = isDict(column.settings) ? column.settings : null;
  if (typed !== null && Array.isArray(typed["labels"])) {
    const out = new Map<string, string>();
    for (const entry of typed["labels"] as unknown[]) {
      if (!isDict(entry) || entry["id"] === null || entry["id"] === undefined) continue;
      const title = pyOr(entry["label"], entry["name"]);
      if (typeof title === "string" && pyStrip(title)) out.set(pyStr(entry["id"]), title);
    }
    if (out.size) return out;
  }
  const text = column.settingsStr || "{}";
  try {
    JSON.parse(text);
  } catch {
    return new Map();
  }
  const settings = asMap(parseJsonOrdered(text));
  const labels = settings?.get("labels");
  const out = new Map<string, string>();
  if (labels instanceof Map) {
    for (const [id, title] of labels) if (typeof title === "string" && pyStrip(title)) out.set(id, title);
  } else if (Array.isArray(labels)) {
    for (const entry of labels) {
      const fields = asMap(entry);
      const name = fields?.get("name");
      if (fields && typeof name === "string" && pyStrip(name)) out.set(pyStr(fields.get("id")), name);
    }
  }
  return out;
}

export const CHECKBOX_LABELS: readonly string[] = ["Yes", "No"];

export const mondayLabels = (column: Pick<ExtractedColumn, "settings" | "settingsStr">): string[] => [...labelTitles(column).values()];

export function deactivatedLabelIds(column: Pick<ExtractedColumn, "settings" | "settingsStr">): Set<string> {
  const out = new Set<string>();
  const typed = isDict(column.settings) ? column.settings : null;
  const entries: unknown[] = typed !== null && Array.isArray(typed["labels"]) ? (typed["labels"] as unknown[]) : [];
  if (!entries.length) {
    try {
      const parsed: unknown = JSON.parse(column.settingsStr || "{}");
      if (isDict(parsed) && Array.isArray(parsed["labels"])) entries.push(...(parsed["labels"] as unknown[]));
    } catch {
      return out;
    }
  }
  for (const entry of entries) {
    if (isDict(entry) && entry["is_deactivated"] === true && entry["id"] !== null && entry["id"] !== undefined) out.add(pyStr(entry["id"]));
  }
  return out;
}

export function seedLabels(column: Pick<ExtractedColumn, "settings" | "settingsStr">, used: ReadonlySet<string> = new Set()): string[] {
  const deactivated = deactivatedLabelIds(column);
  if (!deactivated.size) return mondayLabels(column);
  return [...labelTitles(column)].flatMap(([id, title]) => (!deactivated.has(id) || used.has(id) ? [title] : []));
}
