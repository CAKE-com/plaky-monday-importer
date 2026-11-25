import type { MondayClient } from "../clients/monday";
import { SYNTHETIC_COLUMNS, normalizeBoard, withTags, type ExtractedBoard, type ExtractedTeam, type ExtractedUser } from "./extract";
import {
  columnPlan,
  discoveredBoard,
  discoveredPerson,
  isImportable,
  type ColumnPlan,
  type ImportAs,
  type DiscoveredBoard,
  type DiscoveredPerson,
  type Manifest,
  type SkippedBoard,
} from "./manifest";
import { RESERVED_FIELD_NAMES, isLevelEntry, levelId, levelTwoId } from "./names";
import { CHECKBOX_LABELS, UNMAPPABLE_REASON, compatibleTypes, deactivatedLabelIds, preferredType, seedLabels, singleSelect } from "./transform/compat";
import { normalizeTitle, spellingKey } from "./transform/mapping";
import { mondayState, placeholderTitles, type MondayUserRow, type UserDirectory } from "./transform/people";
import { isDict, pyOr, pyStr, pyStrip, truthy } from "./transform/pystr";
import { pyRepr, sortedStrings, strOf } from "./transform/pyvalue";

export const BOARD_TYPE = "board";
const SUBITEM_TYPE = "sub_items_board";
const SKIP_TYPES: Readonly<Record<string, string>> = {
  custom_object: "a monday custom object, not a board",
  document: "a monday doc, not a board",
};

const EXTRA_FIELDS: Readonly<Record<string, readonly [name: string, plakyType: string]>> = {
  __description: ["Description", "RICH_TEXT"],
  __created_at: ["Created", "DATE_TIME"],
  __created_by: ["Created by", "STRING"],
  __url: ["monday link", "LINK"],
};

export type ListedBoard = {
  id: string;
  name?: string | null | undefined;
  itemsCount?: number | null | undefined;
  type?: string | null | undefined;
  state?: string | null | undefined;
};

export type BoardReferences = {
  people: readonly (readonly [kind: string, id: string])[];
  tagIds: readonly string[];
  labelIds?: readonly (readonly [columnId: string, labelId: string])[];
  byColumn?: readonly (readonly [columnId: string, who: string])[];
};

export type MondayTeamRow = { name?: string | null | undefined; users?: readonly { email?: string | null | undefined }[] | null | undefined };

export type DiscoverSource = {
  listBoards(): Promise<readonly ListedBoard[]>;
  boards(ids: string[]): Promise<readonly ExtractedBoard[]>;
  references(boardId: string, columnIds: string[]): Promise<BoardReferences>;
  tagNames(ids: string[]): Promise<ReadonlyMap<string, string>>;
  users(ids: string[]): Promise<Readonly<Record<string, MondayUserRow>>>;
  teams(ids: string[]): Promise<Readonly<Record<string, MondayTeamRow>>>;
  itemsByLevel?(boardId: string): Promise<readonly number[]>;
};

export function mondaySource(client: Pick<MondayClient, "listBoards" | "boards" | "references" | "tagNames" | "getUsers" | "getTeams" | "itemsByLevel" | "oldestPersonField">): DiscoverSource {
  return {
    itemsByLevel: (boardId) => client.itemsByLevel(boardId),
    async listBoards() {
      return (await client.listBoards()).map((row) => ({ id: String(row.id), name: row.name, itemsCount: row.items_count, type: row.type, state: row.state }));
    },
    async boards(ids) {
      const boards = (await client.boards(ids)).map(normalizeBoard);
      for (const board of boards) {
        const people = board.columns.filter((c) => !Object.hasOwn(SYNTHETIC_COLUMNS, c.id) && preferredType(c.type) === "PERSON");
        if (people.length < 2 || people.filter((c) => c.title.toLowerCase().includes("assignee")).length === 1) continue;
        const oldest = await client.oldestPersonField(board.id, people.map((c) => c.id));
        if (oldest) board.oldestPersonId = oldest;
        else board.assigneeNeedsReview = true;
      }
      return boards;
    },
    references: (boardId, columnIds) => client.references(boardId, columnIds),
    tagNames: (ids) => client.tagNames(ids),
    async users(ids) {
      const out: Record<string, ExtractedUser> = {};
      for (const [id, u] of await client.getUsers(ids)) out[id] = { id, name: u.name ?? null, email: u.email ?? null, enabled: u.enabled ?? null, isPending: u.is_pending ?? null, isGuest: u.is_guest ?? null };
      return out;
    },
    async teams(ids) {
      const out: Record<string, ExtractedTeam> = {};
      for (const [id, t] of await client.getTeams(ids)) out[id] = { id, name: t.name ?? null, users: (t.users ?? []).map((u) => ({ id: String(u.id), email: u.email ?? null })) };
      return out;
    },
  };
}

export function uniqueFieldNames(titles: readonly string[], reserved: readonly string[]): string[] {
  const taken = new Set(reserved.map(normalizeTitle));
  return titles.map((title) => {
    let candidate = pyStrip(title) || "Untitled";
    if (taken.has(normalizeTitle(candidate))) {
      let suffix = 2;
      while (taken.has(normalizeTitle(`${candidate} (${suffix})`))) suffix++;
      candidate = `${candidate} (${suffix})`;
    }
    taken.add(normalizeTitle(candidate));
    return candidate;
  });
}

export function extraColumns(board: Pick<ExtractedBoard, "columns">, extras: ReadonlySet<string>): string[] {
  const wanted = ["__description"];
  if (extras.has("created")) {
    if (!board.columns.some((c) => c.type === "creation_log" && !Object.hasOwn(SYNTHETIC_COLUMNS, c.id))) wanted.push("__created_at");
    wanted.push("__created_by");
  }
  if (extras.has("link")) wanted.push("__url");
  return wanted;
}

type PlanOptions = {
  isSubitemBoard?: boolean;
  extras?: ReadonlySet<string>;
  usedLabels?: ReadonlyMap<string, ReadonlySet<string>>;
};

const LEFT_OUT: Readonly<Record<string, string>> = {
  last_updated: "when the item was last changed in monday, which means nothing once the work moves to Plaky; left out by decision",
};

export function planColumns(board: ExtractedBoard, options: PlanOptions = {}): ColumnPlan[] {
  const extras = options.extras ?? new Set<string>();
  const columns = board.columns.filter((c) => !Object.hasOwn(SYNTHETIC_COLUMNS, c.id));
  const extraIds = extraColumns(board, extras);
  const reserved = options.isSubitemBoard ? RESERVED_FIELD_NAMES : RESERVED_FIELD_NAMES.slice(0, 2);
  const extraField = (id: string): readonly [string, string] => EXTRA_FIELDS[id] ?? ["", ""];
  const allNames = uniqueFieldNames([...columns.map((c) => c.title), ...extraIds.map((id) => extraField(id)[0])], reserved);

  const plans = columns.map((column, at): ColumnPlan => {
    const leftOut = Object.hasOwn(LEFT_OUT, column.type) ? LEFT_OUT[column.type]! : null;
    const plakyType = leftOut !== null ? null : column.type === "dropdown" && singleSelect(column) ? "STATUS" : preferredType(column.type);
    let reason: string | null = leftOut;
    if (plakyType === null && reason === null) {
      reason = Object.hasOwn(UNMAPPABLE_REASON, column.type) ? (UNMAPPABLE_REASON[column.type] ?? null) : `monday type '${column.type}' has nothing Plaky can store`;
    }
    const labels: string[] = [];
    const collisions: string[] = [];
    if (plakyType === "STATUS" || plakyType === "TAG") {
      const seen = new Set<string>();
      const normalizedSeen = new Map<string, string>();
      for (const label of column.type === "checkbox" ? CHECKBOX_LABELS : seedLabels(column, options.usedLabels?.get(column.id))) {
        const normalized = spellingKey(label);
        const isNew = !seen.has(label);
        if (isNew) {
          labels.push(label);
          seen.add(label);
        }
        const first = normalizedSeen.get(normalized);
        if (isNew && first !== undefined && label !== first) collisions.push(`${pyRepr(first)} / ${pyRepr(label)}`);
        else normalizedSeen.set(normalized, label);
      }
    }
    return columnPlan({ id: column.id, title: column.title, type: column.type, fieldName: allNames[at] ?? "", plakyType, reason, labels, labelCollisions: collisions });
  });
  masterFields(plans, plans.length, board.oldestPersonId);
  extraIds.forEach((id, at) => {
    const [title, type] = SYNTHETIC_COLUMNS[id] ?? ["", ""];
    plans.push(columnPlan({ id, title, type, fieldName: allNames[columns.length + at] ?? "", plakyType: extraField(id)[1] }));
  });
  return plans;
}

const oneStatusReason = (statusField: string): string => `Plaky holds one Status field per board: '${statusField}' is it, so this one is a Dropdown`;

function masterOf(pool: readonly ColumnPlan[], name: string, oldestId?: string): ColumnPlan | undefined {
  const named = pool.filter((p) => p.title.toLowerCase().includes(name));
  return named.length === 1 ? named[0] : pool.find((p) => p.id === oldestId) ?? pool[0];
}

function asMaster(plan: ColumnPlan, importAs?: ImportAs): ColumnPlan {
  const copy = { ...plan };
  delete copy.importAs;
  return importAs ? { ...copy, importAs } : copy;
}

function masterFields(plans: ColumnPlan[], own = plans.length, oldestPersonId?: string): void {
  const pool = (candidates: (p: ColumnPlan) => boolean): ColumnPlan[] => {
    const ownOnes = plans.slice(0, own).filter(candidates);
    return ownOnes.length ? ownOnes : plans.filter(candidates);
  };
  const choose = (candidates: (p: ColumnPlan) => boolean, name: string): ColumnPlan | undefined => masterOf(pool(candidates), name, name === "assignee" ? oldestPersonId : undefined);
  const isDropdown = (p: ColumnPlan): boolean => p.plakyType === "STATUS" && p.type === "dropdown";
  const isStatus = (p: ColumnPlan): boolean => p.plakyType === "STATUS" && !isDropdown(p);
  const statuses = pool(isStatus);
  const status = masterOf(statuses.some((p) => p.type === "status") ? statuses.filter((p) => p.type === "status") : statuses, "status");
  const assignee = choose((p) => p.plakyType === "PERSON" && !Object.hasOwn(SYNTHETIC_COLUMNS, p.id), "assignee");
  const dueDate = choose((p) => p.plakyType === "DATE_TIME" && p.type === "date", "due date");
  for (const [at, plan] of plans.entries()) {
    if (isStatus(plan)) plans[at] = plan === status ? asMaster({ ...plan, reason: null }) : asMaster({ ...plan, reason: oneStatusReason(status!.fieldName) }, "Dropdown");
    else plans[at] = asMaster(plan, isDropdown(plan) ? "Dropdown" : plan === assignee ? "Assignee" : plan === dueDate ? "Due Date" : undefined);
  }
}

function privacyStep(kind: string | undefined, permissions: string | undefined): string | null {
  const edits = permissions && permissions !== "everyone" ? permissions : null;
  if (kind === "private") {
    return `Restrict the board in Plaky: in monday it is private (only its members see it)${edits ? `, and only "${edits}" may edit it` : ""}. Plaky's API cannot do this: in Plaky, make the board Private and add those members.`;
  }
  if (kind === "share") {
    return `Check who sees the board in Plaky: in monday it is shareable (people outside the account can be invited to it)${edits ? `, and only "${edits}" may edit it` : ""}. Plaky's API cannot do this: in Plaky, make the board Private if not everyone in the space should see it, and invite guests by hand.`;
  }
  if (edits) return `Limit edits in Plaky: in monday only "${edits}" may edit this board. Plaky's API cannot do this: in Plaky, limit the board's edit permissions (to content, or to updates) by hand.`;
  return null;
}

export function privacyFlag(kind: string | null | undefined, permissions: string | null | undefined): string | null {
  const edits = permissions && permissions !== "everyone" ? permissions : null;
  if (kind === "private") return `private in monday${edits ? `; only "${edits}" may edit` : ""}`;
  if (kind === "share") return `shareable in monday${edits ? `; only "${edits}" may edit` : ""}`;
  return edits ? `only "${edits}" may edit in monday` : null;
}

export function finishByHand(board: ExtractedBoard, plans: readonly ColumnPlan[]): string[] {
  const out = [`Rename the imported "New board" to "${board.name}".`];
  if (board.assigneeNeedsReview) out.push("Check Assignee in Plaky; monday’s field creation order is unavailable.");
  if (board.description) out.push(`Paste the board description: ${pyStrip(board.description)}`);
  const restrict = privacyStep(board.kind, board.permissions);
  if (restrict) out.push(restrict);
  const byId = new Map(board.columns.map((c) => [c.id, c]));
  for (const plan of plans) {
    const settings = byId.get(plan.id)?.settings;
    if (!isDict(settings)) continue;
    const unit = settings["unit"];
    if (plan.plakyType === "NUMBER" && isDict(unit) && truthy(unit["symbol"])) {
      out.push(`'${plan.fieldName}' shows the unit ${strOf(unit["symbol"])} on the ${strOf(pyOr(unit["direction"], "left"))}.`);
    }
  }
  const views = board.views.filter(([, kind]) => kind && kind !== "table").map(([name, kind]) => `${name} (${kind})`);
  if (views.length) out.push(`Recreate the views: ${views.join(", ")}.`);
  return out;
}

export async function discoverPeople(
  source: Pick<DiscoverSource, "users" | "teams">,
  references: ReadonlyMap<string, BoardReferences>,
  directory: UserDirectory,
): Promise<DiscoveredPerson[]> {
  const refs = new Map<string, { kind: string; id: string; boards: string[] }>();
  for (const [boardId, found] of references) {
    for (const [kind, id] of found.people) {
      const key = `${kind}\u0000${id}`;
      const ref = refs.get(key) ?? { kind, id, boards: [] };
      ref.boards.push(boardId);
      refs.set(key, ref);
    }
  }
  const all = [...refs.values()];
  const userIds = all.filter((r) => r.kind === "person").map((r) => r.id);
  const teamIds = all.filter((r) => r.kind === "team").map((r) => r.id);
  const users = await source.users(userIds);
  const teams = await source.teams(teamIds);
  const titles = placeholderTitles(users, userIds);
  const rowOf = <T>(rows: Readonly<Record<string, T>>, id: string): T | undefined => (Object.hasOwn(rows, id) ? rows[id] : undefined);

  return all.map(({ kind, id, boards }): DiscoveredPerson => {
    const on = [...new Set(boards)];
    if (kind === "person") {
      const row = rowOf(users, id);
      const assignable = directory.assignable(row?.email) !== null;
      return discoveredPerson({
        id,
        kind,
        name: pyStr(pyOr(row?.name, `monday user ${id}`)),
        email: row?.email ?? null,
        state: mondayState(row),
        placeholder: assignable ? null : (titles.get(id) ?? null),
        boards: on,
      });
    }
    if (kind === "team") {
      const row = rowOf(teams, id);
      return discoveredPerson({
        id,
        kind,
        name: pyStr(pyOr(row?.name, `monday team ${id}`)),
        members: sortedStrings((row?.users ?? []).filter((u) => isDict(u) && truthy(u.email)).map((u) => String(u.email).toLowerCase())),
        boards: on,
      });
    }
    return discoveredPerson({ id, kind, name: `monday ${kind} ${id}`, boards: on });
  });
}

function usedLabelsOf(found: BoardReferences | undefined): Map<string, Set<string>> {
  const used = new Map<string, Set<string>>();
  for (const [columnId, labelId] of found?.labelIds ?? []) used.set(columnId, new Set([...(used.get(columnId) ?? []), labelId]));
  return used;
}

async function planWithReferences(source: DiscoverSource, board: ExtractedBoard, options: PlanOptions): Promise<{ board: ExtractedBoard; columns: ColumnPlan[]; found: BoardReferences }> {
  const first = planColumns(board, options);
  const byId = new Map(board.columns.map((c) => [c.id, c]));
  const retired = (c: ColumnPlan): boolean => (c.plakyType === "STATUS" || c.plakyType === "TAG") && c.type !== "checkbox" && deactivatedLabelIds(byId.get(c.id) ?? { settings: null, settingsStr: "{}" }).size > 0;
  const read = first.filter((c) => isImportable(c) && (c.plakyType === "PERSON" || c.type === "tags" || retired(c))).map((c) => c.id);
  const found = await source.references(board.id, read);
  const usedLabels = usedLabelsOf(found);
  const known = new Set(board.tags.map(([id]) => id));
  const unknown = found.tagIds.filter((tag) => !known.has(tag));
  if (unknown.length) board = withTags(board, await source.tagNames(unknown));
  const columns = unknown.length || usedLabels.size ? planColumns(board, { ...options, usedLabels }) : first;
  return { board, columns: withAssigned(columns, found), found };
}

function withAssigned(columns: ColumnPlan[], found: Pick<BoardReferences, "byColumn"> | undefined): ColumnPlan[] {
  const byColumn = found?.byColumn;
  if (!byColumn) return columns;
  return columns.map((c) => (c.plakyType === "PERSON" ? { ...c, assigned: [...new Set(byColumn.filter(([column]) => column === c.id).map(([, id]) => id))] } : c));
}

type SubitemsMode = "board" | "nested";

const NESTED_SUBTASKS_REASON = "subitems nest under their items on this board";

function mergeLabels(into: string[], labels: readonly string[]): void {
  const spellings = new Map<string, number>();
  for (const label of into) spellings.set(spellingKey(label), (spellings.get(spellingKey(label)) ?? 0) + 1);
  for (const label of labels) {
    if (into.includes(label) || spellings.get(spellingKey(label)) === 1) continue;
    into.push(label);
    spellings.set(spellingKey(label), (spellings.get(spellingKey(label)) ?? 0) + 1);
  }
}

export function mergeNested(parent: DiscoveredBoard, sub: DiscoveredBoard): { parent: DiscoveredBoard; sub: DiscoveredBoard } {
  const own = parent.columns.map((c) => ({ ...c, labels: [...c.labels], ...(c.type === "subtasks" ? { reason: NESTED_SUBTASKS_REASON } : {}) }));
  const byName = new Map(own.filter(isImportable).map((c) => [normalizeTitle(c.fieldName), c]));
  const taken = new Set([...RESERVED_FIELD_NAMES.slice(0, 2), ...own.map((c) => c.fieldName)].map(normalizeTitle));
  const added: ColumnPlan[] = [];
  const columns = sub.columns.map((column): ColumnPlan => {
    if (!isImportable(column)) return { ...column };
    const match = byName.get(normalizeTitle(column.fieldName));
    if (match && match.plakyType !== null && (column.plakyType === match.plakyType || compatibleTypes(column.type).includes(match.plakyType))) {
      mergeLabels(match.labels as string[], column.labels);
      if (match.assigned && column.assigned) match.assigned = [...new Set([...match.assigned, ...column.assigned])];
      return asMaster({ ...column, fieldName: match.fieldName, plakyType: match.plakyType, labels: [...column.labels] }, match.importAs);
    }
    let candidate = pyStrip(column.fieldName) || "Untitled";
    if (taken.has(normalizeTitle(candidate))) candidate = `${candidate} (subitems)`;
    let suffix = 2;
    const base = candidate;
    while (taken.has(normalizeTitle(candidate))) candidate = `${base} (${suffix++})`;
    taken.add(normalizeTitle(candidate));
    const renamed = { ...column, fieldName: candidate, labels: [...column.labels] };
    added.push(renamed);
    return renamed;
  });
  const seeded = [...own, ...added];
  masterFields(seeded, own.length, own.find((p) => p.importAs === "Assignee")?.id ?? added.find((p) => p.importAs === "Assignee")?.id);
  const planned = new Map(seeded.slice(own.length).map((c) => [c.id, c]));
  return {
    parent: { ...parent, columns: seeded.slice(0, own.length), nestedColumns: seeded.slice(own.length) },
    sub: { ...sub, columns: columns.map((c) => (planned.has(c.id) ? asMaster({ ...c, plakyType: planned.get(c.id)!.plakyType, reason: planned.get(c.id)!.reason }, planned.get(c.id)!.importAs) : c)), nested: true },
  };
}

export type DiscoverOptions = {
  batchSize?: number;
  keepNested?: ReadonlySet<string>;
  levels?: boolean;
  subitems?: SubitemsMode;
  extras?: Iterable<string>;
  only?: Iterable<string>;
  listArchived?: boolean;
  now?: () => Date;
};

const nameOf = (entry: ListedBoard): string => (truthy(entry.name) ? String(entry.name) : entry.id);
const countOf = (entry: ListedBoard | undefined): number => Math.trunc(entry?.itemsCount || 0);

const isoSeconds = (date: Date): string => `${date.toISOString().slice(0, 19)}+00:00`;

export async function discover(deps: { monday: DiscoverSource; directory: UserDirectory }, options: DiscoverOptions = {}): Promise<Manifest> {
  const { monday, directory } = deps;
  const batchSize = options.batchSize ?? 20;
  const extras = new Set(options.extras ?? []);
  const only = new Set(options.only ?? []);
  const plan: PlanOptions = { extras };

  const everything = await monday.listBoards();
  const archived = everything.filter((e) => e.state === "archived" && (!only.size || options.listArchived || only.has(e.id)));
  const listed = everything.filter((e) => (e.state === undefined ? "active" : e.state) === "active");
  const byId = new Map(listed.map((e) => [e.id, e]));

  let real = listed.filter((e) => e.type === BOARD_TYPE);
  if (only.size) real = real.filter((e) => only.has(e.id));
  const subitemIds = [...new Set(listed.filter((e) => e.type === SUBITEM_TYPE).map((e) => e.id))];

  const skipped: SkippedBoard[] = listed
    .filter((e) => e.type !== BOARD_TYPE && e.type !== SUBITEM_TYPE)
    .map((e) => ({
      id: e.id,
      name: nameOf(e),
      kind: pyStr(pyOr(e.type, "unknown")),
      reason: Object.hasOwn(SKIP_TYPES, pyStr(e.type)) ? (SKIP_TYPES[pyStr(e.type)] ?? "") : `monday type '${pyStr(e.type)}'`,
    }));
  skipped.push(
    ...archived.map((e) => ({
      id: e.id,
      name: nameOf(e),
      kind: pyStr(pyOr(e.type, "unknown")),
      reason: "archived in monday: restore it there, then run discover again to carry it",
    })),
  );

  const fetched = new Map<string, ExtractedBoard>();
  const ids = real.map((e) => e.id);
  for (let start = 0; start < ids.length; start += batchSize) {
    for (const loaded of await monday.boards(ids.slice(start, start + batchSize))) fetched.set(loaded.id, loaded);
  }

  const boards: DiscoveredBoard[] = [];
  const paired = new Map<string, string>();
  const references = new Map<string, BoardReferences>();
  const extracted = new Map<string, ExtractedBoard>();
  for (const entry of real) {
    const read = fetched.get(entry.id);
    if (read === undefined) {
      skipped.push({ id: entry.id, name: nameOf(entry), kind: BOARD_TYPE, reason: "listed by monday but could not be read" });
      continue;
    }
    const subitemId = read.subitemBoardIds.find((s) => subitemIds.includes(s)) ?? null;
    if (subitemId) paired.set(subitemId, entry.id);
    const { board, columns, found } = await planWithReferences(monday, read, plan);
    references.set(entry.id, found);
    extracted.set(entry.id, board);
    boards.push(
      discoveredBoard({
        id: entry.id,
        name: board.name,
        itemsCount: countOf(entry),
        columns,
        subitemBoardId: subitemId,
        hierarchyType: board.hierarchyType,
        byHand: finishByHand(board, columns),
      }),
    );
  }

  const pairedIds = subitemIds.filter((sid) => paired.has(sid));
  const fetchedSubitems = new Set<string>();
  const nested = options.subitems === "nested";
  for (let start = 0; start < pairedIds.length; start += batchSize) {
    for (const loaded of await monday.boards(pairedIds.slice(start, start + batchSize))) {
      fetchedSubitems.add(loaded.id);
      const { board, columns, found } = await planWithReferences(monday, loaded, { ...plan, isSubitemBoard: !nested });
      references.set(board.id, found);
      let sub = discoveredBoard({
        id: board.id,
        name: board.name,
        itemsCount: countOf(byId.get(board.id)),
        columns,
        parentBoardId: paired.get(board.id) ?? null,
        byHand: finishByHand(board, columns),
      });
      if (nested) {
        const at = boards.findIndex((b) => b.id === sub.parentBoardId);
        if (at >= 0) {
          const merged = mergeNested(boards[at]!, sub);
          boards[at] = merged.parent;
          sub = merged.sub;
        }
      }
      boards.push(sub);
    }
  }
  if (options.levels) {
    for (const [at, b] of [...boards.entries()]) {
      if (b.hierarchyType !== "multi_level" || b.parentBoardId !== null) continue;
      const counts = options.keepNested?.has(b.id) ? [] : ((await monday.itemsByLevel?.(b.id)) ?? []);
      if (counts.length > 2) {
        const source = extracted.get(b.id)!;
        boards[at] = { ...b, itemsCount: counts[0] ?? b.itemsCount, levelBoards: true };
        for (let level = 2; level <= counts.length; level++) {
          const name = `${b.name} (level ${level})`;
          const columns = withAssigned(planColumns(source, { ...plan, isSubitemBoard: true, usedLabels: usedLabelsOf(references.get(b.id)) }), references.get(b.id));
          boards.push(discoveredBoard({ id: levelId(b.id, level), name, itemsCount: counts[level - 1] ?? 0, columns, parentBoardId: level === 2 ? b.id : levelId(b.id, level - 1), byHand: finishByHand({ ...source, name }, columns) }));
        }
        continue;
      }
      const merged = mergeNested({ ...b, carriesLevelTwo: true }, discoveredBoard({ id: levelTwoId(b.id), name: `${b.name} (level 2)`, columns: b.columns, parentBoardId: b.id }));
      boards[at] = merged.parent;
      boards.push(merged.sub);
    }
  }
  for (const sid of pairedIds) {
    if (!fetchedSubitems.has(sid)) {
      skipped.push({ id: sid, name: nameOfId(byId, sid), kind: SUBITEM_TYPE, reason: "parent board is accessible, but monday did not return the subitem board" });
    }
  }

  if (!only.size) {
    for (const sid of sortedStrings(subitemIds.filter((s) => !paired.has(s)))) {
      skipped.push({ id: sid, name: nameOfId(byId, sid), kind: SUBITEM_TYPE, reason: "a subitem board whose parent board is not being migrated" });
    }
  }

  return { boards, skipped, generatedAt: isoSeconds((options.now ?? (() => new Date()))()), people: await discoverPeople(monday, references, directory) };
}

const nameOfId = (byId: ReadonlyMap<string, ListedBoard>, id: string): string => {
  const entry = byId.get(id);
  return entry && truthy(entry.name) ? String(entry.name) : id;
};

type BoardAutomationRow = { title: string; active: boolean | null; legacy: boolean };

export function withHandLists(m: Manifest, automations: ReadonlyMap<string, readonly BoardAutomationRow[]>, dashboards: readonly { id: string; name: string }[]): Manifest {
  return {
    ...m,
    boards: m.boards.map((b) => {
      const found = automations.get(b.id) ?? [];
      if (!found.length) return b;
      const named = found.map((a) => `${pyRepr(a.title)}${a.active === null ? "" : a.active ? " (on)" : " (off)"}`).join(", ");
      return { ...b, byHand: [...b.byHand, `Rebuild the monday automations in Plaky (its API cannot create them; set them up after Move, or every moved item fires them): ${named}. monday's API may leave out some older automations: check the board's automation center in monday too.`] };
    }),
    skipped: [...m.skipped, ...dashboards.map((d) => ({ id: d.id, name: d.name, kind: "dashboard", reason: "a monday dashboard: Plaky has none to carry it into; rebuild it by hand" }))],
  };
}

export async function withItemCounts(m: Manifest, monday: {
  createdItemIds(boardId: string): Promise<string[]>;
  boardLog?(boardId: string): Promise<{ items: { id: string }[]; archivedGroups: { title: string }[] }>;
  itemStates(ids: Iterable<string>): Promise<Map<string, string>>;
}): Promise<Manifest> {
  const boards: DiscoveredBoard[] = [];
  for (const b of m.boards) {
    if (isLevelEntry(b.id)) {
      boards.push(b);
      continue;
    }
    const log = monday.boardLog ? await monday.boardLog(b.id) : null;
    const states = await monday.itemStates(log ? log.items.map((item) => item.id) : await monday.createdItemIds(b.id));
    const count = (state: string): number => [...states.values()].filter((s) => s === state).length;
    boards.push({ ...b, archivedItems: count("archived"), deletedItems: count("deleted"), archivedGroups: log ? log.archivedGroups.map((g) => g.title) : b.archivedGroups });
  }
  return { ...m, boards };
}
