import { randomUUID } from "node:crypto";
import { z } from "zod";
import { redactString, registerSecret } from "../redact";
import { fetchTransport, realClock, retryAfterSeconds, type Clock, type Transport } from "./http";

const PLAKY_BASE_URL = "https://api.plaky.com";
export const REQUESTS_PER_WINDOW = 190;
export const WINDOW_MS = 60_000;
export const MAX_429_REPLAYS = 5;
export const MAX_READ_RETRIES = 5;
const BACKOFF_BASE_MS = 250;
const BACKOFF_CAP_MS = 60_000;
const REQUEST_TIMEOUT_MS = 60_000;
const LANDING_MARGIN_MS = 60_000;
export const WRITE_LANDS_WITHIN_MS = REQUEST_TIMEOUT_MS + LANDING_MARGIN_MS;
export const uploadTimeoutMs = (bytes: number): number => REQUEST_TIMEOUT_MS + Math.ceil(bytes / (100 * 1024)) * 1000;
export const PAGE_CAP = 1000;
const MAX_RETRY_AFTER_S = 120;

export class PlakyError extends Error {
  override name = "PlakyError";
}
export type Refusal = { label: string | null; message: string | null; violations: { fieldName: string | null; message: string | null }[] };
export class PlakyHttpError extends PlakyError {
  override name = "PlakyHttpError";
  constructor(
    readonly status: number,
    message: string,
    readonly errorCode?: number,
    readonly refusal?: Refusal,
  ) {
    super(message);
  }
}
export function isPlakyNotFound(error: unknown): error is PlakyHttpError {
  return (error instanceof PlakyHttpError || (error instanceof Error && error.name === "PlakyHttpError")) && (error as PlakyHttpError).status === 404;
}
export class OutcomeUnknownError extends PlakyError {
  override name = "OutcomeUnknownError";
}
export class RateLimitedError extends PlakyError {
  override name = "RateLimitedError";
}
export const isOutcomeUnknown = (error: unknown): error is OutcomeUnknownError =>
  error instanceof OutcomeUnknownError || (error instanceof Error && error.name === "OutcomeUnknownError");
export const isRateLimited = (error: unknown): error is RateLimitedError =>
  error instanceof RateLimitedError || (error instanceof Error && error.name === "RateLimitedError");
export const isFeatureLimit = (error: unknown): boolean => isPlakyHttp(error) && error.errorCode === 4030601;
export const isPlakyHttp = (error: unknown): error is PlakyHttpError =>
  error instanceof PlakyHttpError || (error instanceof Error && error.name === "PlakyHttpError" && typeof (error as { status?: unknown }).status === "number");
export class PlakyDecodeError extends PlakyError {
  override name = "PlakyDecodeError";
}

export class Pacer {
  private stamps: number[] = [];
  constructor(
    private readonly clock: Clock,
    private readonly limit: number = REQUESTS_PER_WINDOW,
    private readonly windowMs: number = WINDOW_MS,
  ) {}

  async claim(): Promise<void> {
    for (;;) {
      const now = this.clock.now();
      this.stamps = this.stamps.filter((t) => now - t < this.windowMs);
      if (this.stamps.length < this.limit) {
        this.stamps.push(now);
        return;
      }
      await this.clock.sleep(this.windowMs - (now - this.stamps[0]!) + 1);
    }
  }
}

const id = z.number().int();
const str = z.string().nullish();

export const userSchema = z.looseObject({
  id,
  email: str,
  name: str,
  type: str,
  status: str,
  photoUrl: str,
  details: z.looseObject({}).nullish(),
});
const shortUserSchema = z.looseObject({ id, email: str, name: str, type: str });
export const teamSchema = z.looseObject({ id, title: str, allUsersTeam: z.boolean().nullish(), iconUrl: str, members: z.array(id).nullish() });
const teamShortSchema = z.looseObject({ id, title: str, allUsersTeam: z.boolean().nullish() });

const groupSchema = z.looseObject({ id, title: str, color: str, ranking: str });

const labelSchema = z.looseObject({ key: z.string(), title: z.string().nullish(), color: str, isFinal: z.boolean().nullish() });
const fieldDefinitionSchema = z.looseObject({
  id: id.nullish(),
  key: z.string(),
  name: str,
  type: z.string(),
  description: str,
  configuration: z.looseObject({ values: z.array(labelSchema).nullish() }).nullish(),
});
const boardSchema = z.looseObject({
  id,
  title: str,
  space: id.nullish(),
  kind: str,
  ranking: str,
  template: z.boolean().nullish(),
  fields: z.array(fieldDefinitionSchema).nullish(),
  groups: z.array(groupSchema).nullish(),
});
const spaceSchema = z.looseObject({
  id,
  title: str,
  kind: str,
  description: str,
  defaultSpace: z.boolean().nullish(),
  boards: z.array(boardSchema).nullish(),
});

const itemFieldSchema = z.looseObject({ key: z.string(), title: str, type: str, value: z.unknown() });
export const itemSchema = z.looseObject({
  id,
  title: str,
  board: id.nullish(),
  space: id.nullish(),
  group: id.nullish(),
  parent: id.nullish(),
  ranking: str,
  createdAt: str,
  createdBy: id.nullish(),
  archived: z.boolean().nullish(),
  deleted: z.boolean().nullish(),
  commentCount: z.number().int().nullish(),
  fileCount: z.number().int().nullish(),
  fields: z.array(itemFieldSchema).nullish(),
  subscribedUsers: z.array(id).nullish(),
  subscribedTeams: z.array(id).nullish(),
});

const activeCommentSchema: z.ZodType<PlakyActiveComment> = z.lazy(() =>
  z.looseObject({
    id,
    content: str,
    createdAt: str,
    createdBy: id.nullish(),
    updatedAt: str,
    deleted: z.boolean().nullish(),
    pinned: z.boolean().nullish(),
    reactions: z.array(z.looseObject({})).nullish(),
    replies: z.array(commentSchema).nullish(),
  }),
);
const deletedCommentSchema: z.ZodType<PlakyDeletedComment, unknown> = z.lazy(() =>
  z.looseObject({ id: z.null(), replies: z.array(commentSchema).nullish() }).transform((c) => ({ ...c, id: null, deleted: true as const, replies: c.replies ?? [] })),
);
const commentSchema: z.ZodType<PlakyComment, unknown> = z.lazy(() => z.union([activeCommentSchema, deletedCommentSchema]));
const fileSchema = z.looseObject({
  id,
  name: str,
  extension: str,
  size: z.union([z.number(), z.string()]).nullish(),
  fileType: str,
  description: str,
  createdAt: str,
  uploadedBy: id.nullish(),
});
export const subscriptionSchema = z.looseObject({ users: z.array(shortUserSchema).nullish(), teams: z.array(teamShortSchema).nullish() });

export type PlakyActiveComment = { id: number; content?: string | null | undefined; deleted?: boolean | null | undefined; replies?: PlakyComment[] | null | undefined; [k: string]: unknown };
export type PlakyDeletedComment = { id: null; deleted: true; replies: PlakyComment[]; [k: string]: unknown };
export type PlakyComment = PlakyActiveComment | PlakyDeletedComment;
export const isDeletedComment = (comment: PlakyComment): boolean => comment.id === null || comment.deleted === true;
export type PlakyUser = z.infer<typeof userSchema>;
export type PlakyTeam = z.infer<typeof teamSchema>;
type PlakyGroup = z.infer<typeof groupSchema>;
export type PlakyBoard = z.infer<typeof boardSchema>;
type PlakySpace = z.infer<typeof spaceSchema>;
export type PlakyItem = z.infer<typeof itemSchema>;
type PlakyFile = z.infer<typeof fileSchema>;

const pagedOf = <T extends z.ZodType>(row: T) => z.looseObject({ data: z.array(row), hasMore: z.boolean() });
type Page<T> = { data: T[]; hasMore: boolean };

export const createItemBody = z.strictObject({
  title: z.string().refine((title) => [...title].length <= 255, "a title holds at most 255 characters"),
  fields: z.record(z.string(), z.unknown()).optional(),
  groupId: id.optional(),
  groupTitle: z.string().optional(),
  parentId: id.optional(),
  subscribedUserIds: z.array(id).optional(),
  subscribedTeamIds: z.array(id).optional(),
});
const createGroupBody = z.strictObject({ title: z.string(), color: z.string(), ranking: z.string().optional() });
export const updateGroupBody = z.strictObject({ title: z.string(), ranking: z.string(), color: z.string() });
export const commentBody = z.strictObject({ text: z.string(), repliesToId: id.optional() });
const moveItemBody = z.strictObject({ itemGroupId: id });
export const subscriptionBody = z.strictObject({ userIds: z.array(id).optional(), teamIds: z.array(id).optional() });

export type CreateItemBody = z.input<typeof createItemBody>;
type GroupBody = z.input<typeof createGroupBody>;

type Query = Record<string, string | number | boolean | readonly (string | number)[] | undefined>;
type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
type Ids = number | string;
export type BeforeSend = () => Promise<void>;

type PlakyClientOptions = {
  apiKey: string;
  baseUrl?: string;
  transport?: Transport;
  clock?: Clock;
  userAgent?: string;
  observe?: (event: { at: number; method: Method; path: string; status: number | "error" }) => void;
};

type PageOptions = { page?: number; pageSize?: number; expand?: readonly string[] };

export class PlakyClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly transport: Transport;
  private readonly clock: Clock;
  private readonly pacer: Pacer;
  private readonly userAgent: string;
  private readonly observe: PlakyClientOptions["observe"];
  requests = 0;

  constructor(options: PlakyClientOptions) {
    if (!options.apiKey.trim()) throw new Error("PlakyClient: apiKey is required");
    this.apiKey = options.apiKey;
    registerSecret(options.apiKey);
    this.baseUrl = options.baseUrl ?? PLAKY_BASE_URL;
    this.transport = options.transport ?? fetchTransport;
    this.clock = options.clock ?? realClock;
    this.pacer = new Pacer(this.clock);
    this.userAgent = options.userAgent ?? "monday-to-plaky-migrator/1.0";
    this.observe = options.observe;
  }

  static fromEnv(overrides: Partial<PlakyClientOptions> = {}): PlakyClient {
    const apiKey = (process.env.PLAKY_API_KEY ?? "").trim();
    if (!apiKey) throw new Error("PLAKY_API_KEY is not set");
    return new PlakyClient({ apiKey, ...overrides });
  }

  private async send<S extends z.ZodType>(
    method: Method,
    path: string,
    schema: S,
    opts: { query?: Query; body?: unknown; form?: FormData; idempotencyKey?: string; timeoutMs?: number; beforeSend?: BeforeSend } = {},
  ): Promise<z.infer<S>> {
    const url = new URL(path, this.baseUrl);
    for (const [key, value] of Object.entries(opts.query ?? {})) {
      if (value === undefined) continue;
      if (Array.isArray(value)) for (const entry of value) url.searchParams.append(key, String(entry));
      else url.searchParams.set(key, String(value));
    }
    const write = method !== "GET";
    const headers: Record<string, string> = { "x-api-key": this.apiKey, accept: "application/json", "user-agent": this.userAgent };
    if (opts.body !== undefined) headers["content-type"] = "application/json";
    if (write) headers["idempotency-key"] = opts.idempotencyKey ?? randomUUID();
    const body = opts.form ?? (opts.body === undefined ? null : JSON.stringify(opts.body));
    const label = `${method} ${url.pathname}`;

    let attempt = 0;
    const retryRead = async (response: Response | null): Promise<boolean> => {
      if (write || attempt >= MAX_READ_RETRIES) return false;
      const after = response ? retryAfterSeconds(response) : null;
      const capped = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** attempt);
      await this.clock.sleep(after !== null ? Math.min(Math.max(after * 1000, 0), BACKOFF_CAP_MS) : capped / 2 + Math.random() * (capped / 2));
      return true;
    };

    for (; ; attempt++) {
      await this.pacer.claim();
      await opts.beforeSend?.();
      this.requests++;
      const at = this.clock.now();
      let response: Response;
      try {
        response = await this.transport(url, { method, headers, body, signal: AbortSignal.timeout(opts.timeoutMs ?? REQUEST_TIMEOUT_MS) });
      } catch (error) {
        this.observe?.({ at, method, path: url.pathname, status: "error" });
        const name = (error as Error).name;
        const reason = redactString(`${label}: ${name}${name === "TimeoutError" && opts.timeoutMs !== undefined ? ` after ${Math.round(opts.timeoutMs / 1000)} s` : ""}`);
        if (write) throw new OutcomeUnknownError(reason);
        if (await retryRead(null)) continue;
        throw new PlakyError(reason);
      }
      this.observe?.({ at, method, path: url.pathname, status: response.status });

      if (response.status === 429) {
        if (attempt >= MAX_429_REPLAYS) throw new RateLimitedError(`${label}: 429 after ${attempt} retries`);
        const wait = Math.min(Math.max(retryAfterSeconds(response) ?? 60, 1), MAX_RETRY_AFTER_S);
        void response.body?.cancel().catch(() => undefined);
        await this.clock.sleep(wait * 1000);
        continue;
      }

      let text: string;
      try {
        text = await response.text();
      } catch {
        if (write) throw new OutcomeUnknownError(`${label}: answer body unreadable (HTTP ${response.status})`);
        if (await retryRead(null)) continue;
        throw new PlakyError(`${label}: answer body unreadable`);
      }
      if (response.status >= 500) {
        const reason = `${label}: HTTP ${response.status}`;
        if (write) throw new OutcomeUnknownError(reason);
        if (await retryRead(response)) continue;
        throw new PlakyHttpError(response.status, reason);
      }
      if (!response.ok) throw new PlakyHttpError(response.status, `${redactString(label)}: HTTP ${response.status} ${redactString(text).slice(0, 300)}`, errorCodeOf(text), refusalOf(text));

      let json: unknown = null;
      if (text.trim()) {
        try {
          json = JSON.parse(text);
        } catch {
          const reason = `${label}: undecodable answer`;
          throw write ? new OutcomeUnknownError(reason) : new PlakyDecodeError(reason);
        }
      }
      const parsed = schema.safeParse(json);
      if (!parsed.success) {
        const reason = `${label}: answer does not match the schema (${parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")})`;
        throw write ? new OutcomeUnknownError(reason) : new PlakyDecodeError(reason);
      }
      return parsed.data;
    }
  }

  private get<S extends z.ZodType>(path: string, schema: S, query?: Query): Promise<z.infer<S>> {
    return this.send("GET", path, schema, query ? { query } : {});
  }
  private write<S extends z.ZodType>(method: Exclude<Method, "GET">, path: string, schema: S, body: unknown, idempotencyKey?: string, beforeSend?: BeforeSend): Promise<z.infer<S>> {
    return this.send(method, path, schema, { ...(body === undefined ? {} : { body }), ...(idempotencyKey ? { idempotencyKey } : {}), ...(beforeSend ? { beforeSend } : {}) });
  }

  private async page<S extends z.ZodType>(path: string, row: S, query: Query = {}): Promise<Page<z.infer<S>>> {
    const result = await this.get(path, pagedOf(row), query);
    if (result.data.length === 0 && result.hasMore) throw new PlakyDecodeError(`GET ${path}: empty page with hasMore`);
    return { data: result.data, hasMore: result.hasMore };
  }

  async collect<T>(fetchPage: (page: number) => Promise<Page<T>>): Promise<T[]> {
    const out: T[] = [];
    for (let page = 1; ; page++) {
      if (page > PAGE_CAP) throw new PlakyDecodeError(`paging exceeded ${PAGE_CAP} pages`);
      const got = await fetchPage(page);
      out.push(...got.data);
      if (!got.hasMore) return out;
    }
  }

  private S = (space: Ids) => `/v1/public/spaces/${seg(space)}`;
  private B = (space: Ids, board: Ids) => `${this.S(space)}/boards/${seg(board)}`;
  private I = (space: Ids, board: Ids, item: Ids) => `${this.B(space, board)}/items/${seg(item)}`;

  getCurrentUser(): Promise<PlakyUser> {
    return this.get("/v1/public/users/me", userSchema);
  }
  listUsers(o: PageOptions & { emails?: readonly string[]; status?: string; type?: string } = {}): Promise<Page<PlakyUser>> {
    return this.page("/v1/public/users", userSchema, { page: o.page, pageSize: o.pageSize, emails: o.emails, status: o.status, type: o.type });
  }
  listTeams(o: PageOptions = {}): Promise<Page<PlakyTeam>> {
    return this.page("/v1/public/teams", teamSchema, { page: o.page, pageSize: o.pageSize });
  }
  listSpaces(o: PageOptions = {}): Promise<Page<PlakySpace>> {
    return this.page("/v1/public/spaces", spaceSchema, { page: o.page, pageSize: o.pageSize, expand: o.expand });
  }

  listBoards(space: Ids, o: PageOptions = {}): Promise<Page<PlakyBoard>> {
    return this.page(`${this.S(space)}/boards`, boardSchema, { page: o.page, pageSize: o.pageSize });
  }
  getBoard(space: Ids, board: Ids): Promise<PlakyBoard> {
    return this.get(this.B(space, board), boardSchema);
  }

  listItems(space: Ids, board: Ids, o: PageOptions & { boardViewId?: Ids; parentId?: Ids; subitemsBehaviour?: "EXCLUDE" | "INCLUDE" } = {}): Promise<Page<PlakyItem>> {
    return this.page(`${this.B(space, board)}/items`, itemSchema, {
      page: o.page,
      pageSize: o.pageSize ?? 1000,
      expand: o.expand,
      boardViewId: o.boardViewId,
      parentId: o.parentId,
      subitemsBehaviour: o.subitemsBehaviour ?? "EXCLUDE",
    });
  }
  createItem(space: Ids, board: Ids, body: CreateItemBody, idempotencyKey?: string, beforeSend?: BeforeSend): Promise<PlakyItem> {
    return this.write("POST", `${this.B(space, board)}/items`, itemSchema, createItemBody.parse(body), idempotencyKey, beforeSend);
  }
  updateItemFields(space: Ids, board: Ids, item: Ids, fields: Record<string, unknown>, idempotencyKey?: string): Promise<PlakyItem> {
    return this.write("PATCH", `${this.I(space, board, item)}/fields`, itemSchema, fields, idempotencyKey);
  }
  async moveItem(space: Ids, board: Ids, item: Ids, groupId: number): Promise<void> {
    await this.write("PATCH", `${this.I(space, board, item)}/group`, z.unknown(), moveItemBody.parse({ itemGroupId: groupId }));
  }
  async deleteItem(space: Ids, board: Ids, item: Ids, o: { subitemsBehaviour?: "EXCLUDE" | "INCLUDE"; beforeSend?: BeforeSend } = {}, idempotencyKey?: string): Promise<void> {
    const path = `${this.I(space, board, item)}`;
    await this.send("DELETE", path, z.unknown(), { query: { subitemsBehaviour: o.subitemsBehaviour }, ...(idempotencyKey ? { idempotencyKey } : {}), ...(o.beforeSend ? { beforeSend: o.beforeSend } : {}) });
  }

  listItemGroups(space: Ids, board: Ids, o: PageOptions = {}): Promise<Page<PlakyGroup>> {
    return this.page(`${this.B(space, board)}/item-groups`, groupSchema, { page: o.page, pageSize: o.pageSize });
  }
  createItemGroup(space: Ids, board: Ids, body: GroupBody, idempotencyKey?: string): Promise<PlakyGroup> {
    return this.write("POST", `${this.B(space, board)}/item-groups`, groupSchema, createGroupBody.parse(body), idempotencyKey);
  }
  updateItemGroup(space: Ids, board: Ids, group: Ids, body: z.input<typeof updateGroupBody>, idempotencyKey?: string): Promise<PlakyGroup> {
    return this.write("PUT", `${this.B(space, board)}/item-groups/${seg(group)}`, groupSchema, updateGroupBody.parse(body), idempotencyKey);
  }
  async deleteItemGroup(space: Ids, board: Ids, group: Ids, idempotencyKey?: string): Promise<void> {
    await this.write("DELETE", `${this.B(space, board)}/item-groups/${seg(group)}`, z.unknown(), undefined, idempotencyKey);
  }

  listItemComments(space: Ids, board: Ids, item: Ids): Promise<PlakyComment[]> {
    return this.get(`${this.I(space, board, item)}/comments`, z.array(commentSchema));
  }
  createItemComment(space: Ids, board: Ids, item: Ids, body: z.input<typeof commentBody>, idempotencyKey?: string): Promise<PlakyActiveComment> {
    return this.write("POST", `${this.I(space, board, item)}/comments`, activeCommentSchema, commentBody.parse(body), idempotencyKey);
  }
  updateItemComment(space: Ids, board: Ids, item: Ids, comment: Ids, text: string, idempotencyKey?: string): Promise<PlakyActiveComment> {
    return this.write("PUT", `${this.I(space, board, item)}/comments/${seg(comment)}`, activeCommentSchema, { text }, idempotencyKey);
  }

  getSubscriptions(space: Ids, board: Ids, item: Ids): Promise<z.infer<typeof subscriptionSchema>> {
    return this.get(`${this.I(space, board, item)}/subscriptions`, subscriptionSchema);
  }
  async overrideSubscriptions(space: Ids, board: Ids, item: Ids, body: z.input<typeof subscriptionBody>, idempotencyKey?: string): Promise<void> {
    await this.write("PUT", `${this.I(space, board, item)}/subscriptions`, z.unknown(), subscriptionBody.parse(body), idempotencyKey);
  }

  uploadItemFile(space: Ids, board: Ids, item: Ids, file: { name: string; data: Uint8Array; type?: string }, idempotencyKey?: string): Promise<PlakyFile> {
    const form = new FormData();
    form.set("file", new Blob([file.data as BlobPart], { type: file.type ?? "application/octet-stream" }), file.name);
    return this.send("POST", `${this.I(space, board, item)}/files`, fileSchema, { form, timeoutMs: uploadTimeoutMs(file.data.byteLength), ...(idempotencyKey ? { idempotencyKey } : {}) });
  }
  listItemFiles(space: Ids, board: Ids, item: Ids): Promise<PlakyFile[]> {
    return this.get(`${this.I(space, board, item)}/files`, z.array(fileSchema));
  }

  allUsers(o: { status?: string; type?: string; emails?: readonly string[] } = {}): Promise<PlakyUser[]> {
    return this.collect((page) => this.listUsers({ ...o, page, pageSize: 100 }));
  }
  allTeams(): Promise<PlakyTeam[]> {
    return this.collect((page) => this.listTeams({ page, pageSize: 100 }));
  }
  allSpaces(): Promise<PlakySpace[]> {
    return this.collect((page) => this.listSpaces({ page, pageSize: 100 }));
  }
  allBoards(space: Ids): Promise<PlakyBoard[]> {
    return this.collect((page) => this.listBoards(space, { page, pageSize: 100 }));
  }
  allItems(space: Ids, board: Ids, subitemsBehaviour: "EXCLUDE" | "INCLUDE" = "EXCLUDE"): Promise<PlakyItem[]> {
    return this.collect((page) => this.listItems(space, board, { page, pageSize: 1000, subitemsBehaviour }));
  }
  allItemGroups(space: Ids, board: Ids): Promise<PlakyGroup[]> {
    return this.collect((page) => this.listItemGroups(space, board, { page, pageSize: 100 }));
  }
}

function seg(value: Ids): string {
  return encodeURIComponent(String(value));
}

function refusalOf(text: string): Refusal | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  const record = (value: unknown): Record<string, unknown> | null => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null);
  const stringOf = (value: unknown): string | null => (typeof value === "string" && value ? value : null);
  const body = record(parsed);
  if (body === null) return undefined;
  const said = (value: unknown): string | null => {
    const found = stringOf(value);
    return found === null ? null : redactString(found);
  };
  const violations = (Array.isArray(body["violations"]) ? body["violations"] : []).flatMap((v: unknown) => {
    const entry = record(v);
    return entry === null ? [] : [{ fieldName: stringOf(entry["fieldName"]), message: said(entry["message"]) }];
  });
  return { label: stringOf(body["errorLabel"]) ?? stringOf(body["code"]), message: said(body["message"]), violations };
}

function errorCodeOf(text: string): number | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object" && "errorCode" in parsed && typeof parsed.errorCode === "number") return parsed.errorCode;
  } catch {
  }
  return undefined;
}
