import type { PlakyClient } from "../clients/plaky";
import { isHeader, isSkipped } from "@/lib/people-entry";
import { TEAM_KEY, type BoardSync, type PeopleMap, type SyncConfig } from "./config";
import type { BoardExtract, ColumnValue, ExtractedUpdate } from "./extract";
import { isSeedMarker } from "./names";
import {
  SHARED_ID_FIX,
  changesGroup,
  expectedAssets,
  failureText,
  fileEntries,
  findField,
  holdsValue,
  loadDirectory,
  planBoard,
  nestedParentProblem,
  rankings,
  readPlakyRows,
  rising,
  spareCopies,
  rowsByKey,
  uncarriedLine,
  writeAction,
  type ParentTitles,
  type PlakyRow,
} from "./plan";
import { MAX_COMMENTS_PER_ITEM, commentHeader, headerOf, markerKey, markerOf, planItemComments, type PlannedComment } from "./transform/comments";
import { toLines } from "./transform/richtext";
import { DOC_ASSET_PREFIX, MAX_UPLOAD_BYTES, safeName } from "./transform/files";
import type { FileMapping } from "./load";
import { heldFile, matchFiles, type HeldFile, type WantedFile } from "./load/file-match";
import { goneField, personRefs, plakyFieldsFromBoard, type PlakyField } from "./transform/mapping";
import { nameColumnId, withNameKeys, withNameValues } from "./name-fields";
import { resolvePeople, type UserDirectory } from "./transform/people";
import { isDict, pySplit, pyStr, pyStrip, truthy } from "./transform/pystr";
import { cmpCodePoints } from "./transform/pyvalue";

export type FieldCoverage = { name: string; mondayFilled: number; plakyFilled: number };
const shortfall = (coverage: FieldCoverage): number => Math.max(0, coverage.mondayFilled - coverage.plakyFilled);

export type BoardReport = {
  name: string;
  mondayBoardId: string;
  plakyBoardId: number;
  mondayItems: number;
  plakyItems: number;
  matched: number;
  missing: string[];
  extra: string[];
  unidentified: string[];
  seedRows: number;
  coverage: FieldCoverage[];
  dropped: string[];
  notes: string[];
  assigned: [kind: string, id: string][];
  differing: string[];
  notCarried: string[];
  commentsOrFilesShort: boolean;
  shortWithinLimits: boolean;
  uncarried: string[];
};

export function boardReport(
  init: Pick<BoardReport, "name" | "mondayBoardId" | "plakyBoardId" | "mondayItems" | "plakyItems" | "matched"> & Partial<BoardReport>,
): BoardReport {
  return {
    missing: [],
    extra: [],
    unidentified: [],
    seedRows: 0,
    coverage: [],
    dropped: [],
    notes: [],
    assigned: [],
    differing: [],
    notCarried: [],
    commentsOrFilesShort: false,
    shortWithinLimits: false,
    uncarried: [],
    ...init,
  };
}

export function boardComplete(board: BoardReport): boolean {
  return (
    board.missing.length === 0 &&
    board.extra.length === 0 &&
    board.unidentified.length === 0 &&
    !board.seedRows &&
    board.differing.length === 0 &&
    board.notCarried.length === 0 &&
    !board.commentsOrFilesShort &&
    board.uncarried.length === 0 &&
    !board.coverage.some((cov) => shortfall(cov)) &&
    board.mondayItems === board.plakyItems
  );
}

export type Receipt = { boards: BoardReport[]; unmatchedUsers: string[]; failures: string[] };

export const receipt = (init: Partial<Receipt> = {}): Receipt => ({ boards: [], unmatchedUsers: [], failures: [], ...init });
export const receiptOk = (r: Receipt): boolean => r.boards.every(boardComplete) && r.failures.length === 0 && r.unmatchedUsers.length === 0;
export const receiptMondayItems = (r: Receipt): number => r.boards.reduce((sum, b) => sum + b.mondayItems, 0);
export const receiptMatched = (r: Receipt): number => r.boards.reduce((sum, b) => sum + b.matched, 0);

export type ManifestLike = { boards: readonly { id: string; dropped: readonly { title: string; type: string; reason: string }[] }[] };

const filled = (value: unknown): boolean => !(value === null || value === undefined || value === "" || (Array.isArray(value) && value.length === 0) || (isDict(value) && Object.keys(value).length === 0));

function plakyFilled(value: unknown, target: PlakyField): boolean {
  if (target.type === "STATUS" || target.type === "TAG") {
    const empty = new Set(target.labelsByKey.filter(([, title]) => !title).map(([key]) => key));
    return (Array.isArray(value) ? value : [value]).some((v) => filled(v) && !empty.has(String(v)));
  }
  return filled(value);
}

function leftOut(refs: readonly (readonly [string, string])[], people: PeopleMap): boolean {
  const keys = refs.map(([kind, ref]) => (kind === "team" ? `${TEAM_KEY}${ref}` : ref));
  return keys.length > 0 && keys.every((key) => Object.hasOwn(people, key) && (isSkipped(people[key] as Record<string, unknown>) || isHeader(people[key] as Record<string, unknown>)));
}

const NO_VALUE: ColumnValue = { id: "", type: "" };

type VerifyBoardOptions = {
  people?: PeopleMap | undefined;
  docs?: boolean | undefined;
  rich?: boolean | undefined;
  parentIds?: ReadonlySet<string> | undefined;
  rowsRead?: PlakyRow[] | undefined;
  filesMapped?: ((mondayItemId: string) => Promise<FileMapping[]>) | undefined;
  fileMeta?: FileMeta | undefined;
};

type FileMeta = (assetId: string) => Promise<[name: string, size: number | null]>;

type ListedComment = { id?: number | null | undefined; content?: unknown; deleted?: unknown; replies?: readonly ListedComment[] | null | undefined };

const normalized = (content: string): string => toLines(content).map((line) => pySplit(line).join(" ")).filter(Boolean).join("\n");
const listOf = (names: readonly string[]): string => (names.length > 10 ? `${names.slice(0, 10).join(", ")} and ${names.length - 10} more` : names.join(", "));

function discussionProblems(planned: readonly PlannedComment[], updates: readonly ExtractedUpdate[], listed: readonly ListedComment[]): { problems: string[]; withinLimits: boolean } {
  const live = (c: ListedComment): boolean => c.id !== null && c.id !== undefined && c.deleted !== true;
  const contentOf = (c: ListedComment): string => (typeof c.content === "string" ? c.content : "");
  const found = new Map<string, { parent: string | null; content: string }>();
  const take = (c: ListedComment, parent: string | null): void => {
    const marker = live(c) ? markerOf(contentOf(c)) : null;
    if (marker !== null && !found.has(markerKey(marker))) found.set(markerKey(marker), { parent, content: contentOf(c) });
  };
  const orphans: ListedComment[] = [];
  for (const top of listed) {
    take(top, null);
    const marker = live(top) ? markerOf(contentOf(top)) : null;
    for (const reply of top.replies ?? []) {
      if (marker === null) orphans.push(reply);
      else take(reply, markerKey(marker));
    }
  }
  for (const reply of orphans) take(reply, "");
  const forms = new Map<string, Set<string>>();
  for (const rich of [false, true]) {
    for (const files of [false, true]) for (const c of planItemComments(updates, files, rich)) forms.set(c.mondayId, (forms.get(c.mondayId) ?? new Set()).add(normalized(c.text)));
  }
  const missing: string[] = [];
  const misplaced: string[] = [];
  const loose: string[] = [];
  const edited: string[] = [];
  const differs: string[] = [];
  for (const c of planned) {
    if (c.kind === "links") continue;
    const name = `${c.kind} ${c.mondayId}`;
    const at = found.get(c.mondayId);
    if (at === undefined) missing.push(name);
    else if (at.parent !== (c.kind === "reply" ? c.replyTo : null)) (c.kind === "reply" ? loose : misplaced).push(name);
    else if (headerOf(at.content) !== commentHeader(c)) edited.push(name);
    else if (!forms.get(c.mondayId)?.has(normalized(at.content))) differs.push(name);
  }
  const problems = [
    ...(missing.length ? [`missing in Plaky: ${listOf(missing)}`] : []),
    ...(loose.length ? [`not under its update in Plaky: ${listOf(loose)}`] : []),
    ...(misplaced.length ? [`not at the top level in Plaky: ${listOf(misplaced)}`] : []),
    ...(edited.length ? [`edited in monday since it was carried: ${listOf(edited)}`] : []),
    ...(differs.length ? [`text differs from monday: ${listOf(differs)}`] : []),
    ...(loose.length || misplaced.length || differs.length ? ["a Move does not rewrite these: delete them in Plaky, then Move again"] : []),
  ];
  const expected = planned.filter((c) => c.kind !== "links").length;
  return { problems, withinLimits: edited.length > 0 || (missing.length > 0 && expected - missing.length < Math.min(expected, MAX_COMMENTS_PER_ITEM)) };
}

type ExpectedFile = readonly [name: string, size: number | null];

async function filesMissing(
  plaky: PlakyClient,
  config: BoardSync,
  plakyItemId: number,
  fileCount: number,
  expected: ReadonlyMap<string, ExpectedFile>,
  mapped: readonly FileMapping[],
  fileMeta: FileMeta | undefined,
): Promise<{ missing: string[] } | { unread: string }> {
  let held: HeldFile[] = [];
  const wanted: WantedFile[] = [];
  try {
    for (const [assetId, meta] of expected) wanted.push({ assetId, occurrence: 0, meta: fileMeta && assetId.startsWith(DOC_ASSET_PREFIX) ? await fileMeta(assetId) : meta });
    if (fileCount > 0) held = (await plaky.listItemFiles(config.plakySpaceId, config.plakyBoardId, plakyItemId)).map(heldFile);
  } catch (error) {
    return { unread: failureText(error) };
  }
  const { places } = matchFiles(plakyItemId, held, wanted, mapped);
  return { missing: wanted.filter((_, i) => places[i]!.state === "upload").map((w) => w.assetId) };
}

function requireMondayIdField(config: BoardSync): void {
  if (!config.mondayIdField) {
    throw new Error(`'${config.name}' has no monday-id field; verification cannot match Plaky rows to monday items`);
  }
}

export async function verifyBoard(
  read: BoardExtract,
  plaky: PlakyClient,
  config: BoardSync,
  manifest: ManifestLike | null = null,
  options: VerifyBoardOptions = {},
): Promise<BoardReport> {
  requireMondayIdField(config);
  const people = options.people ?? {};
  const fields = plakyFieldsFromBoard(await plaky.getBoard(config.plakySpaceId, config.plakyBoardId));
  const fieldMap = withNameKeys(read, config, fields);
  const extract = withNameValues(read, fieldMap, people);
  const idField = findField(fields, config.mondayIdField);
  if (idField === null) {
    throw new Error(`'${config.name}': no Plaky field '${config.mondayIdField}' on board ${config.plakyBoardId}; verification cannot match Plaky rows to monday items`);
  }

  const plakyRows: Record<string, unknown>[] = [];
  const identities: [unknown, string, string][] = [];
  let seedRows = 0;
  const commentCounts = new Map<string, number>();
  const fileCounts = new Map<string, number>();
  const listing = await readPlakyRows(plaky, config);
  for (const listed of listing) {
    if (truthy(listed["archived"]) || truthy(listed["deleted"])) continue;
    options.rowsRead?.push(listed);
    const row: Record<string, unknown> = {};
    for (const f of Array.isArray(listed["fields"]) ? listed["fields"] : []) if (isDict(f) && typeof f["key"] === "string") row[f["key"]] = f["value"];
    const value = row[idField.key];
    const key = typeof value === "string" ? pyStrip(value) : "";
    if (isSeedMarker(key)) {
      seedRows++;
      continue;
    }
    commentCounts.set(key, Math.trunc(Number(truthy(listed["commentCount"]) ? listed["commentCount"] : 0)));
    fileCounts.set(key, Math.trunc(Number(truthy(listed["fileCount"]) ? listed["fileCount"] : 0)));
    plakyRows.push(row);
    identities.push([listed["id"], String(truthy(listed["title"]) ? listed["title"] : ""), key]);
  }

  const byMondayId = new Map<string, Record<string, unknown>>();
  const carriers = new Map<string, [unknown, string][]>();
  identities.forEach(([itemId, title, key], index) => {
    if (!key) return;
    carriers.set(key, [...(carriers.get(key) ?? []), [itemId, title]]);
    if (!byMondayId.has(key)) byMondayId.set(key, plakyRows[index] ?? {});
  });
  const duplicates = new Map([...carriers].filter(([, found]) => found.length > 1));
  if (duplicates.size) {
    const spare = new Set(spareCopies(listing, idField.key).copies.map((c) => c.mondayItemId));
    if ([...duplicates.keys()].every((key) => spare.has(key))) {
      throw new Error(`board ${config.plakyBoardId} holds a second copy of ${duplicates.size} item(s), created twice when a create's answer was lost (${rowsByKey(duplicates)}). The copies hold nothing of their own: Move again deletes each one and keeps the first row.`);
    }
    throw new Error(`board ${config.plakyBoardId} has more than one row with the same Monday ID (${rowsByKey(duplicates)}). ${SHARED_ID_FIX}`);
  }

  const active = extract.items.filter((item) => item.state === "active");
  const unparented = config.nested ? active.flatMap((item) => { const problem = nestedParentProblem(item, options.parentIds); return problem === null ? [] : [[item, problem] as const]; }) : [];
  const left = new Set(unparented.map(([item]) => item.id));
  const mondayItems = active.filter((item) => !left.has(item.id));
  const missing = mondayItems.filter((i) => !byMondayId.has(i.id)).map((i) => `${i.name} (${i.id})`);

  const outside = new Set(extract.outOfScope);
  const mondayIds = new Set([...mondayItems.map((i) => i.id), ...outside]);
  const extra = [...identities]
    .sort((a, b) => cmpCodePoints(a[2], b[2]))
    .filter(([, , key]) => key && !mondayIds.has(key))
    .map(([itemId, title, key]) => `'${title}' (#${pyStr(itemId)}, Monday ID ${key})`);
  const unidentified = identities.filter(([, , key]) => !key).map(([itemId, title]) => `'${title}' (#${pyStr(itemId)})`);

  const coverage: FieldCoverage[] = [];
  const gone: string[] = [];
  const taken = new Set<string>();
  for (const [columnId, fieldKey] of Object.entries(fieldMap)) {
    const target = findField(fields, fieldKey);
    if (target === null) {
      gone.push(columnId);
      continue;
    }
    taken.add(target.key);
    let mondayFilled = 0;
    let plakyFilledCount = 0;
    const named = target.type === "PERSON" && Object.hasOwn(fieldMap, nameColumnId(columnId)) ? findField(fields, fieldMap[nameColumnId(columnId)]) : null;
    for (const item of mondayItems) {
      const stored = byMondayId.get(item.id);
      if (stored === undefined) continue;
      const cv = item.columnValues[columnId] ?? NO_VALUE;
      if (target.type === "PERSON" && leftOut(personRefs(cv), people)) continue;
      if (holdsValue(cv)) {
        mondayFilled++;
        if (plakyFilled(stored[target.key], target) || (named !== null && plakyFilled(stored[named.key], named))) plakyFilledCount++;
      }
    }
    if (mondayFilled) coverage.push({ name: target.name, mondayFilled, plakyFilled: plakyFilledCount });
  }

  const uncarried: string[] = [];
  if (gone.length) {
    const columns = new Map(extract.board.columns.map((c) => [c.id, c]));
    for (const columnId of gone) {
      const held = mondayItems.filter((item) => holdsValue(item.columnValues[columnId])).length;
      const column = columns.get(columnId);
      if (held && column) uncarried.push(uncarriedLine(column, goneField(fieldMap[columnId] ?? ""), held, fields, taken));
    }
  }

  const assigned = new Map<string, [string, string]>();
  for (const [columnId, fieldKey] of Object.entries(fieldMap)) {
    const target = findField(fields, fieldKey);
    if (target === null || target.type !== "PERSON") continue;
    for (const item of mondayItems) for (const ref of personRefs(item.columnValues[columnId] ?? NO_VALUE)) assigned.set(JSON.stringify(ref), ref);
  }

  const notes: string[] = [];
  let commentsOrFilesShort = false;
  let shortWithinLimits = false;
  const plakyIdOf = new Map(identities.map(([itemId, , key]) => [key, itemId]));
  const names = new Map(extract.items.map((item) => [item.id, item.name]));
  if (config.syncComments) {
    const byItem = new Map<string, ExtractedUpdate[]>();
    for (const update of extract.updates) if (byMondayId.has(update.itemId)) byItem.set(update.itemId, [...(byItem.get(update.itemId) ?? []), update]);
    let updates = 0;
    let replies = 0;
    let items = 0;
    const lines: string[] = [];
    for (const [mid, held] of byItem) {
      const planned = planItemComments(held, config.syncFiles, options.rich === true);
      if (!planned.length) continue;
      items++;
      updates += planned.filter((c) => c.kind === "update").length;
      replies += planned.filter((c) => c.kind === "reply").length;
      const label = `comments: '${names.get(mid) ?? ""}' (${mid})`;
      let listed: readonly ListedComment[] = [];
      if ((commentCounts.get(mid) ?? 0) > 0) {
        try {
          listed = await plaky.listItemComments(config.plakySpaceId, config.plakyBoardId, plakyIdOf.get(mid) as number);
        } catch (error) {
          lines.push(`${label}: not verified: its comments could not be read (${failureText(error)})`);
          shortWithinLimits = true;
          continue;
        }
      }
      const found = discussionProblems(planned, held, listed);
      if (!found.problems.length) continue;
      lines.push(`${label}: ${found.problems.join("; ")}`);
      if (found.withinLimits) shortWithinLimits = true;
    }
    commentsOrFilesShort = lines.length > 0;
    notes.push(`comments: ${updates} monday update(s)${replies ? ` and ${replies} repl(ies)` : ""} on ${items} item(s)` + (lines.length ? `; ${lines.length} item(s) do not hold them all in Plaky` : ", all carried"), ...lines);
  }

  if (config.syncFiles) {
    const entriesOf = fileEntries(extract, config, { docs: options.docs, rich: options.rich });
    const expectedFile = (id: string, name: string): ExpectedFile => [safeName(extract.assets[id]?.name || name), extract.assets[id]?.size ?? null];
    const assets = new Map<string, Map<string, ExpectedFile>>();
    for (const item of mondayItems) {
      if (!byMondayId.has(item.id)) continue;
      const expected = new Map([...expectedAssets(entriesOf(item), config)].map(([id, entry]) => [id, expectedFile(id, entry.name)]));
      if (expected.size) assets.set(item.id, expected);
    }
    const listed = new Set(mondayItems.map((item) => item.id));
    for (const update of extract.updates) {
      if (!byMondayId.has(update.itemId) || listed.has(update.itemId)) continue;
      for (const [assetId, name] of update.assets) {
        const expected = assets.get(update.itemId) ?? new Map<string, ExpectedFile>();
        if (!expected.has(assetId)) expected.set(assetId, expectedFile(assetId, name));
        assets.set(update.itemId, expected);
      }
    }
    const lines: string[] = [];
    let short = 0;
    for (const [mid, expected] of assets) {
      const label = `files: '${names.get(mid) ?? ""}' (${mid})`;
      const mapped = options.filesMapped ? await options.filesMapped(mid).catch((): FileMapping[] => []) : [];
      const found = await filesMissing(plaky, config, plakyIdOf.get(mid) as number, fileCounts.get(mid) ?? 0, expected, mapped, options.fileMeta);
      if ("unread" in found) {
        short++;
        lines.push(`${label}: not verified: its files could not be read (${found.unread})`);
        shortWithinLimits = true;
        continue;
      }
      if (!found.missing.length) continue;
      short++;
      lines.push(`${label}: missing in Plaky: ${listOf(found.missing.map((id) => expected.get(id)?.[0] ?? id))}`);
      if (found.missing.some((id) => (extract.assets[id]?.size ?? 0) <= MAX_UPLOAD_BYTES)) shortWithinLimits = true;
    }
    commentsOrFilesShort = commentsOrFilesShort || short > 0;
    const total = [...assets.values()].reduce((sum, ids) => sum + ids.size, 0);
    const holding = [...assets.values()].filter((ids) => ids.size).length;
    notes.push(`files: ${total} monday file(s) on ${holding} item(s)` + (short ? `; ${short} item(s) do not hold them all in Plaky` : ", all carried"), ...lines);
  }

  const board = manifest?.boards.find((b) => b.id === config.mondayBoardId);
  const dropped = board ? board.dropped.map((c) => `${c.title} (${c.type}): ${c.reason}`) : [];

  return boardReport({
    name: config.name,
    mondayBoardId: config.mondayBoardId,
    plakyBoardId: config.plakyBoardId,
    mondayItems: mondayItems.length,
    plakyItems: plakyRows.length - identities.filter(([, , key]) => key && outside.has(key)).length,
    matched: mondayItems.length - missing.length,
    missing,
    extra,
    unidentified,
    seedRows,
    coverage,
    dropped,
    notes,
    assigned: [...assigned.values()],
    notCarried: unparented.map(([item, problem]) => `subitem '${item.name}' (${item.id}): ${problem}, so it is not carried`),
    commentsOrFilesShort,
    shortWithinLimits,
    uncarried,
  });
}

export async function checkValues(
  extract: BoardExtract,
  plaky: PlakyClient,
  config: BoardSync,
  directory: UserDirectory,
  people: PeopleMap,
  options: { plakyRows?: readonly PlakyRow[]; parentTitles?: ReadonlyMap<string, string>; parentRows?: readonly PlakyRow[]; rich?: boolean } = {},
): Promise<[differing: string[], drifted: string[], notCarried: string[], uncarried: string[], notes: string[]]> {
  const plan = await planBoard(extract, plaky, config, {
    directory,
    peopleMap: people,
    ...(options.rich ? { rich: true } : {}),
    ...(options.plakyRows === undefined ? {} : { plakyRows: options.plakyRows }),
    ...(options.parentTitles === undefined ? {} : { parentTitles: options.parentTitles }),
  });
  const label = (w: { title: string; mondayItemId: string }): string => `${w.title} (${w.mondayItemId})`;
  return [
    plan.writes.filter((w) => writeAction(w) === "update").map(label),
    plan.writes.filter((w) => w.drifted && w.existingItemId).map(label),
    plan.writes.filter((w) => w.existingItemId).flatMap((w) => w.notCarried.map((note) => `${label(w)}: ${note}`)),
    plan.uncarried,
    structureNotes(plan, options.plakyRows ?? [], options.parentRows ?? []),
  ];
}

const idOf = (value: unknown): number | null => {
  const raw = value !== null && typeof value === "object" ? (value as { id?: unknown }).id : value;
  const n = Number(raw);
  return raw === null || raw === undefined || raw === "" || !Number.isFinite(n) ? null : n;
};

function structureNotes(plan: Awaited<ReturnType<typeof planBoard>>, plakyRows: readonly PlakyRow[], parentRows: readonly PlakyRow[]): string[] {
  const notes: string[] = [];
  if (plan.groupWrites.length) notes.push(`${plan.groupWrites.length} group write(s) pending (a group renamed, added or reordered in monday since): the next Move makes them`);
  const regrouped = plan.writes.filter((w) => changesGroup(w, plan.groupIds));
  if (regrouped.length) {
    notes.push(`${regrouped.length} item(s) are in another group in Plaky than in monday (the next full Move moves them): ${regrouped.slice(0, 5).map((w) => `${w.title} (${w.mondayItemId})`).join(", ")}`);
  }
  const ranks = rankings(plakyRows);
  const plakyGroupOf = new Map(plakyRows.map((row) => [idOf(row["id"]), idOf(row["group"])]));
  const byGroup = new Map<string, { title: string; ranking: string }[]>();
  const labels = new Map<string, string>();
  for (const w of plan.writes) {
    const ranking = w.existingItemId ? ranks.get(w.existingItemId) : undefined;
    if (ranking === undefined || changesGroup(w, plan.groupIds)) continue;
    const key = plan.config.nested ? `parent ${w.parentMondayItemId ?? ""}` : w.groupTitle !== null ? `title ${w.groupTitle}` : `group ${plakyGroupOf.get(w.existingItemId) ?? ""}`;
    labels.set(key, plan.config.nested ? key : (w.groupTitle ?? "The board"));
    byGroup.set(key, [...(byGroup.get(key) ?? []), { title: w.title, ranking }]);
  }
  const outOfOrder = [...byGroup].filter(([, rows]) => !rising(rows.map((row) => row.ranking)));
  if (plan.config.nested && outOfOrder.length) {
    notes.push(`items in ${outOfOrder.length} parent row(s) are not in monday's order in Plaky (Plaky's API cannot reorder subitems): ${outOfOrder.slice(0, 5).map(([k]) => `'${k}'`).join(", ")}`);
  }
  if (!plan.config.nested) {
    for (const [key, rows] of outOfOrder) {
      const flagged = rows.filter((row, at) => (at > 0 && row.ranking <= rows[at - 1]!.ranking) || (at + 1 < rows.length && rows[at + 1]!.ranking <= row.ranking));
      const tied = rows.some((row, at) => at > 0 && row.ranking === rows[at - 1]!.ranking);
      const names = flagged.slice(0, 5).map((row) => row.title).join(", ") + (flagged.length > 5 ? ", …" : "");
      notes.push(`${labels.get(key)}: ${flagged.length} item(s) are not in monday's order (${names}): ${tied ? "Plaky's API puts a moved item at a fixed place" : "Plaky's API cannot put an item at a chosen place"}; drag them in Plaky`);
    }
  }
  if (plan.config.nested && plan.mondayIdKey !== null) {
    const key = plan.mondayIdKey;
    const plakyIdOf = new Map<string, number>();
    for (const row of parentRows) {
      const id = idOf(row["id"]);
      const field = rowsOf(row["fields"]).find((f) => (f as { key?: unknown }).key === key) as { value?: unknown } | undefined;
      if (id !== null && typeof field?.value === "string" && field.value) plakyIdOf.set(field.value, id);
    }
    const parentOf = new Map(plakyRows.flatMap((row) => { const id = idOf(row["id"]); return id === null ? [] : [[id, idOf(row["parent"])] as const]; }));
    const moved = plan.writes.filter((w) => {
      if (!w.existingItemId || !w.parentMondayItemId) return false;
      const want = plakyIdOf.get(w.parentMondayItemId);
      return want !== undefined && parentOf.get(w.existingItemId) !== want;
    });
    if (moved.length) {
      notes.push(`${moved.length} subitem(s) sit under another parent row in Plaky than in monday (Plaky's API sets the parent only when a row is created): ${moved.slice(0, 5).map((w) => `${w.title} (${w.mondayItemId})`).join(", ")}`);
    }
  }
  return notes;
}
const rowsOf = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

export async function verify(
  read: (board: BoardSync) => Promise<BoardExtract>,
  plaky: PlakyClient,
  config: Pick<SyncConfig, "boards" | "people">,
  manifest: ManifestLike | null = null,
  options: { parentTitles?: ParentTitles; docs?: boolean; rich?: boolean; filesMapped?: (mondayItemId: string) => Promise<FileMapping[]>; fileMeta?: FileMeta } = {},
): Promise<Receipt> {
  const result = receipt();
  let directory: UserDirectory | null = null;
  const users: BoardExtract["users"] = {};
  const teams: BoardExtract["teams"] = {};
  const names = new Map<string, ReadonlyMap<string, string>>();
  const listings = new Map<string, PlakyRow[]>();
  for (const board of config.boards) {
    try {
      requireMondayIdField(board);
      const extract = await read(board);
      Object.assign(users, extract.users);
      Object.assign(teams, extract.teams);
      if (!extract.isDelta) names.set(extract.board.id, new Map(extract.items.map((item) => [item.id, item.name])));
      const rows: PlakyRow[] = [];
      const parentTitles = board.subitemsOf ? (names.get(board.subitemsOf) ?? (await options.parentTitles?.(board.subitemsOf))) : undefined;
      const report = await verifyBoard(extract, plaky, board, manifest, {
        people: config.people, rowsRead: rows, filesMapped: options.filesMapped, fileMeta: options.fileMeta, ...(options.docs ? { docs: true } : {}), ...(options.rich ? { rich: true } : {}), ...(board.nested && parentTitles ? { parentIds: new Set(parentTitles.keys()) } : {}),
      });
      try {
        directory ??= await loadDirectory(plaky);
        listings.set(board.mondayBoardId, rows);
        const parentRows = board.nested && board.subitemsOf ? listings.get(board.subitemsOf) : undefined;
        const [differing, drifted, notCarried, uncarried, structure] = await checkValues(extract, plaky, board, directory, config.people, {
          plakyRows: rows, ...(options.rich ? { rich: true } : {}),
          ...(parentRows === undefined ? {} : { parentRows }),
          ...(parentTitles === undefined ? {} : { parentTitles }),
        });
        report.differing = differing;
        report.notCarried = [...report.notCarried, ...notCarried];
        report.uncarried = uncarried;
        if (drifted.length) {
          report.notes.push(`${drifted.length} item(s) were renamed in monday; Plaky's API cannot rename an item: ${drifted.slice(0, 5).join(", ")}`);
        }
        report.notes.push(...structure);
      } catch (error) {
        result.failures.push(`${board.name}: values not compared: ${failureText(error)}`);
      }
      result.boards.push(report);
    } catch (error) {
      result.failures.push(`${board.name}: ${failureText(error)}`);
    }
  }
  const refs = new Map<string, [string, string]>();
  for (const b of result.boards) for (const ref of b.assigned) refs.set(JSON.stringify(ref), ref);
  if (refs.size) {
    const all = [...refs.values()];
    try {
      const people = resolvePeople({
        userIds: all.filter(([kind]) => kind === "person").map(([, id]) => id),
        teamIds: all.filter(([kind]) => kind === "team").map(([, id]) => id),
        mondayUsers: users,
        mondayTeams: teams,
        directory: directory ?? (await loadDirectory(plaky)),
        overrides: config.people,
      });
      result.unmatchedUsers = people.problems();
    } catch (error) {
      result.failures.push(`people not checked: ${failureText(error)}`);
    }
    const agents = all.filter(([kind]) => kind === "agent").length;
    if (agents) result.unmatchedUsers.push(`${agents} monday agent(s) have no Plaky counterpart`);
  }
  return result;
}

export function receiptJson(r: Receipt): Record<string, unknown> {
  return {
    ok: receiptOk(r),
    monday_items: receiptMondayItems(r),
    matched: receiptMatched(r),
    boards: r.boards.map((b) => ({
      name: b.name,
      monday_board_id: b.mondayBoardId,
      plaky_board_id: b.plakyBoardId,
      monday_items: b.mondayItems,
      plaky_items: b.plakyItems,
      matched: b.matched,
      missing: b.missing,
      extra: b.extra,
      unidentified: b.unidentified,
      seed_rows: b.seedRows,
      coverage: b.coverage.map((cov) => ({ name: cov.name, monday_filled: cov.mondayFilled, plaky_filled: cov.plakyFilled, shortfall: shortfall(cov) })),
      dropped: b.dropped,
      notes: b.notes,
      assigned: b.assigned,
      differing: b.differing,
      not_carried: b.notCarried,
      comments_or_files_short: b.commentsOrFilesShort,
      uncarried: b.uncarried,
      complete: boardComplete(b),
    })),
    failures: [...r.failures],
    unmatched_users: [...r.unmatchedUsers],
  };
}
