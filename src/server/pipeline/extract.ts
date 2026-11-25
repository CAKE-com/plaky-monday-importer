import { baseBoardId, levelId } from "./names";
import { inScope, keeps, type ExtractScope, type ItemFilter } from "./scope";
import { sanitizeHtml } from "./transform/richtext";
import { redact } from "../redact";
import { pyStrip, truthy } from "./transform/pystr";
import { strOf } from "./transform/pyvalue";
import {
  MondayClient,
  peopleIn,
  tagIdsIn,
  type RawBoard,
  type RawItem,
  type RawUpdate,
} from "../clients/monday";

type Dict = Record<string, unknown>;

export type ExtractedColumn = { id: string; title: string; type: string; settingsStr: string; settings: Dict | null };
export type ExtractedGroup = { id: string; title: string; color: string; position: string; archived: boolean };
export type ExtractedBoard = {
  id: string;
  name: string;
  columns: ExtractedColumn[];
  subitemBoardIds: string[];
  hierarchyType: string;
  tags: [id: string, name: string][];
  groups: ExtractedGroup[];
  description: string | null;
  views: [string, string][];
  kind?: string;
  permissions?: string;
  oldestPersonId?: string;
  assigneeNeedsReview?: boolean;
};
export type ColumnValue = Dict & { id: string; type: string; text?: string | null; value?: unknown };
export type ExtractedItem = {
  id: string;
  name: string;
  groupTitle: string | null;
  groupId: string | null;
  parentId: string | null;
  state: string;
  subscriberIds: string[];
  assets?: [id: string, name: string][];
  columnValues: Record<string, ColumnValue>;
};
export type ExtractedUpdate = {
  id: string;
  itemId: string;
  text: string;
  createdAt: string;
  author: string;
  editedAt: string | null;
  parentId: string | null;
  assets: [string, string][];
  body?: string;
  pinned?: boolean;
};
export type AssetMeta = { id: string; name: string | null; size: number | null };
export type ExtractedUser = { id: string; name: string | null; email: string | null; enabled: boolean | null; isPending: boolean | null; isGuest: boolean | null };
export type ExtractedTeam = { id: string; name: string | null; users: { id: string; email: string | null }[] };

export type BoardExtract = {
  board: ExtractedBoard;
  items: ExtractedItem[];
  updates: ExtractedUpdate[];
  assets: Record<string, AssetMeta>;
  users: Record<string, ExtractedUser>;
  teams: Record<string, ExtractedTeam>;
  people: { users: string[]; teams: string[]; agents: string[] };
  timeZone: string | null;
  isDelta?: boolean;
  deeper?: { id: string; name: string; level: number }[];
  archivedCarried?: number;
  outOfScope?: string[];
};

export const SYNTHETIC_COLUMNS: Record<string, [title: string, type: string]> = {
  __url: ["monday URL", "link"],
  __description: ["monday description", "long_text"],
  __created_at: ["monday created at", "creation_log"],
  __created_by: ["monday created by", "people"],
  __updated_at: ["monday last updated", "last_updated"],
};

export type RawSink = { save(entityType: "board" | "items_page" | "archived_items" | "archive_discovery" | "description" | "updates" | "assets_meta" | "users" | "teams" | "tags", entityId: string, payload: unknown): Promise<void> };

export function sanitizePayload(value: unknown): unknown {
  return redact(dropKeys(value, new Set(["public_url"])));
}

function dropKeys(value: unknown, keys: Set<string>): unknown {
  if (Array.isArray(value)) return value.map((v) => dropKeys(v, keys));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([k]) => !keys.has(k)).map(([k, v]) => [k, dropKeys(v, keys)]));
  return value;
}

const isDict = (v: unknown): v is Dict => Boolean(v) && typeof v === "object" && !Array.isArray(v);

export function subitemBoardIds(columns: ExtractedColumn[]): string[] {
  const out: string[] = [];
  for (const column of columns) {
    if (column.type !== "subtasks") continue;
    let settings: unknown;
    try {
      settings = JSON.parse(column.settingsStr || "{}");
    } catch {
      continue;
    }
    const ids = isDict(settings) && Array.isArray(settings["boardIds"]) ? settings["boardIds"] : [];
    out.push(...ids.map(String));
  }
  return out;
}

export function normalizeBoard(raw: RawBoard): ExtractedBoard {
  const tags = new Map<string, string>();
  for (const tag of raw.tags ?? []) if (tag.id !== null && tag.id !== undefined && tag.name) tags.set(String(tag.id), String(tag.name));
  const columns: ExtractedColumn[] = raw.columns.map((c) => ({
    id: c.id,
    title: c.title,
    type: c.type,
    settingsStr: c.settings_str || "{}",
    settings: isDict(c.settings) ? c.settings : null,
  }));
  for (const [id, [title, type]] of Object.entries(SYNTHETIC_COLUMNS)) columns.push({ id, title, type, settingsStr: "{}", settings: null });
  const groups = (raw.groups ?? [])
    .filter((g) => g.id !== null && g.id !== undefined && g.id !== "" && !g.deleted)
    .map((g) => ({ id: String(g.id), title: String(g.title ?? ""), color: String(g.color ?? ""), position: String(g.position ?? ""), archived: Boolean(g.archived) }));
  const board: ExtractedBoard = {
    id: String(raw.id),
    name: raw.name,
    columns,
    subitemBoardIds: subitemBoardIds(columns),
    hierarchyType: String(raw.hierarchy_type || "classic"),
    tags: [],
    groups,
    description: raw.description || null,
    views: (raw.views ?? []).map((v) => [String(v.name ?? ""), String(v.type ?? "")]),
    ...(raw.board_kind ? { kind: raw.board_kind } : {}),
    ...(raw.permissions ? { permissions: raw.permissions } : {}),
  };
  return withTags(board, tags);
}

export function withTags(board: ExtractedBoard, names: ReadonlyMap<string, string>): ExtractedBoard {
  const known = new Set(board.tags.map(([id]) => id));
  const added = [...names].filter(([id]) => !known.has(id));
  if (!added.length) return board;
  const tags = [...board.tags, ...added];
  const settings = { labels: tags.map(([id, label]) => ({ id, label })) };
  return { ...board, tags, columns: board.columns.map((c) => (c.type === "tags" ? { ...c, settings } : c)) };
}

type Block = Dict;
const BLOCK_PREFIX: Record<string, string> = { "bulleted list": "• ", quote: "> " };

const pyOr = (value: unknown, fallback: string): unknown => (value ? value : fallback);

function blockLines(block: Block, content: unknown, numbering: Map<number, number>): string | null {
  const kind = strOf(pyOr(block["type"], "")).toLowerCase();
  let text: string | null = null;
  let indent = 0;
  let checked: unknown = null;
  if (isDict(content)) {
    const level = content["indentation"];
    indent = typeof level === "boolean" ? Number(level) : Number.isInteger(level) ? (level as number) : 0;
    checked = content["checked"];
    const delta = content["deltaFormat"];
    if (Array.isArray(delta)) {
      text = delta
        .filter(isDict)
        .map((operation) => {
          const insert = operation["insert"];
          if (typeof insert === "string") return insert;
          if (isDict(insert) && typeof insert["text"] === "string") return insert["text"];
          return "";
        })
        .join("")
        .replace(/\n+$/, "");
    } else if (typeof content["text"] === "string") {
      text = content["text"];
    }
  } else if (typeof content === "string") {
    text = content;
  }
  if (kind === "divider") return "———";
  if (kind === "image" || kind === "video" || kind === "gif") return `[${kind}]`;
  if (!text) return null;
  const pad = "  ".repeat(Math.max(indent, 0));
  if (kind === "numbered list") {
    const n = (numbering.get(indent) ?? 0) + 1;
    numbering.set(indent, n);
    return `${pad}${n}. ${text}`;
  }
  numbering.clear();
  if (kind === "check list") return `${pad}${checked === true || checked === 1 || checked === "true" ? "☑" : "☐"} ${text}`;
  return pad + (BLOCK_PREFIX[kind] ?? "") + text;
}

function blockContent(block: Block): [unknown, string | null] {
  const content = block["content"];
  if (typeof content !== "string" || !content) return [content, null];
  let decoded: unknown;
  try {
    decoded = JSON.parse(content);
  } catch {
    return [null, content];
  }
  if (isDict(decoded)) return [decoded, null];
  return [null, decoded !== null ? strOf(decoded) : ""];
}

export function descriptionText(raw: { description?: { blocks?: unknown[] | null | undefined } | null | undefined }): string | null {
  const listed = raw.description?.blocks;
  const blocks = (Array.isArray(listed) ? listed : []).filter(isDict) as Block[];
  const cells = new Set(blocks.filter((b) => strOf(pyOr(b["type"], "")).toLowerCase() === "cell").map((b) => (b["id"] === null || b["id"] === undefined ? "None" : String(b["id"]))));
  const inCell = new Map<string, string[]>();
  for (const block of blocks) {
    const parent = strOf(pyOr(block["parent_block_id"], ""));
    if (!cells.has(parent)) continue;
    const [content, plain] = blockContent(block);
    const words = plain !== null ? plain : blockLines(block, content, new Map());
    if (words) inCell.set(parent, [...(inCell.get(parent) ?? []), words]);
  }
  const parts: string[] = [];
  const numbering = new Map<number, number>();
  for (const block of blocks) {
    const kind = strOf(pyOr(block["type"], "")).toLowerCase();
    if (kind === "cell" || cells.has(strOf(pyOr(block["parent_block_id"], "")))) continue;
    const [content, plain] = blockContent(block);
    if (plain !== null) {
      parts.push(plain);
      continue;
    }
    if (kind === "table" && isDict(content)) {
      numbering.clear();
      const rows = Array.isArray(content["cells"]) ? content["cells"] : [];
      for (const row of rows) {
        const texts = (Array.isArray(row) ? row : []).filter(isDict).map((cell) => (inCell.get(cell["blockId"] === null || cell["blockId"] === undefined ? "None" : String(cell["blockId"])) ?? []).join(" "));
        if (texts.some(Boolean)) parts.push(texts.join(" | "));
      }
      continue;
    }
    const line = blockLines(block, content, numbering);
    if (line) parts.push(line);
  }
  return parts.length ? parts.join("\n") : null;
}

const escapeText = (text: string): string => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function inlineHtml(content: unknown): string {
  if (!isDict(content)) return "";
  const delta = content["deltaFormat"];
  if (!Array.isArray(delta)) return typeof content["text"] === "string" ? escapeText(content["text"]) : "";
  return delta.filter(isDict).map((op) => {
    const insert = op["insert"];
    const raw = typeof insert === "string" ? insert : isDict(insert) && typeof insert["text"] === "string" ? insert["text"] : "";
    let html = escapeText(raw.replace(/\n+$/, "")).replace(/\n/g, "<br>");
    if (!html) return "";
    const a = isDict(op["attributes"]) ? op["attributes"] : {};
    if (a["code"]) html = `<code>${html}</code>`;
    if (a["strike"]) html = `<s>${html}</s>`;
    if (a["underline"]) html = `<u>${html}</u>`;
    if (a["italic"]) html = `<em>${html}</em>`;
    if (a["bold"]) html = `<strong>${html}</strong>`;
    if (typeof a["link"] === "string") html = `<a href="${a["link"].replace(/&/g, "&amp;").replace(/"/g, "&quot;")}">${html}</a>`;
    return html;
  }).join("");
}

export function descriptionImages(raw: { description?: { blocks?: unknown[] | null | undefined } | null | undefined }): { name: string; assetId: string; url: null }[] {
  const listed = raw.description?.blocks;
  const out: { name: string; assetId: string; url: null }[] = [];
  for (const block of (Array.isArray(listed) ? listed : []).filter(isDict) as Block[]) {
    if (strOf(pyOr(block["type"], "")).toLowerCase() !== "image") continue;
    const [content] = blockContent(block);
    const asset = isDict(content) ? content["assetId"] : null;
    if (typeof asset !== "number" && (typeof asset !== "string" || !asset)) continue;
    const name = isDict(content) && typeof content["name"] === "string" && content["name"] ? content["name"] : `image-${asset}`;
    out.push({ name, assetId: String(asset), url: null });
  }
  return out;
}

const BLOCK_TAG: Record<string, string> = { "large title": "h1", "medium title": "h2", "small title": "h3", quote: "blockquote" };
const LIST_TAG: Record<string, string> = { "bulleted list": "ul", "numbered list": "ol" };

const descriptionImagesOf = (item: ExtractedItem): { assetId: string }[] => {
  const images = item.columnValues["__description"]?.["images"];
  return Array.isArray(images) ? (images as { assetId: string }[]) : [];
};

export function descriptionHtml(raw: { description?: { blocks?: unknown[] | null | undefined } | null | undefined }): string | null {
  const listed = raw.description?.blocks;
  const blocks = (Array.isArray(listed) ? listed : []).filter(isDict) as Block[];
  const cells = new Set(blocks.filter((b) => strOf(pyOr(b["type"], "")).toLowerCase() === "cell").map((b) => (b["id"] === null || b["id"] === undefined ? "None" : String(b["id"]))));
  const inCell = new Map<string, string[]>();
  for (const block of blocks) {
    const parent = strOf(pyOr(block["parent_block_id"], ""));
    if (!cells.has(parent)) continue;
    const [content, plain] = blockContent(block);
    const words = plain !== null ? escapeText(plain) : inlineHtml(content);
    if (words) inCell.set(parent, [...(inCell.get(parent) ?? []), words]);
  }
  const parts: string[] = [];
  let list: string | null = null;
  const close = (): void => {
    if (list) parts.push(`</${list}>`);
    list = null;
  };
  for (const block of blocks) {
    const kind = strOf(pyOr(block["type"], "")).toLowerCase();
    if (kind === "cell" || cells.has(strOf(pyOr(block["parent_block_id"], "")))) continue;
    const [content, plain] = blockContent(block);
    if (plain !== null) {
      close();
      if (plain) parts.push(`<p>${escapeText(plain)}</p>`);
      continue;
    }
    if (kind === "table" && isDict(content)) {
      close();
      for (const row of Array.isArray(content["cells"]) ? content["cells"] : []) {
        const texts = (Array.isArray(row) ? row : []).filter(isDict).map((cell) => (inCell.get(cell["blockId"] === null || cell["blockId"] === undefined ? "None" : String(cell["blockId"])) ?? []).join(" "));
        if (texts.some(Boolean)) parts.push(`<p>${texts.join(" | ")}</p>`);
      }
      continue;
    }
    const tag = LIST_TAG[kind];
    if (tag) {
      if (list !== tag) {
        close();
        parts.push(`<${tag}>`);
        list = tag;
      }
      parts.push(`<li>${inlineHtml(content)}</li>`);
      continue;
    }
    close();
    if (kind === "divider") parts.push("<p>———</p>");
    else if (kind === "image" || kind === "video" || kind === "gif") parts.push(`<p>[${kind}]</p>`);
    else {
      const text = inlineHtml(content);
      if (!text) continue;
      if (kind === "check list") {
        const checked = isDict(content) ? content["checked"] : null;
        parts.push(`<p>${checked === true || checked === 1 || checked === "true" ? "☑" : "☐"} ${text}</p>`);
      } else if (kind === "code") parts.push(`<pre>${text}</pre>`);
      else {
        const t = BLOCK_TAG[kind] ?? "p";
        parts.push(`<${t}>${text}</${t}>`);
      }
    }
  }
  close();
  return parts.length ? sanitizeHtml(parts.join("")) : null;
}

function synthetic(value: unknown, type: string): ColumnValue | null {
  if (value === null || value === undefined || value === "") return null;
  return { id: "", type, text: String(value), value: null };
}

export function normalizeItem(raw: RawItem): ExtractedItem {
  const values: Record<string, ColumnValue> = {};
  for (const cv of raw.column_values ?? []) values[cv.id] = cv as ColumnValue;
  for (const [key, [, type]] of Object.entries(SYNTHETIC_COLUMNS)) {
    if (key === "__created_by") {
      const creator = raw.creator_id;
      if (creator !== null && creator !== undefined && creator !== "") {
        values[key] = { id: key, type, text: String(creator), value: `{"personsAndTeams": [{"id": ${Number(creator)}, "kind": "person"}]}` };
      }
      continue;
    }
    const source: Record<string, unknown> = { __url: raw.url, __description: descriptionText(raw), __created_at: raw.created_at, __updated_at: raw.updated_at };
    const wrapped = synthetic(source[key], type);
    const html = key === "__description" && wrapped ? descriptionHtml(raw) : null;
    const images = key === "__description" && wrapped ? descriptionImages(raw) : [];
    if (wrapped) values[key] = { ...wrapped, id: key, ...(html ? { html } : {}), ...(images.length ? { images } : {}) };
  }
  return {
    id: String(raw.id),
    name: raw.name,
    groupTitle: raw.group?.title ?? null,
    groupId: raw.group?.id ? String(raw.group.id) : null,
    parentId: raw.parent_item?.id ? String(raw.parent_item.id) : null,
    state: String(raw.state || "active"),
    subscriberIds: (raw.subscribers ?? []).filter((u) => u.id).map((u) => String(u.id)),
    columnValues: values,
    ...((raw.assets ?? []).length ? { assets: raw.assets!.map((a): [string, string] => [String(a.id), a.name ?? String(a.id)]) } : {}),
  };
}

type UpdateRow = NonNullable<RawUpdate["replies"]>[number];

function normalizeUpdate(raw: UpdateRow, itemId: string, parentId: string | null): ExtractedUpdate {
  let author = pyStrip(String(raw.creator?.name ?? ""));
  if (!author) author = raw.creator_id ? `monday user ${raw.creator_id}` : "unknown";
  return {
    id: String(raw.id),
    itemId,
    text: String(raw.text_body ?? ""),
    createdAt: String(raw.created_at ?? ""),
    author,
    editedAt: raw.edited_at ?? null,
    parentId,
    assets: (raw.assets ?? []).filter((a) => a.id).map((a): [string, string] => [String(a.id), String(a.name || a.id)]),
    ...(raw.body ? { body: String(raw.body) } : {}),
    ...((raw.pinned_to_top ?? []).some((pin) => String(pin.item_id ?? itemId) === itemId) ? { pinned: true } : {}),
  };
}

export function flattenUpdates(raws: RawUpdate[]): ExtractedUpdate[] {
  const out: ExtractedUpdate[] = [];
  for (const raw of raws) {
    const itemId = String(raw.item_id || "");
    out.push(normalizeUpdate(raw, itemId, null));
    for (const reply of raw.replies ?? []) if (reply.id) out.push(normalizeUpdate(reply, itemId, String(raw.id)));
  }
  return out;
}

type ExtractOptions = {
  since?: string | null;
  sink?: RawSink;
  archived?: boolean;
  allLevels?: boolean;
  scope?: ExtractScope;
};

export function fileColumnAssetIds(items: ExtractedItem[]): string[] {
  const ids = new Set<string>();
  for (const item of items)
    for (const cv of Object.values(item.columnValues)) {
      if (cv.type !== "file" || !cv.value) continue;
      let parsed: unknown;
      try {
        parsed = typeof cv.value === "string" ? JSON.parse(cv.value) : cv.value;
      } catch {
        continue;
      }
      const files = isDict(parsed) && Array.isArray(parsed["files"]) ? parsed["files"] : [];
      for (const file of files) if (isDict(file) && file["assetId"] !== null && file["assetId"] !== undefined && (truthy(file["fileType"]) ? strOf(file["fileType"]) : "ASSET").toUpperCase() === "ASSET") ids.add(String(file["assetId"]));
    }
  return [...ids];
}

function withCreatorNames(items: readonly ExtractedItem[], users: Readonly<Record<string, Pick<ExtractedUser, "name">>>): void {
  for (const item of items) {
    const cv = item.columnValues["__created_by"];
    if (!cv?.text) continue;
    const name = pyStrip(String((Object.hasOwn(users, cv.text) ? users[cv.text]?.name : null) ?? ""));
    item.columnValues["__created_by"] = { ...cv, display_value: name || `monday user ${cv.text}` };
  }
}

export function collectPeople(board: ExtractedBoard, items: ExtractedItem[]): { users: string[]; teams: string[]; agents: string[] } {
  const users = new Set<string>();
  const teams = new Set<string>();
  const agents = new Set<string>();
  const peopleColumns = new Set(board.columns.filter((c) => c.type === "people" || c.type === "person" || c.type === "team").map((c) => c.id));
  for (const item of items) {
    for (const [id, cv] of Object.entries(item.columnValues)) {
      if (!peopleColumns.has(id)) continue;
      for (const [kind, ref] of peopleIn(cv.value)) {
        if (kind === "person") users.add(ref);
        else if (kind === "team") teams.add(ref);
        else if (kind === "agent") agents.add(ref);
      }
    }
    for (const id of item.subscriberIds) users.add(id);
  }
  return { users: [...users], teams: [...teams], agents: [...agents] };
}

export function unknownTagIds(board: ExtractedBoard, items: ExtractedItem[]): string[] {
  const tagColumns = board.columns.filter((c) => c.type === "tags").map((c) => c.id);
  const known = new Set(board.tags.map(([id]) => id));
  const unknown = new Set<string>();
  for (const item of items)
    for (const id of tagColumns) for (const tag of tagIdsIn(item.columnValues[id]?.value)) if (!known.has(tag)) unknown.add(tag);
  return [...unknown].sort();
}

const ARCHIVED_GROUP_ID = "__archived";
export const ARCHIVED_GROUP_TITLE = "Archived in monday";
export const fromArchive = (item: Pick<ExtractedItem, "groupId">): boolean => item.groupId === ARCHIVED_GROUP_ID;

export function splitLevels(full: BoardExtract, levelTwoBoardId: string, filter?: ItemFilter, deepest = 2): { top: BoardExtract; second: BoardExtract; rest: Map<number, BoardExtract> } {
  const parentOf = new Map(full.items.map((item) => [item.id, item.parentId]));
  const levelOf = (id: string): number => {
    let level = 1;
    for (let at = parentOf.get(id); at !== null && at !== undefined; at = parentOf.get(at)) {
      level++;
      if (!parentOf.has(at)) return Math.max(level, 3);
    }
    return level;
  };
  const byId = new Map(full.items.map((item) => [item.id, item]));
  const archived = fromArchive;
  const decided = new Map<string, boolean>();
  const carried = (item: ExtractedItem, depth = 0): boolean => {
    if (!archived(item) || item.parentId === null) return true;
    const known = decided.get(item.id);
    if (known !== undefined) return known;
    const parent = byId.get(item.parentId);
    const ok = parent !== undefined && depth < byId.size && carried(parent, depth + 1);
    decided.set(item.id, ok);
    return ok;
  };
  const live = full.items.filter((item) => carried(item));
  const first = live.filter((item) => levelOf(item.id) === 1);
  const outFirst = filter ? first.filter((item) => !inScope(item, filter)) : [];
  const out = new Set(outFirst.map((item) => item.id));
  const deeper = live.filter((item) => levelOf(item.id) > deepest).map((item) => ({ id: item.id, name: item.name, level: levelOf(item.id) }));
  const pick = (items: ExtractedItem[], left: ExtractedItem[]): Pick<BoardExtract, "items" | "updates"> & { outOfScope?: string[] } => {
    const ids = new Set(items.map((item) => item.id));
    return { items, updates: full.updates.filter((update) => ids.has(update.itemId)), ...(filter ? { outOfScope: left.map((item) => item.id) } : {}) };
  };
  const shared = { ...full };
  delete shared.archivedCarried;
  const groups = filter?.groups;
  const levels = new Map<number, BoardExtract>();
  const below = (level: number): BoardExtract => {
    const found = levels.get(level);
    if (found) return found;
    if (level > 2) below(level - 1);
    const items = live.filter((item) => levelOf(item.id) === level);
    const left = items.filter((item) => out.has(item.parentId!));
    for (const item of left) out.add(item.id);
    const entry = { ...shared, ...pick(items.filter((item) => !out.has(item.id)), left), board: { ...full.board, id: levelId(baseBoardId(levelTwoBoardId), level), name: `${full.board.name} (level ${level})` } };
    levels.set(level, entry);
    return entry;
  };
  const second = below(2);
  const rest = new Map(Array.from({ length: Math.max(0, deepest - 2) }, (_, at) => [at + 3, below(at + 3)] as const));
  const carriedCount = [first.filter((item) => !out.has(item.id)), second.items, ...[...rest.values()].map((entry) => entry.items)].flat().filter(archived).length;
  return {
    top: {
      ...shared, ...pick(first.filter((item) => !out.has(item.id)), outFirst),
      board: groups ? { ...full.board, groups: full.board.groups.filter((g) => groups.includes(g.id)) } : full.board,
      ...(deeper.length ? { deeper } : {}), ...(carriedCount ? { archivedCarried: carriedCount } : {}),
    },
    second,
    rest,
  };
}

async function readArchived(client: MondayClient, boardId: string, active: readonly { id: string | number }[], sink?: RawSink): Promise<{ items: ExtractedItem[]; updates: RawUpdate[] }> {
  const known = new Set(active.map((item) => String(item.id)));
  const created = await client.createdItems(boardId);
  const loggedParent = new Map(created.map((item) => [item.id, item.parentId]));
  const states = await client.itemStates(created.map((item) => item.id).filter((id) => !known.has(id)));
  await sink?.save("archive_discovery", boardId, { created, states: [...states], unresolved: created.filter((item) => !known.has(item.id) && !states.has(item.id)).map((item) => item.id) });
  const { items, updates } = await client.archivedItems([...states].filter(([, state]) => state === "archived").map(([id]) => id), boardId);
  await sink?.save("archived_items", boardId, items);
  await sink?.save("updates", `${boardId}:archived`, updates);
  return {
    items: items.map((raw) => {
      const item = normalizeItem(raw);
      return { ...item, parentId: item.parentId ?? loggedParent.get(item.id) ?? null, state: "active", groupId: ARCHIVED_GROUP_ID, groupTitle: ARCHIVED_GROUP_TITLE };
    }),
    updates,
  };
}

export async function extractBoard(client: MondayClient, boardId: string, options: ExtractOptions = {}): Promise<BoardExtract> {
  const sink = options.sink;
  const rawBoard = await client.board(boardId);
  await sink?.save("board", String(rawBoard.id), rawBoard);

  const rawItems = await client.items(boardId, { since: options.since ?? null, ...(options.allLevels ? { allLevels: true } : {}) });
  for (let at = 0, n = 1; at < rawItems.length; at += client.pageSize, n++) await sink?.save("items_page", `${rawBoard.id}:${n}`, rawItems.slice(at, at + client.pageSize));

  const scope = options.scope;
  const carried = options.archived && options.since == null ? await readArchived(client, boardId, rawItems, sink) : null;
  const read = [...rawItems.map(normalizeItem), ...(carried?.items ?? [])];
  const items = scope ? read.filter((item) => keeps(scope, item)) : read;
  const kept = new Set(items.map((item) => item.id));
  const outOfScope = scope ? read.filter((item) => !kept.has(item.id)).map((item) => item.id) : null;
  let board = normalizeBoard(rawBoard);
  if (carried?.items.length) board = { ...board, groups: [...board.groups, { id: ARCHIVED_GROUP_ID, title: ARCHIVED_GROUP_TITLE, color: "", position: "", archived: false }] };
  const groups = scope?.filter?.groups;
  if (groups) board = { ...board, groups: board.groups.filter((g) => groups.includes(g.id)) };
  const unknownTags = unknownTagIds(board, items);
  if (unknownTags.length) {
    const names = await client.tagNames(unknownTags);
    board = withTags(board, names);
    await sink?.save("tags", String(rawBoard.id), [...names]);
  }

  const rawUpdates = await client.updates(boardId, { since: options.since ?? null });
  await sink?.save("updates", String(rawBoard.id), rawUpdates);
  const out = new Set(outOfScope);
  const onBoard = new Set(rawUpdates.map((update) => String(update.id)));
  const updates = flattenUpdates([...rawUpdates, ...(carried?.updates ?? []).filter((update) => !onBoard.has(String(update.id)))]).filter((update) => !out.has(update.itemId));

  const assetIds = new Set<string>(fileColumnAssetIds(items));
  for (const item of items) for (const [id] of item.assets ?? []) assetIds.add(id);
  for (const update of updates) for (const [id] of update.assets) assetIds.add(id);
  for (const item of items) for (const image of descriptionImagesOf(item)) assetIds.add(image.assetId);
  const metaRows = await client.assetMeta(assetIds);
  const assets: Record<string, AssetMeta> = {};
  for (const [id, row] of metaRows) assets[id] = { id, name: row.name ?? null, size: typeof row.file_size === "number" ? row.file_size : null };
  if (assetIds.size) await sink?.save("assets_meta", String(rawBoard.id), assets);

  const people = collectPeople(board, items);
  for (const item of items) {
    const creator = item.columnValues["__created_by"]?.text;
    if (creator && !people.users.includes(creator)) people.users.push(creator);
  }
  const userRows = await client.getUsers(people.users);
  const teamRows = await client.getTeams(people.teams);
  const users: Record<string, ExtractedUser> = {};
  for (const [id, u] of userRows) users[id] = { id, name: u.name ?? null, email: u.email ?? null, enabled: u.enabled ?? null, isPending: u.is_pending ?? null, isGuest: u.is_guest ?? null };
  withCreatorNames(items, users);
  const teams: Record<string, ExtractedTeam> = {};
  for (const [id, t] of teamRows) teams[id] = { id, name: t.name ?? null, users: (t.users ?? []).map((u) => ({ id: String(u.id), email: u.email ?? null })) };
  if (Object.keys(users).length) await sink?.save("users", String(rawBoard.id), users);
  if (Object.keys(teams).length) await sink?.save("teams", String(rawBoard.id), teams);

  return { board, items, updates, assets, users, teams, people, timeZone: await client.timeZone(), ...(options.since == null ? {} : { isDelta: true }), ...(outOfScope ? { outOfScope } : {}), ...(carried?.items.length ? { archivedCarried: carried.items.filter((i) => kept.has(i.id)).length } : {}) };
}
