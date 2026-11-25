import Decimal from "decimal.js";
import { peopleIn } from "../../clients/monday";
import { SYNTHETIC_COLUMNS, type ColumnValue, type ExtractedColumn, type ExtractedItem } from "../extract";
import { COMPAT, fieldTypesFor, labelTitles } from "./compat";
import { filesInValue, type MondayFile } from "./files";
import { attachZone, fromIsoFormat, toZone, utcStamp } from "./isotime";
import { asciiDigits, casefold, isAlnum, isDecimalStr, isDict, pyDecimal, pyOr, pySplit, pyStr, pyStrip, truthy, type PyDecimal } from "./pystr";
import { pyRepr } from "./pyvalue";
import { toHtml } from "./richtext";

export const SUPPORTED_PLAKY_TYPES: ReadonlySet<string> = new Set(["STRING", "RICH_TEXT", "NUMBER", "DATE_TIME", "TIMELINE", "STATUS", "TAG", "LINK", "PERSON"]);

export const NAME_COLUMN_TYPES: ReadonlySet<string> = new Set(["name"]);

export const UNSUPPORTED_MONDAY_TYPES: ReadonlySet<string> = new Set(
  Object.entries(COMPAT)
    .filter(([type, types]) => types.length === 0 && !NAME_COLUMN_TYPES.has(type))
    .map(([type]) => type),
);

export type PersonValue = { users?: { id: number }[]; teams?: { id: number }[] };
type PlakyValue = string | number | string[] | { start: string; end: string } | { url: string; displayText: string } | PersonValue;

export const EMPTY_FOR_TYPE: Readonly<Record<string, PlakyValue>> = {
  STRING: "",
  RICH_TEXT: "",
  NUMBER: "",
  LINK: "",
  STATUS: "",
  TAG: [],
  PERSON: { users: [], teams: [] },
};

export const PERSON_LIMITS: Readonly<Record<string, number>> = { ONE: 1, TWO: 2, THREE: 3 };

const own = <T>(record: Readonly<Record<string, T>> | undefined, key: string): T | undefined =>
  record !== undefined && Object.hasOwn(record, key) ? record[key] : undefined;

export function normalizeTitle(value: string | null | undefined): string {
  return [...casefold((value ?? "").normalize("NFKC"))].filter(isAlnum).join("");
}

export function spellingKey(value: string | null | undefined): string {
  return pySplit(casefold((value ?? "").normalize("NFKC"))).join(" ");
}

export type PlakyField = {
  key: string;
  name: string;
  type: string;
  labels: readonly string[];
  labelsByKey: readonly (readonly [key: string, title: string])[];
  personLimit: number | null;
};

export function plakyField(init: {
  key: string;
  name: string;
  type: string;
  labels?: readonly string[] | undefined;
  labelsByKey?: readonly (readonly [string, string])[] | undefined;
  personLimit?: number | null | undefined;
}): PlakyField {
  return { key: init.key, name: init.name, type: init.type, labels: init.labels ?? [], labelsByKey: init.labelsByKey ?? [], personLimit: init.personLimit ?? null };
}

export const titleByKey = (field: PlakyField): Map<string, string> => new Map(field.labelsByKey.filter(([, title]) => title));

export const exactLabelIndex = (field: PlakyField): Map<string, string> => new Map(field.labels.filter(Boolean).map((label) => [label, label]));

export function labelIndex(field: PlakyField): Map<string, string> {
  const candidates = new Map<string, string[]>();
  for (const label of field.labels) {
    if (!label) continue;
    const key = spellingKey(label);
    candidates.set(key, [...(candidates.get(key) ?? []), label]);
  }
  return new Map([...candidates].filter(([key, values]) => values.length === 1 && key).map(([key, values]) => [key, values[0] ?? ""]));
}

export function writeValue(field: PlakyField, title: string): string | null {
  if (field.labelsByKey.length === 0) return title;
  const keys = field.labelsByKey.filter(([, label]) => label === title).map(([key]) => key);
  if (keys.length !== 1) return null;
  const matches = (value: string): number => field.labelsByKey.filter(([key, label]) => value === key || value === label).length;
  if (matches(title) === 1) return title;
  const key = keys[0] ?? "";
  return matches(key) === 1 ? key : null;
}

export function clearValue(target: PlakyField): PlakyValue | null {
  if (target.type === "STATUS" && !target.labels.includes("")) return null;
  const empty = own(EMPTY_FOR_TYPE, target.type);
  return empty === undefined ? null : structuredClone(empty);
}

type RawLabel = { key?: unknown; title?: string | null | undefined };
type RawField = {
  key: string;
  name?: string | null | undefined;
  type: string;
  configuration?: { values?: readonly RawLabel[] | null | undefined; limit?: unknown } | null | undefined;
};

export function plakyFieldsFromBoard(board: { fields?: readonly RawField[] | null | undefined }): PlakyField[] {
  return (board.fields ?? []).map((raw) => {
    const configuration = raw.configuration ?? {};
    const values = configuration.values ?? [];
    return plakyField({
      key: raw.key,
      name: raw.name || raw.key,
      type: raw.type,
      labels: values.map((v) => v.title || ""),
      labelsByKey: values.map((v) => [pyStr(v.key), v.title || ""] as const),
      personLimit: own(PERSON_LIMITS, pyStr(pyOr(configuration.limit, ""))) ?? null,
    });
  });
}

export function asId(value: unknown): number | null {
  if (isDict(value)) return asId(value["id"]);
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && isDecimalStr(pyStrip(value))) return Number(asciiDigits(pyStrip(value)));
  return null;
}

export type FieldPair = { column: ExtractedColumn; target: PlakyField };
export type FieldMap = {
  pairs: FieldPair[];
  skipped: string[];
  unusedTargets: PlakyField[];
  uncarried: [column: ExtractedColumn, why: string][];
};

export const goneField = (mappedTo: string): string =>
  `mapped to Plaky field '${mappedTo}', which is gone: deleted, or its type changed in Plaky, which gives a field a new key`;

type FieldMapOptions = {
  overrides?: Readonly<Record<string, string>> | undefined;
  skipColumns?: ReadonlySet<string> | undefined;
  reservedFieldKeys?: ReadonlySet<string> | undefined;
};

export function buildFieldMap(columns: readonly ExtractedColumn[], targets: readonly PlakyField[], options: FieldMapOptions = {}): FieldMap {
  const overrides = options.overrides ?? {};
  const skipColumns = options.skipColumns ?? new Set<string>();
  const byKey = new Map(targets.map((t) => [t.key, t]));
  const byTitle = new Map<string, PlakyField[]>();
  const exactTitle = new Map<string, PlakyField[]>();
  for (const candidate of targets) {
    const normalized = normalizeTitle(candidate.name);
    byTitle.set(normalized, [...(byTitle.get(normalized) ?? []), candidate]);
    exactTitle.set(candidate.name, [...(exactTitle.get(candidate.name) ?? []), candidate]);
  }
  const taken = new Set(options.reservedFieldKeys ?? []);
  const result: FieldMap = { pairs: [], skipped: [], unusedTargets: [], uncarried: [] };

  const columnIds = new Set(columns.map((c) => c.id));
  const normalizedOverrides = new Map(Object.entries(overrides).filter(([k]) => !columnIds.has(k)).map(([k, v]) => [normalizeTitle(k), v]));

  const uncarried = (column: ExtractedColumn, why: string): void => {
    result.skipped.push(`${column.title} (${column.id}): ${why}`);
    if (!Object.hasOwn(SYNTHETIC_COLUMNS, column.id)) result.uncarried.push([column, why]);
  };

  for (const column of columns) {
    if (NAME_COLUMN_TYPES.has(column.type)) continue;
    if (column.type === "file") {
      result.skipped.push(`${column.title} (${column.id}): monday type 'file' has no Plaky equivalent`);
      continue;
    }
    if (skipColumns.has(column.id)) {
      if (!Object.hasOwn(SYNTHETIC_COLUMNS, column.id)) result.skipped.push(`${column.title} (${column.id}): skipped by config`);
      continue;
    }

    const override = own(overrides, column.id) || normalizedOverrides.get(normalizeTitle(column.title));
    let target: PlakyField | undefined;
    if (override) {
      target = byKey.get(override);
      if (target === undefined) {
        const exact = exactTitle.get(override) ?? [];
        const candidates = exact.length ? exact : (byTitle.get(normalizeTitle(override)) ?? []);
        if (candidates.length === 1) target = candidates[0];
        else if (candidates.length > 1) {
          uncarried(column, `mapped to '${override}', which is ambiguous on the Plaky board`);
          continue;
        }
      }
      if (target === undefined) {
        uncarried(column, goneField(override));
        continue;
      }
    } else {
      if (UNSUPPORTED_MONDAY_TYPES.has(column.type)) {
        result.skipped.push(`${column.title} (${column.id}): monday type '${column.type}' has no Plaky equivalent`);
        continue;
      }
      const candidates = byTitle.get(normalizeTitle(column.title)) ?? [];
      if (candidates.length > 1) {
        uncarried(column, `more than one Plaky field matches '${column.title}' after normalization`);
        continue;
      }
      target = candidates[0];
      if (target === undefined) {
        uncarried(column, `no Plaky field named '${column.title}'`);
        continue;
      }
    }

    if (taken.has(target.key)) {
      uncarried(column, `Plaky field '${target.name}' already mapped`);
      continue;
    }
    if (!SUPPORTED_PLAKY_TYPES.has(target.type)) {
      uncarried(column, `Plaky field type '${target.type}' is not writable`);
      continue;
    }

    if (!override && !fieldTypesFor(column).includes(target.type)) {
      uncarried(column, `Plaky field '${target.name}' (${target.type}) cannot carry monday type '${column.type}'`);
      continue;
    }

    taken.add(target.key);
    result.pairs.push({ column, target });
  }

  result.unusedTargets = targets.filter((t) => !taken.has(t.key));
  return result;
}

export function parsed(cv: ColumnValue): unknown {
  const raw = cv["value"];
  if (raw === null || raw === undefined || raw === "" || raw === "null") return null;
  if (typeof raw !== "string") return raw;
  try {
    const value: unknown = JSON.parse(raw);
    return Object.is(value, -0) && /^\s*-0\s*$/.test(raw) ? 0 : value;
  } catch {
    return raw;
  }
}

export function checkbox(cv: ColumnValue): "Yes" | "No" | null {
  if (cv["type"] !== "checkbox") return null;
  const value = parsed(cv);
  return isDict(value) && pyStr(value["checked"]).toLowerCase() === "true" ? "Yes" : "No";
}

const VALUE_METADATA = new Set(["changed_at", "changed_at_iso", "post_id", "is_valid", "countryShortName", "placeholder"]);

const isNothing = (v: unknown): boolean => v === null || v === undefined || v === "" || (Array.isArray(v) && v.length === 0) || (isDict(v) && Object.keys(v).length === 0);

export function isEmpty(cv: ColumnValue | null | undefined, column?: Pick<ExtractedColumn, "type" | "settings" | "settingsStr"> | null): boolean {
  if (cv === null || cv === undefined) return false;
  if (cv["type"] === "checkbox") return false;

  const text = pyOr(cv["display_value"], cv["text"]);
  if (typeof text === "string" && pyStrip(text)) return false;

  const value = parsed(cv);
  if (value === null) return true;
  if (typeof value === "string") return !pyStrip(value);
  if (Array.isArray(value)) return value.length === 0;
  if (isDict(value)) {
    if (column && isBlankSlot(value, column)) return true;
    const entries = value["personsAndTeams"];
    if (entries !== null && entries !== undefined) return !truthy(entries);
    return !Object.entries(value).some(([key, v]) => !VALUE_METADATA.has(key) && !isNothing(v));
  }
  return false;
}

function isBlankSlot(value: Record<string, unknown>, column: Pick<ExtractedColumn, "type" | "settings" | "settingsStr">): boolean {
  if (column.type !== "status") return false;
  const index = value["index"];
  if (index === null || index === undefined) return false;
  const known = labelTitles(column);
  return known.size > 0 && !known.has(pyStr(index));
}

export function linkedFiles(cv: ColumnValue): MondayFile[] {
  const linked = filesInValue(cv["value"]).filter((f) => f.assetId === null);
  const file = cv["file"];
  const doc = isDict(file) ? file["doc"] : undefined;
  const current = isDict(doc) ? doc["name"] : undefined;
  const first = linked[0];
  if (typeof current === "string" && pyStrip(current) && linked.length === 1 && first) return [{ ...first, name: pyStrip(current) }];
  return linked;
}

export function displayText(cv: ColumnValue): string | null {
  const box = checkbox(cv);
  if (box !== null) return box;
  const text = cv["display_value"] ?? cv["text"];
  if (typeof text === "string" && pyStrip(text)) return text;
  const docs = linkedFiles(cv);
  if (docs.length) return docs.map((doc) => (doc.url ? `${doc.name}: ${doc.url}` : doc.name)).join("\n");
  const value = parsed(cv);
  if (isDict(value)) {
    for (const key of ["text", "address", "url", "email", "phone"]) {
      const candidate = value[key];
      if (typeof candidate === "string" && pyStrip(candidate)) return candidate;
    }
  }
  if (typeof value === "string" && pyStrip(value)) return value;
  return null;
}

export const labels = (cv: ColumnValue, column?: ExtractedColumn | null): string[] => labelsAndNote(cv, column)[0];

function labelsAndNote(cv: ColumnValue, column?: ExtractedColumn | null): [labels: string[], note: string | null] {
  const box = checkbox(cv);
  if (box !== null) return [[box], null];

  const known = column ? labelTitles(column) : new Map<string, string>();
  const value = parsed(cv);
  if (isDict(value)) {
    const index = value["index"];
    if (known.size && index !== null && index !== undefined) {
      const hit = known.get(pyStr(index));
      if (hit) return [[hit], null];
    }
    const ids = Array.isArray(value["ids"]) ? value["ids"] : value["tag_ids"];
    if (Array.isArray(ids)) {
      const resolved = ids.map(pyStr).filter((id) => known.has(id)).map((id) => known.get(id) ?? "");
      const unresolved = ids.filter((id) => !known.has(pyStr(id)));
      const note = unresolved.length ? `label ids ${pyRepr(unresolved)} are not in the column's vocabulary (deleted in monday, or a tag the read did not resolve); not carried` : null;
      return [resolved, note];
    }
  }

  const text = cv["text"];
  if (typeof text !== "string" || !pyStrip(text)) return [[], null];
  if (cv["type"] === "dropdown" || cv["type"] === "tags") return [text.split(",").map(pyStrip).filter(Boolean), null];
  return [[pyStrip(text)], null];
}

const nd = (n: number): string => `\\p{Nd}{${n}}`;
const DAY = new RegExp(`^${nd(4)}-${nd(2)}-${nd(2)}$`, "u");
const MINUTE_STAMP = new RegExp(`^${nd(4)}-${nd(2)}-${nd(2)}T${nd(2)}:${nd(2)}$`, "u");
const BARE_LOCAL = new RegExp(`^${nd(4)}-${nd(2)}-${nd(2)}[ T]${nd(2)}:${nd(2)}(:${nd(2)})?$`, "u");

export function normalizeStamp(value: string): string | null {
  const raw = pyStrip(pyStrip(value).replaceAll(" UTC", ""));
  if (!raw) return null;
  if (DAY.test(raw)) {
    const day = fromIsoFormat(asciiDigits(raw));
    return day ? utcStamp(day) : null;
  }
  let candidate = raw.replaceAll(" ", "T");
  if (MINUTE_STAMP.test(candidate)) candidate += ":00";
  const stamp = fromIsoFormat(candidate.replaceAll("Z", "+00:00"));
  return stamp ? outOfRangeIsNull(() => utcStamp(stamp)) : null;
}

function outOfRangeIsNull(make: () => string | null): string | null {
  try {
    return make();
  } catch (error) {
    if (error instanceof RangeError) return null;
    throw error;
  }
}

const refusedYear = (stamp: string): boolean => Number(stamp.slice(0, 4)) <= 1;

export function usableZone(zone: string | null | undefined): boolean {
  const utc = fromIsoFormat("2026-01-01T00:00:00+00:00");
  return Boolean(zone && utc && toZone(utc, zone) !== null);
}

export function inZone(stamp: string | null, zone: string | null | undefined): string | null {
  if (!stamp || !zone) return stamp;
  const utc = fromIsoFormat(stamp.replaceAll("Z", "+00:00"));
  if (!utc) return stamp;
  return outOfRangeIsNull(() => toZone(utc, zone) ?? stamp);
}

export function localStamp(rendered: string, zone: string): string | null {
  const wall = fromIsoFormat(rendered.replaceAll(" ", "T"));
  return wall ? attachZone(wall, zone) : null;
}

export function isoDatetime(cv: ColumnValue, zone?: string | null): string | null {
  const value = parsed(cv);
  if (isDict(value)) {
    const date = value["date"];
    if (typeof date === "string" && pyStrip(date)) {
      const time = value["time"];
      if (!truthy(time)) return normalizeStamp(date);
      return inZone(normalizeStamp(`${date}T${pyStr(time)}`), zone);
    }
    for (const key of ["created_at", "updated_at"]) {
      const v = value[key];
      if (typeof v === "string" && pyStrip(v)) return inZone(normalizeStamp(v), zone);
    }
    const start = value["from"];
    if (typeof start === "string" && pyStrip(start)) return normalizeStamp(start);
  }
  const text = cv["text"];
  if (typeof text === "string" && pyStrip(text)) {
    const rendered = pyStrip(text);
    if (DAY.test(rendered)) return normalizeStamp(rendered);
    if (zone && BARE_LOCAL.test(rendered)) return localStamp(rendered, zone);
    return inZone(normalizeStamp(rendered), zone);
  }
  return null;
}

export function timeline(cv: ColumnValue): { start: string; end: string } | null {
  const value = parsed(cv);
  if (!isDict(value)) return null;
  const week = value["week"];
  const [start, end] = isDict(week) ? [week["startDate"], week["endDate"]] : [value["from"], value["to"]];
  if (!(typeof start === "string" && typeof end === "string" && start && end)) return null;
  const begin = normalizeStamp(start);
  const finish = normalizeStamp(end);
  return begin && finish ? { start: begin, end: finish } : null;
}

type NumberResult = [value: number | null, warning: string | null];

const lossy = (raw: string): NumberResult => [null, `'${raw}' cannot be represented as a JSON number without rounding`];

export function decimalNumber(value: PyDecimal, raw: string): NumberResult | null {
  if (value.kind === "snan" || value.kind === "inf") return null;
  if (value.kind === "nan") return lossy(raw);
  const asFloat = value.value.toNumber();
  if (!Number.isFinite(asFloat) || !new Decimal(String(asFloat)).eq(value.value)) return lossy(raw);
  return [asFloat || 0, null];
}

export function parseLooseNumber(raw: string): NumberResult {
  const trimmed = pyStrip(raw);
  const negative = trimmed.startsWith("(") && trimmed.endsWith(")");
  const chars = [...trimmed];
  const digit = (ch: string): boolean => /^\p{Nd}$/u.test(ch);
  const first = chars.findIndex(digit);
  const last = chars.length - 1 - [...chars].reverse().findIndex(digit);
  const core = first < 0 ? "" : chars.slice(first, last + 1).join("");
  const groups = core.split(/[\s\u00a0\u202f]+/u);
  const grouped = groups.slice(1).every((g, i) => (i === groups.length - 2 ? /^\p{Nd}{3}([.,]\p{Nd}+)?$/u.test(g) : /^\p{Nd}{3}$/u.test(g)));
  if (/\p{L}/u.test(core) || !grouped) return [null, `'${raw}' is not numeric`];
  let stripped = [...raw].filter((ch) => /^[\p{Nd},.-]$/u.test(ch)).join("");
  if (!stripped) return [null, `'${raw}' is not numeric`];

  const split = (s: string, sep: string): [head: string, tail: string] => {
    const at = s.lastIndexOf(sep);
    return [s.slice(0, at), s.slice(at + 1)];
  };
  if (stripped.includes(",") && stripped.includes(".")) {
    if (stripped.lastIndexOf(",") > stripped.lastIndexOf(".")) stripped = stripped.replaceAll(".", "").replaceAll(",", ".");
    else stripped = stripped.replaceAll(",", "");
  } else if (stripped.includes(",")) {
    const [head, tail] = split(stripped, ",");
    if ([...tail].length === 3 && /^-?0+$/u.test(head)) {
      return [null, `'${raw}' is ambiguous: ',' could be a decimal comma or a thousands separator. Fix the value in monday, or map this column to a text field`];
    }
    stripped = stripped.replaceAll(",", [...tail].length === 3 && head ? "" : ".");
  } else if (stripped.includes(".")) {
    const [head, tail] = split(stripped, ".");
    if ([...tail].length === 3 && isDecimalStr(head)) {
      return [
        null,
        `'${raw}' is ambiguous: '.' could be a decimal point or a thousands separator. Fix the value in monday, or map this column to a text field`,
      ];
    }
  }
  const decimal = pyDecimal(stripped);
  const result = decimal && decimalNumber(decimal, raw);
  if (!result) return [null, `'${raw}' is not numeric`];
  const [value, warning] = result;
  if (value === null) return [null, warning];
  return [negative && value !== 0 ? -value : value, null];
}

export function numberValue(cv: ColumnValue): NumberResult {
  const value = parsed(cv);
  if (isDict(value)) {
    for (const key of ["duration", "rating"]) {
      const v = value[key];
      if (typeof v === "number") return [v, null];
    }
  }
  if (typeof value === "number") {
    const raw = cv["value"];
    const exact = typeof raw === "string" && /^\s*-?\d+\s*$/.test(raw) ? pyDecimal(raw) : null;
    if (exact?.kind === "num" && !new Decimal(String(value)).eq(exact.value)) return lossy(pyStrip(raw as string));
    return [value, null];
  }
  if (typeof value === "string" && pyStrip(value)) {
    const decimal = pyDecimal(pyStrip(value));
    const result = decimal && decimalNumber(decimal, pyStrip(value));
    if (result) return result;
  }
  const raw = displayText(cv);
  if (!raw) return [null, null];
  return parseLooseNumber(raw);
}

export function urlValue(cv: ColumnValue): { url: string; displayText: string } | null {
  const value = parsed(cv);
  let url: string | null = null;
  let label: string | null = null;
  if (isDict(value)) {
    const candidate = value["url"];
    if (typeof candidate === "string" && pyStrip(candidate)) {
      url = pyStrip(candidate);
      const text = value["text"];
      if (typeof text === "string" && pyStrip(text)) label = pyStrip(text);
    }
  }
  if (url === null) {
    for (const linked of linkedFiles(cv)) if (linked.url) return { url: linked.url, displayText: linked.name };
    const text = cv["text"];
    if (typeof text === "string" && (pyStrip(text).startsWith("http://") || pyStrip(text).startsWith("https://"))) url = pyStrip(text);
  }
  return url === null ? null : { url, displayText: label || url };
}

export const personRefs = (cv: ColumnValue): [string, string][] => peopleIn(cv["value"]);

export function collectPeople(items: readonly ExtractedItem[], pairs: readonly FieldPair[]): [users: string[], teams: string[]] {
  const users = new Set<string>();
  const teams = new Set<string>();
  for (const pair of pairs) {
    if (pair.target.type !== "PERSON") continue;
    for (const item of items) {
      const cv = own(item.columnValues, pair.column.id);
      for (const [kind, ref] of cv ? personRefs(cv) : []) {
        if (kind === "person") users.add(ref);
        else if (kind === "team") teams.add(ref);
      }
    }
  }
  return [[...users], [...teams]];
}

export interface PersonResolver {
  value(entries: readonly (readonly [string, string])[], limit: number | null): [value: PersonValue | null, notes: string[]];
}

export function alias(label: string, aliases: Readonly<Record<string, string>>): string {
  const exact = own(aliases, label);
  if (exact !== undefined) return exact;
  const matches = Object.entries(aliases).filter(([key]) => spellingKey(key) === spellingKey(label)).map(([, value]) => value);
  return matches.length && new Set(matches).size === 1 ? (matches[0] ?? label) : label;
}

type Converted = { value: PlakyValue | null; warning: string | null };
const nothing = (warning: string | null = null): Converted => ({ value: null, warning });
const carry = (value: PlakyValue | null, warning: string | null = null): Converted => ({ value, warning });

const unwritable = (column: ExtractedColumn, target: PlakyField, titles: readonly string[]): string =>
  `${column.title}: ${pyRepr(titles)} each match more than one label on Plaky field '${target.name}', by title or key; rename them in Plaky`;

type ConvertOptions = {
  labelMap?: Readonly<Record<string, string>> | null | undefined;
  people?: PersonResolver | null | undefined;
  zone?: string | null | undefined;
  rich?: boolean | undefined;
};

export function convert(column: ExtractedColumn, cv: ColumnValue | null | undefined, target: PlakyField, options: ConvertOptions = {}): Converted {
  if (cv === null || cv === undefined) return nothing();
  const aliases = options.labelMap ?? {};
  const kind = target.type;

  if (kind === "STRING") return carry(displayText(cv));

  if (kind === "RICH_TEXT") {
    if (options.rich && typeof cv["html"] === "string" && cv["html"]) return carry(cv["html"]);
    const text = displayText(cv);
    return carry(text !== null ? toHtml(text) : null);
  }

  if (kind === "NUMBER") {
    const [number, problem] = numberValue(cv);
    return carry(number, problem ? `${column.title}: ${problem}` : null);
  }

  if (kind === "DATE_TIME") {
    const stamp = isoDatetime(cv, options.zone);
    const text = displayText(cv);
    if (stamp === null && text) return nothing(`${column.title}: '${text}' is not a date this converter recognises`);
    if (stamp !== null && refusedYear(stamp)) return nothing(`${column.title}: a date in year 0001 is refused by Plaky; not sent`);
    return carry(stamp);
  }

  if (kind === "TIMELINE") {
    const range = timeline(cv);
    if (range === null && displayText(cv)) return nothing(`${column.title}: no start/end pair to build a timeline`);
    if (range !== null && (refusedYear(range.start) || refusedYear(range.end))) return nothing(`${column.title}: a date in year 0001 is refused by Plaky; not sent`);
    if (range !== null && Date.parse(range.end) < Date.parse(range.start)) return nothing(`${column.title}: the timeline ends before it starts, which Plaky refuses; not sent`);
    return carry(range);
  }

  if (kind === "LINK") {
    const link = urlValue(cv);
    const text = displayText(cv);
    if (link === null && text) return nothing(`${column.title}: '${text}' is not a URL Plaky will accept`);
    return carry(link);
  }

  if (kind === "STATUS") {
    const [named, note] = labelsAndNote(cv, column);
    const found = named.map((label) => alias(label, aliases));
    const first = found[0];
    if (first === undefined) return nothing(note && `${column.title}: ${note}`);
    const extra = (found.length > 1 ? ` (${found.length - 1} further label(s) dropped: a Plaky STATUS holds one)` : "") + (note ? `${found.length > 1 ? ";" : ""} ${note}` : "");
    const match = exactLabelIndex(target).get(first) ?? labelIndex(target).get(spellingKey(first));
    if (match === undefined) {
      return nothing(`${column.title}: status '${first}' has no label on Plaky field '${target.name}' (labels cannot be created through the API)`);
    }
    const value = writeValue(target, match);
    if (value === null) return nothing(unwritable(column, target, [match]));
    return carry(value, extra ? `${column.title}:${extra}` : null);
  }

  if (kind === "TAG") {
    const [named, note] = labelsAndNote(cv, column);
    const found = named.map((label) => alias(label, aliases));
    if (!found.length) return nothing(note && `${column.title}: ${note}`);
    const exact = exactLabelIndex(target);
    const index = labelIndex(target);
    const written: string[] = [];
    const missing: string[] = [];
    const notWritable: string[] = [];
    for (const label of found) {
      const title = exact.get(label) ?? index.get(spellingKey(label));
      const value = title !== undefined ? writeValue(target, title) : null;
      if (value !== null) written.push(value);
      else if (title === undefined) missing.push(label);
      else notWritable.push(title);
    }
    const problems: string[] = [];
    if (note) problems.push(`${column.title}: ${note}`);
    if (missing.length) problems.push(`${column.title}: tags ${pyRepr(missing)} have no label on Plaky field '${target.name}'`);
    if (notWritable.length) problems.push(unwritable(column, target, notWritable));
    return carry(written.length ? written : null, problems.join("; ") || null);
  }

  if (kind === "PERSON") {
    const refs = personRefs(cv);
    if (!options.people) return nothing(refs.length ? `${column.title}: assignees not resolved` : null);
    const [assignees, notes] = options.people.value(refs, target.personLimit);
    return carry(assignees, notes.map((note) => `${column.title}: ${note}`).join("; ") || null);
  }

  return nothing(`${column.title}: Plaky type '${kind}' is not writable`);
}

export function buildItemFields(
  item: ExtractedItem,
  fieldMap: FieldMap,
  options: {
    labelMaps?: Readonly<Record<string, Readonly<Record<string, string>>>> | null | undefined;
    people?: PersonResolver | null | undefined;
    zone?: string | null | undefined;
    rich?: boolean | undefined;
  } = {},
): { payload: Record<string, PlakyValue>; warnings: string[]; uncleared: PlakyField[] } {
  const payload: Record<string, PlakyValue> = {};
  const warnings: string[] = [];
  const uncleared: PlakyField[] = [];
  const columnIds = new Set(fieldMap.pairs.map((p) => p.column.id));
  const labelMaps = options.labelMaps ?? {};
  const byTitle = new Map(Object.entries(labelMaps).filter(([k]) => !columnIds.has(k)).map(([k, v]) => [normalizeTitle(k), v]));
  for (const pair of fieldMap.pairs) {
    const direct = own(labelMaps, pair.column.id);
    const labelMap = direct && Object.keys(direct).length ? direct : byTitle.get(normalizeTitle(pair.column.title));
    const cv = own(item.columnValues, pair.column.id);
    const result = convert(pair.column, cv, pair.target, { labelMap, people: options.people, zone: options.zone, ...(options.rich ? { rich: true } : {}) });
    if (result.warning) warnings.push(result.warning);

    if (result.value !== null) {
      payload[pair.target.key] = result.value;
      continue;
    }

    if (result.warning !== null || !isEmpty(cv, pair.column)) continue;
    const empty = clearValue(pair.target);
    if (empty !== null) payload[pair.target.key] = empty;
    else uncleared.push(pair.target);
  }
  return { payload, warnings, uncleared };
}
