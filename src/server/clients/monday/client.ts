import { z } from "zod";
import { redactString, registerSecret } from "../../redact";
import { fetchTransport, realClock, retryAfterSeconds, type Clock, type Transport } from "../http";
import { ASSET_BATCH, BOARD_BATCH, DESCRIPTION_FETCH_PAGE, DESCRIPTION_PAGE, DESCRIPTION_PAGE_CAP, GATEWAY_FLOOR_RETRIES, GATEWAY_REFUSAL_WAIT_MS, MONDAY_API_URL, MONDAY_API_VERSION, MONDAY_DEFAULT_PAGE_SIZE, MONDAY_MAX_PAGE_SIZE, MONDAY_MIN_PAGE_SIZE, MondayDailyLimitError, MondayError, MondayGatewayRefusedError, MondayGraphQLError, MondayStoppedError, REQUEST_TIMEOUT_MS, RETRY_CODES, RETRY_STATUSES, TAG_BATCH, TEAM_BATCH, UPDATES_PAGE, USER_BATCH } from "./errors";
import { backoffSeconds, errorCodes, labelIdsIn, peopleIn, retryHint, tagIdsIn } from "./normalize";
import { ACTIVE_ITEMS_QUERY, ACTIVITY_LOG_QUERY, ARCHIVED_ITEM_UPDATES_QUERY, ARCHIVED_ITEMS_QUERY, ASSET_META_QUERY, ASSETS_QUERY, AUTOMATIONS_QUERY, BOARD_QUERY, CATALOG_QUERY, DASHBOARDS_QUERY, DESCRIPTION_QUERY, ITEM_SELECTION, ITEM_STATES_QUERY, itemPageQueries, legacyTitles, LIST_BOARDS_QUERY, TAGS_QUERY, TEAMS_QUERY, UPDATES_QUERY, USERS_QUERY } from "./queries";
import { assetMetaRow, assetRow, blockSchema, catalogRow, type CatalogRow, envelope, idish, listBoardRow, nullableRow, nullishStr, type RawAsset, type RawAssetMeta, type RawBoard, rawBoardSchema, type RawItem, rawItemSchema, type RawTeam, type RawUpdate, rawUpdateSchema, type RawUser, tagRow, teamRow, userRow } from "./schemas";

type MondayClientOptions = {
  token: string;
  transport?: Transport;
  clock?: Clock;
  random?: () => number;
  maxRetries?: number;
  pageSize?: number;
  onCall?: () => void;
};

type GqlOptions = { onGatewayRefusal?: "retry" | "throw" };

type ItemPageOptions = { columns?: string[]; rules?: Record<string, unknown> | null; allLevels?: boolean };

export class MondayClient {
  private readonly token: string;
  private readonly transport: Transport;
  private readonly clock: Clock;
  private readonly random: () => number;
  private readonly maxRetries: number;
  private readonly onCall: (() => void) | undefined;
  pageSize: number;
  calls = 0;
  gatewayRefusals = 0;
  dailyLimited = false;

  private readonly titles = new Map<string, Map<string, string>>();
  private readonly levels = new Map<string, Promise<Map<string, number>>>();
  private readonly updatesCache = new Map<string, RawUpdate[]>();
  private readonly tags = new Map<string, z.infer<typeof tagRow> | null>();
  private readonly users = new Map<string, RawUser | null>();
  private readonly teams = new Map<string, RawTeam | null>();
  private readonly assetMetas = new Map<string, RawAssetMeta | null>();
  private zone: string | null = null;

  constructor(options: MondayClientOptions) {
    if (!options.token.trim()) throw new Error("MondayClient: token is required");
    this.token = options.token;
    registerSecret(options.token);
    this.transport = options.transport ?? fetchTransport;
    this.clock = options.clock ?? realClock;
    this.random = options.random ?? Math.random;
    this.maxRetries = Math.max(0, options.maxRetries ?? 5);
    this.onCall = options.onCall;
    this.pageSize = Math.min(Math.max(options.pageSize ?? MONDAY_DEFAULT_PAGE_SIZE, MONDAY_MIN_PAGE_SIZE), MONDAY_MAX_PAGE_SIZE);
  }

  static fromEnv(overrides: Partial<MondayClientOptions> = {}): MondayClient {
    const token = (process.env.MONDAY_API_TOKEN ?? "").trim();
    if (!token) throw new Error("MONDAY_API_TOKEN is not set");
    return new MondayClient({ token, ...overrides });
  }

  stopOn(signal: AbortSignal): void {
    this.stop = signal;
  }
  private stop: AbortSignal | null = null;

  async gql(query: string, variables: Record<string, unknown> = {}, options: GqlOptions = {}): Promise<Record<string, unknown>> {
    const body = JSON.stringify({ query, variables });
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (this.stop?.aborted) throw new MondayStoppedError("monday.com read stopped on request");
      let response: Response;
      let text: string;
      this.calls++;
      this.onCall?.();
      try {
        response = await this.transport(new URL(MONDAY_API_URL), {
          method: "POST",
          headers: { Authorization: this.token, "Content-Type": "application/json", "API-Version": MONDAY_API_VERSION },
          body,
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        text = await response.text();
      } catch (error) {
        if (attempt < this.maxRetries) {
          await this.clock.sleep(backoffSeconds(attempt, null, this.random) * 1000);
          continue;
        }
        throw new MondayError(redactString(`monday.com transport error: ${(error as Error).name}`));
      }

      let payload: unknown;
      let jsonBody = false;
      try {
        payload = JSON.parse(text);
        jsonBody = true;
      } catch {
      }
      const parsed = envelope.safeParse(payload);
      const errors = parsed.success ? parsed.data.errors : undefined;
      const codes = errorCodes(errors);
      if (codes.has("DAILY_LIMIT_EXCEEDED")) {
        this.dailyLimited = true;
        throw new MondayDailyLimitError(
          "monday.com's daily API call limit is used up. It resets at 00:00 UTC: press Move again after that. " +
            "Everything already written to Plaky is kept, and the Monday ID index makes the next run pick up where this one stopped.",
        );
      }
      const hints = [retryAfterSeconds(response), retryHint(errors)].filter((hint): hint is number => hint !== null && Number.isFinite(hint));
      const retryDelay = hints.length ? Math.max(...hints) : null;

      if (RETRY_STATUSES.has(response.status)) {
        if (response.status === 429 && !jsonBody) {
          if (options.onGatewayRefusal === "throw") throw new MondayGatewayRefusedError("monday.com refused the query as too large (HTTP 429, non-JSON body)");
          if (attempt < this.maxRetries) {
            await this.clock.sleep(Math.max(GATEWAY_REFUSAL_WAIT_MS, backoffSeconds(attempt, retryDelay, this.random) * 1000));
            continue;
          }
        } else if (attempt < this.maxRetries) {
          await this.clock.sleep(backoffSeconds(attempt, retryDelay, this.random) * 1000);
          continue;
        }
      }
      if (response.status >= 400) throw new MondayError(`monday.com HTTP ${response.status}: ${redactString(text).slice(0, 500)}`);

      if (!jsonBody) throw new MondayError(`monday.com returned non-JSON (${response.status}): ${redactString(text).slice(0, 300)}`);
      if (!parsed.success) throw new MondayError(`monday.com returned unexpected JSON: ${redactString(text).slice(0, 300)}`);

      if (Array.isArray(errors) ? errors.length > 0 : Boolean(errors)) {
        if ([...codes].some((c) => RETRY_CODES.has(c)) && attempt < this.maxRetries) {
          await this.clock.sleep(backoffSeconds(attempt, retryDelay, this.random) * 1000);
          continue;
        }
        const message = `monday.com GraphQL error: ${redactString(JSON.stringify(errors)).slice(0, 500)}`;
        throw [...codes].some((c) => RETRY_CODES.has(c)) ? new MondayError(message) : new MondayGraphQLError(message);
      }
      const data = parsed.data.data;
      if (!data || typeof data !== "object" || Array.isArray(data)) throw new MondayError(`monday.com returned no data: ${redactString(text).slice(0, 500)}`);
      return data as Record<string, unknown>;
    }
    throw new MondayError("monday.com: retries exhausted");
  }

  private async read<S extends z.ZodType>(schema: S, query: string, variables: Record<string, unknown> = {}, options: GqlOptions = {}): Promise<z.infer<S>> {
    const data = await this.gql(query, variables, options);
    const parsed = schema.safeParse(data);
    if (!parsed.success) throw new MondayError(`monday.com answer does not match the schema: ${parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
    return parsed.data;
  }

  async timeZone(): Promise<string | null> {
    if (this.zone === null) {
      const data = await this.read(z.looseObject({ me: z.looseObject({ time_zone_identifier: nullishStr }).nullish() }), "query { me { time_zone_identifier } }");
      this.zone = data.me?.time_zone_identifier ?? "";
    }
    return this.zone || null;
  }

  async me(): Promise<{ name: string | null; email: string | null; account: string | null; slug: string | null; tier: string | null; accountId?: string; userId?: string }> {
    const data = await this.read(
      z.looseObject({ me: z.looseObject({ id: idish.nullish(), name: nullishStr, email: nullishStr, account: z.looseObject({ name: nullishStr, slug: nullishStr, tier: nullishStr, plan: z.looseObject({ tier: nullishStr }).nullish() }).nullish(), accountRef: z.looseObject({ id: idish.nullish() }).nullish() }) }),
      "query { me { id name email account { name slug tier plan { tier } } accountRef: account { id } } }",
    );
    const accountId = data.me.accountRef?.id;
    const userId = data.me.id;
    return {
      name: data.me.name ?? null, email: data.me.email ?? null, account: data.me.account?.name ?? null, slug: data.me.account?.slug ?? null, tier: data.me.account?.tier ?? data.me.account?.plan?.tier ?? null,
      ...(accountId === null || accountId === undefined ? {} : { accountId: String(accountId) }), ...(userId === null || userId === undefined ? {} : { userId: String(userId) }),
    };
  }

  async listBoards(): Promise<z.infer<typeof listBoardRow>[]> {
    const out: z.infer<typeof listBoardRow>[] = [];
    const seen = new Set<string>();
    for (let page = 1; ; page++) {
      const batch = (await this.read(z.looseObject({ boards: z.array(listBoardRow) }), LIST_BOARDS_QUERY, { limit: 100, page })).boards;
      for (const entry of batch) {
        const key = String(entry.id);
        if (seen.has(key)) throw new MondayError(`monday.com board pagination repeated board ${key}; refusing to continue with an ambiguous account listing`);
        seen.add(key);
      }
      out.push(...batch.filter((entry) => entry.state !== "deleted"));
      if (batch.length < 100) return out;
    }
  }

  async listBoardsWithPlaces(): Promise<{ boards: CatalogRow[]; folders: Map<string, string> }> {
    const boards: CatalogRow[] = [];
    const folders = new Map<string, string>();
    const seen = new Set<string>();
    const schema = z.looseObject({ boards: z.array(catalogRow), folders: z.array(z.looseObject({ id: idish, name: nullishStr })).nullish() });
    for (let page = 1; ; page++) {
      const data = await this.read(schema, CATALOG_QUERY, { limit: 100, page });
      for (const entry of data.boards) {
        const key = String(entry.id);
        if (seen.has(key)) throw new MondayError(`monday.com board pagination repeated board ${key}; refusing to continue with an ambiguous account listing`);
        seen.add(key);
      }
      boards.push(...data.boards.filter((entry) => entry.state !== "deleted"));
      const foldersBefore = folders.size;
      for (const f of data.folders ?? []) folders.set(String(f.id), f.name ?? String(f.id));
      if (data.boards.length < 100 && (data.folders ?? []).length < 100) return { boards, folders };
      if (!data.boards.length && folders.size === foldersBefore) return { boards, folders };
    }
  }

  async boardAutomations(boardId: string): Promise<{ title: string; active: boolean | null; legacy: boolean }[]> {
    const schema = z.looseObject({ board_automations: z.looseObject({ cursor: nullishStr, items: z.array(z.looseObject({ title: nullishStr, active: z.boolean().nullish() })).nullish(), legacy_automations: z.unknown().optional() }) });
    const out: { title: string; active: boolean | null; legacy: boolean }[] = [];
    let cursor: string | null = null;
    const cursors = new Set<string>();
    for (;;) {
      const page: z.infer<typeof schema> = await this.read(schema, AUTOMATIONS_QUERY, { board: [boardId], cursor });
      const found = page.board_automations;
      for (const a of found.items ?? []) out.push({ title: a.title || "an automation", active: a.active ?? null, legacy: false });
      if (cursor === null) for (const title of legacyTitles(found.legacy_automations)) out.push({ title, active: null, legacy: true });
      if (!found.cursor) return out;
      if (cursors.has(found.cursor)) throw new MondayError(`monday.com automation pagination repeated a cursor on board ${boardId}; refusing to continue`);
      cursors.add(found.cursor);
      cursor = found.cursor;
    }
  }

  async docsByObjectIds(objectIds: readonly string[]): Promise<Map<string, { id: string; name: string }>> {
    const out = new Map<string, { id: string; name: string }>();
    const schema = z.looseObject({ docs: z.array(z.looseObject({ id: idish, name: nullishStr, object_id: idish }).nullable()).nullish() });
    for (const objectId of new Set(objectIds)) {
      const data = await this.read(schema, "query($ids: [ID!], $limit: Int) { docs(object_ids: $ids, limit: $limit) { id name object_id } }", { ids: [objectId], limit: 1 });
      for (const doc of data.docs ?? []) if (doc) out.set(String(doc.object_id), { id: String(doc.id), name: doc.name ?? "" });
    }
    return out;
  }

  async exportDocMarkdown(docId: string): Promise<string | null> {
    const schema = z.looseObject({ export_markdown_from_doc: z.looseObject({ success: z.boolean().nullish(), markdown: nullishStr }).nullish() });
    const data = await this.read(schema, "query($id: ID!) { export_markdown_from_doc(docId: $id) { success markdown error } }", { id: docId });
    const r = data.export_markdown_from_doc;
    return r?.success && typeof r.markdown === "string" ? r.markdown : null;
  }

  async docBlockCount(docId: string): Promise<number | null> {
    const schema = z.looseObject({ docs: z.array(z.looseObject({ blocks: z.array(z.unknown()).nullish() }).nullable()).nullish() });
    const data = await this.read(schema, "query($id: [ID!]) { docs(ids: $id) { id blocks { id } } }", { id: [docId] });
    return data.docs?.[0]?.blocks?.length ?? null;
  }

  async searchDashboards(): Promise<{ id: string; name: string }[]> {
    const schema = z.looseObject({ search: z.looseObject({ overviews: z.looseObject({ results: z.array(z.looseObject({ id: idish, live_data: z.looseObject({ name: nullishStr }).nullish() })) }) }) });
    const data = await this.read(schema, DASHBOARDS_QUERY, {});
    return data.search.overviews.results.map((r) => ({ id: String(r.id), name: r.live_data?.name || String(r.id) }));
  }

  async boards(boardIds: string[]): Promise<RawBoard[]> {
    const out: RawBoard[] = [];
    for (let at = 0; at < boardIds.length; at += BOARD_BATCH) {
      const data = await this.read(z.looseObject({ boards: z.array(rawBoardSchema) }), BOARD_QUERY, { ids: boardIds.slice(at, at + BOARD_BATCH) });
      out.push(...data.boards);
    }
    return out;
  }

  async oldestPersonField(boardId: string, columnIds: readonly string[]): Promise<string | null> {
    const schema = z.looseObject({ boards: z.array(z.looseObject({ activity_logs: z.array(z.looseObject({ event: nullishStr, data: nullishStr, created_at: nullishStr })).nullish() })) });
    const dates = new Map<string, bigint>();
    let previous = "";
    for (let page = 1; page <= 20; page++) {
      const logs = (await this.read(schema, `query($ids:[ID!],$cols:[String!],$page:Int!){ boards(ids:$ids){ activity_logs(column_ids:$cols,limit:500,page:$page){event data created_at} } }`, { ids: [boardId], cols: columnIds, page })).boards[0]?.activity_logs ?? [];
      const signature = JSON.stringify(logs);
      if (signature === previous) break;
      previous = signature;
      for (const log of logs) {
        if (log.event !== "create_column" || !log.data || !log.created_at || !/^\d+$/.test(log.created_at)) continue;
        let id: unknown;
        try { id = (JSON.parse(log.data) as { column_id?: unknown }).column_id; } catch { continue; }
        if (typeof id === "string" && columnIds.includes(id)) {
          const date = BigInt(log.created_at);
          if (!dates.has(id) || date < dates.get(id)!) dates.set(id, date);
        }
      }
      if (dates.size === columnIds.length || logs.length < 500) break;
    }
    if (dates.size !== columnIds.length) return null;
    return [...dates].sort(([a, x], [b, y]) => x < y ? -1 : x > y ? 1 : a.localeCompare(b))[0]?.[0] ?? null;
  }

  async board(boardId: string): Promise<RawBoard> {
    const [board] = await this.boards([String(boardId)]);
    if (!board) throw new MondayError(`monday.com board ${boardId} not found or not accessible`);
    return board;
  }

  private async adaptive<T>(fetchPage: (limit: number) => Promise<T>): Promise<T> {
    let atFloor = 0;
    for (;;) {
      try {
        return await fetchPage(this.pageSize);
      } catch (error) {
        if (!(error instanceof MondayGatewayRefusedError)) throw error;
        if (this.pageSize <= MONDAY_MIN_PAGE_SIZE && atFloor++ >= GATEWAY_FLOOR_RETRIES) throw error;
        this.gatewayRefusals++;
        await this.clock.sleep(GATEWAY_REFUSAL_WAIT_MS);
        this.pageSize = Math.max(MONDAY_MIN_PAGE_SIZE, Math.floor(this.pageSize / 2));
      }
    }
  }

  async *itemPages<S extends z.ZodType>(boardId: string, selection: string, rowSchema: S, o: ItemPageOptions = {}): AsyncGenerator<z.infer<S>[]> {
    const queries = itemPageQueries(selection, { columns: Boolean(o.columns?.length), rules: Boolean(o.rules), allLevels: Boolean(o.allLevels) });
    const shared = o.columns?.length ? { cols: o.columns } : {};
    const pageOf = z.looseObject({ cursor: nullishStr, items: z.array(rowSchema) });
    const first = await this.adaptive(async (limit) =>
      this.read(z.looseObject({ boards: z.array(z.looseObject({ items_page: pageOf })) }), queries.first, { ids: [String(boardId)], limit, ...shared, ...(o.rules ? { rules: o.rules } : {}) }, { onGatewayRefusal: "throw" }),
    );
    const board = first.boards[0];
    if (!board) throw new MondayError(`monday.com board ${boardId} not found or not accessible`);
    let page = board.items_page;
    const seen = new Set<string>();
    for (;;) {
      yield page.items;
      const cursor = page.cursor;
      if (!cursor) return;
      if (seen.has(cursor)) throw new MondayError("monday.com item pagination repeated a cursor; refusing to loop forever");
      seen.add(cursor);
      const next = await this.adaptive(async (limit) =>
        this.read(z.looseObject({ next_items_page: pageOf }), queries.next, { cursor, limit, ...shared }, { onGatewayRefusal: "throw" }),
      );
      page = next.next_items_page;
    }
  }

  async items(boardId: string, o: { since?: string | null; allLevels?: boolean } = {}): Promise<RawItem[]> {
    const rules = o.since ? { rules: [{ column_id: "__last_updated__", compare_value: [o.since], operator: "greater_than" }] } : null;
    const seen = new Set<string>();
    const raw: RawItem[] = [];
    for await (const page of this.itemPages(boardId, ITEM_SELECTION, rawItemSchema, { rules, allLevels: Boolean(o.allLevels) })) {
      for (const item of page) {
        const key = String(item.id);
        if (seen.has(key)) throw new MondayError(`monday.com item pagination repeated item ${key}; refusing to continue with an ambiguous board read`);
        seen.add(key);
        raw.push(item);
      }
    }
    const cut = raw.filter((item) => (item.description?.blocks?.length ?? 0) >= DESCRIPTION_PAGE).map((item) => String(item.id));
    const whole = await this.descriptions(cut);
    const items = raw.map((item) => (whole.has(String(item.id)) ? { ...item, description: { blocks: whole.get(String(item.id))! } } : item));
    if (!o.since && !o.allLevels) this.titles.set(String(boardId), new Map(items.map((item) => [String(item.id), item.name])));
    return items;
  }

  async descriptions(itemIds: string[]): Promise<Map<string, z.infer<typeof blockSchema>[]>> {
    const out = new Map<string, z.infer<typeof blockSchema>[]>();
    const schema = z.looseObject({ items: z.array(z.looseObject({ id: idish, description: z.looseObject({ blocks: z.array(blockSchema).nullish() }).nullish() }).nullable()) });
    for (let at = 0; at < itemIds.length; at += 10) {
      let pending = itemIds.slice(at, at + 10);
      for (let page = 1; pending.length > 0 && page <= DESCRIPTION_PAGE_CAP; page++) {
        const rows = (await this.read(schema, DESCRIPTION_QUERY, { ids: pending, limit: DESCRIPTION_FETCH_PAGE, page })).items;
        const still: string[] = [];
        for (const row of rows) {
          if (!row) continue;
          const blocks = row.description?.blocks ?? [];
          const key = String(row.id);
          out.set(key, [...(out.get(key) ?? []), ...blocks]);
          if (blocks.length === DESCRIPTION_FETCH_PAGE) still.push(key);
        }
        pending = still;
      }
    }
    return out;
  }

  async createdItemIds(boardId: string): Promise<string[]> {
    return (await this.createdItems(boardId)).map((item) => item.id);
  }

  async createdItems(boardId: string): Promise<{ id: string; parentId: string | null }[]> {
    return (await this.boardLog(boardId)).items;
  }

  async boardLog(boardId: string): Promise<{ items: { id: string; parentId: string | null }[]; archivedGroups: { id: string; title: string }[] }> {
    const schema = z.looseObject({ boards: z.array(z.looseObject({ activity_logs: z.array(z.looseObject({ event: nullishStr, data: nullishStr })).nullish() })) });
    const out: string[] = [];
    const archivedGroups = new Map<string, string>();
    const seen = new Set<string>();
    const createdUnder = new Map<string, string | null>();
    const archivedUnder = new Map<string, string | null>();
    const idOf = (value: unknown): string | null => (typeof value === "number" || typeof value === "string") && String(value) !== "" ? String(value) : null;
    let lastPage = "";
    for (let page = 1; ; page++) {
      const logs = (await this.read(schema, ACTIVITY_LOG_QUERY, { ids: [String(boardId)], limit: 500, page })).boards[0]?.activity_logs ?? [];
      const thisPage = JSON.stringify(logs);
      if (logs.length && thisPage === lastPage) throw new MondayError(`monday.com activity log pagination repeated a page on board ${boardId}; refusing to continue`);
      lastPage = thisPage;
      for (const entry of logs) {
        if ((entry.event !== "create_pulse" && entry.event !== "archive_pulse" && entry.event !== "archive_group") || !entry.data) continue;
        let data: { pulse_id?: unknown; parent_item_id?: unknown; group_id?: unknown; group_title?: unknown };
        try {
          data = JSON.parse(entry.data) as typeof data;
        } catch {
          continue;
        }
        if (entry.event === "archive_group") {
          const group = idOf(data.group_id);
          if (group !== null && !archivedGroups.has(group)) archivedGroups.set(group, typeof data.group_title === "string" && data.group_title ? data.group_title : group);
          continue;
        }
        const id = idOf(data.pulse_id);
        if (id === null) continue;
        if (entry.event === "archive_pulse") {
          if (!archivedUnder.has(id) && "parent_item_id" in data) archivedUnder.set(id, idOf(data.parent_item_id));
          continue;
        }
        if (!createdUnder.has(id)) createdUnder.set(id, idOf(data.parent_item_id));
        if (!seen.has(id)) {
          seen.add(id);
          out.push(id);
        }
      }
      if (logs.length < 500) break;
    }
    if (archivedGroups.size) {
      const live = z.looseObject({ boards: z.array(z.looseObject({ groups: z.array(z.looseObject({ id: idish })).nullish() })) });
      for (const group of (await this.read(live, "query($ids: [ID!]) { boards(ids: $ids) { groups { id } } }", { ids: [String(boardId)] })).boards[0]?.groups ?? []) archivedGroups.delete(String(group.id));
    }
    return {
      items: out.map((id) => ({ id, parentId: archivedUnder.has(id) ? archivedUnder.get(id)! : (createdUnder.get(id) ?? null) })),
      archivedGroups: [...archivedGroups].map(([id, title]) => ({ id, title })),
    };
  }

  async archivedItems(itemIds: Iterable<string>, boardId?: string): Promise<{ items: RawItem[]; updates: RawUpdate[] }> {
    const ids = [...new Set([...itemIds].map(String))].sort();
    const schema = z.looseObject({ items: z.array(rawItemSchema.extend({ updates: z.array(rawUpdateSchema).nullish(), board: z.looseObject({ id: idish }).nullish() }).nullable()).nullish() });
    const items: RawItem[] = [];
    const updates: RawUpdate[] = [];
    for (let at = 0; at < ids.length; at += 25) {
      const batch = ids.slice(at, at + 25);
      for (const row of (await this.read(schema, ARCHIVED_ITEMS_QUERY, { ids: batch, limit: batch.length })).items ?? []) {
        if (row?.state !== "archived") continue;
        const { updates: own, board, ...item } = row;
        if (boardId !== undefined && board && String(board.id) !== String(boardId)) continue;
        items.push(item);
        for (const update of own ?? []) updates.push({ ...update, item_id: update.item_id ?? row.id });
        if ((own?.length ?? 0) >= UPDATES_PAGE) updates.push(...(await this.moreArchivedUpdates(String(row.id))));
      }
    }
    const whole = await this.descriptions(items.filter((item) => (item.description?.blocks?.length ?? 0) >= DESCRIPTION_PAGE).map((item) => String(item.id)));
    return { items: items.map((item) => (whole.has(String(item.id)) ? { ...item, description: { blocks: whole.get(String(item.id))! } } : item)), updates };
  }

  private async moreArchivedUpdates(itemId: string): Promise<RawUpdate[]> {
    const schema = z.looseObject({ items: z.array(z.looseObject({ updates: z.array(rawUpdateSchema).nullish() }).nullable()).nullish() });
    const out: RawUpdate[] = [];
    const seen = new Set<string>();
    for (let page = 2; ; page++) {
      const batch = (await this.read(schema, ARCHIVED_ITEM_UPDATES_QUERY, { ids: [itemId], limit: UPDATES_PAGE, page })).items?.[0]?.updates ?? [];
      for (const update of batch) {
        if (seen.has(String(update.id))) throw new MondayError(`monday.com update paging repeated update ${update.id}; refusing to continue with an ambiguous read`);
        seen.add(String(update.id));
        out.push({ ...update, item_id: update.item_id ?? itemId });
      }
      if (batch.length < UPDATES_PAGE) return out;
    }
  }

  async itemStates(itemIds: Iterable<string>): Promise<Map<string, string>> {
    const ids = [...new Set([...itemIds].map(String))].sort();
    const out = new Map<string, string>();
    const schema = z.looseObject({ items: z.array(z.looseObject({ id: idish, state: nullishStr }).nullable()).nullish() });
    for (let at = 0; at < ids.length; at += 100) {
      const batch = ids.slice(at, at + 100);
      for (const row of (await this.read(schema, ITEM_STATES_QUERY, { ids: batch, limit: batch.length })).items ?? []) if (row?.state) out.set(String(row.id), row.state);
    }
    return out;
  }

  async activeItemBoards(itemIds: Iterable<string>): Promise<Map<string, string>> {
    const ids = [...new Set([...itemIds].map(String))].sort();
    const out = new Map<string, string>();
    const schema = z.looseObject({ items: z.array(z.looseObject({ id: idish, state: nullishStr, board: z.looseObject({ id: idish }).nullish() }).nullable()).nullish() });
    for (let at = 0; at < ids.length; at += 100) {
      const batch = ids.slice(at, at + 100);
      const rows = (await this.read(schema, ACTIVE_ITEMS_QUERY, { ids: batch, limit: batch.length })).items ?? [];
      for (const row of rows) if (row && row.state === "active" && row.board) out.set(String(row.id), String(row.board.id));
    }
    return out;
  }

  async itemNames(itemIds: Iterable<string>, boardId: string): Promise<Map<string, string>> {
    const ids = [...new Set([...itemIds].map(String))].sort();
    const out = new Map<string, string>();
    const schema = z.looseObject({ items: z.array(z.looseObject({ id: idish, name: nullishStr, state: nullishStr, board: z.looseObject({ id: idish }).nullish() }).nullable()).nullish() });
    for (let at = 0; at < ids.length; at += 100) {
      const batch = ids.slice(at, at + 100);
      const rows = (await this.read(schema, ACTIVE_ITEMS_QUERY, { ids: batch, limit: batch.length })).items ?? [];
      for (const row of rows) if (row && row.state === "active" && row.board && String(row.board.id) === String(boardId)) out.set(String(row.id), row.name ?? "");
    }
    return out;
  }

  async itemsByLevel(boardId: string): Promise<number[]> {
    const counts: number[] = [];
    for (const level of (await this.itemLevels(boardId)).values()) counts[level - 1] = (counts[level - 1] ?? 0) + 1;
    return Array.from(counts, (n) => n ?? 0);
  }

  itemLevels(boardId: string): Promise<Map<string, number>> {
    const key = String(boardId);
    let held = this.levels.get(key);
    if (!held) {
      held = (async () => {
        const parentOf = new Map<string, string | null>();
        const row = z.looseObject({ id: idish, parent_item: z.looseObject({ id: idish }).nullish() });
        for await (const page of this.itemPages(key, "id parent_item { id }", row, { allLevels: true })) {
          for (const item of page) parentOf.set(String(item.id), item.parent_item ? String(item.parent_item.id) : null);
        }
        const levels = new Map<string, number>();
        for (const id of parentOf.keys()) {
          let level = 1;
          for (let at = parentOf.get(id); at !== null && at !== undefined; at = parentOf.get(at)) level++;
          levels.set(id, level);
        }
        return levels;
      })();
      this.levels.set(key, held);
      held.catch(() => this.levels.delete(key));
    }
    return held.then((levels) => new Map(levels));
  }

  async itemTitles(boardId: string): Promise<Map<string, string>> {
    const key = String(boardId);
    if (!this.titles.has(key)) {
      const titles = new Map<string, string>();
      for await (const page of this.itemPages(key, "id name", z.looseObject({ id: idish, name: z.string() }))) {
        for (const row of page) {
          const id = String(row.id);
          if (titles.has(id)) throw new MondayError(`monday.com item pagination repeated item ${id}; refusing to continue with an ambiguous board read`);
          titles.set(id, row.name);
        }
      }
      this.titles.set(key, titles);
    }
    return new Map(this.titles.get(key)!);
  }

  async references(boardId: string, columnIds: string[]): Promise<{ people: [string, string][]; tagIds: string[]; labelIds: [columnId: string, labelId: string][]; byColumn: [columnId: string, who: string][] }> {
    const creators = columnIds.includes("__created_by");
    const columns = columnIds.filter((c) => !c.startsWith("__"));
    if (!columns.length && !creators) return { people: [], tagIds: [], labelIds: [], byColumn: [] };
    const selection = (creators ? "creator_id " : "") + (columns.length ? "column_values(ids: $cols) { id value }" : "");
    const row = z.looseObject({ creator_id: idish.nullish(), column_values: z.array(z.looseObject({ id: idish.nullish(), value: z.unknown().optional() })).nullish() });
    const people = new Map<string, [string, string]>();
    const tagIds = new Set<string>();
    const labelIds = new Map<string, [string, string]>();
    const byColumn = new Map<string, [string, string]>();
    for await (const page of this.itemPages(boardId, selection, row, { columns })) {
      for (const item of page) {
        if (creators && item.creator_id !== null && item.creator_id !== undefined && item.creator_id !== "") people.set(`person:${item.creator_id}`, ["person", String(item.creator_id)]);
        for (const cv of item.column_values ?? []) {
          for (const [kind, id] of peopleIn(cv.value)) {
            people.set(`${kind}:${id}`, [kind, id]);
            const key = kind === "person" ? id : kind === "team" ? `team:${id}` : null;
            if (key !== null && cv.id !== null && cv.id !== undefined) byColumn.set(`${cv.id}\u0000${key}`, [String(cv.id), key]);
          }
          for (const tag of tagIdsIn(cv.value)) tagIds.add(tag);
          if (cv.id !== null && cv.id !== undefined) for (const label of labelIdsIn(cv.value)) labelIds.set(`${cv.id}\u0000${label}`, [String(cv.id), label]);
        }
      }
    }
    return { people: [...people.values()], tagIds: [...tagIds], labelIds: [...labelIds.values()], byColumn: [...byColumn.values()] };
  }

  private async cached<T extends { id: string | number }>(cache: Map<string, T | null>, root: string, query: string, rowSchema: z.ZodType<T>, ids: Iterable<string>, batch: number, isolate = false): Promise<Map<string, T>> {
    const wanted = [...new Set([...ids].map(String))];
    const unknown = wanted.filter((id) => !cache.has(id));
    const schema = z.looseObject({ [root]: nullableRow(rowSchema) });
    for (let at = 0; at < unknown.length; at += batch) {
      const asked = unknown.slice(at, at + batch);
      const found = new Map<string, T>();
      const ask = async (askedIds: string[]): Promise<void> => {
        const rows = ((await this.read(schema, query, { ids: askedIds }))[root] ?? []) as (T | null)[];
        for (const row of rows) if (row && row.id !== null && row.id !== undefined) found.set(String(row.id), row);
      };
      try {
        await ask(asked);
      } catch (error) {
        if (!isolate || !(error instanceof MondayGraphQLError)) throw error;
        if (asked.length === 1) {
          cache.set(asked[0]!, null);
          continue;
        }
        let refused: MondayGraphQLError | null = null;
        let answered = 0;
        for (const id of asked) {
          try {
            await ask([id]);
            answered++;
          } catch (alone) {
            if (!(alone instanceof MondayGraphQLError)) throw alone;
            refused ??= alone;
          }
        }
        if (answered === 0 && refused) throw refused;
      }
      for (const id of asked) cache.set(id, found.get(id) ?? null);
    }
    const out = new Map<string, T>();
    for (const id of wanted) {
      const row = cache.get(id);
      if (row) out.set(id, row);
    }
    return out;
  }

  async tagNames(tagIds: Iterable<string>): Promise<Map<string, string>> {
    const rows = await this.cached(this.tags, "tags", TAGS_QUERY, tagRow, tagIds, TAG_BATCH);
    return new Map([...rows].filter(([, row]) => row.name).map(([id, row]) => [id, String(row.name)]));
  }

  async getUsers(userIds: Iterable<string>): Promise<Map<string, RawUser>> {
    return this.cached(this.users, "users", USERS_QUERY, userRow, userIds, USER_BATCH);
  }

  async getTeams(teamIds: Iterable<string>): Promise<Map<string, RawTeam>> {
    return this.cached(this.teams, "teams", TEAMS_QUERY, teamRow, teamIds, TEAM_BATCH);
  }

  async updates(boardId: string, o: { since?: string | null } = {}): Promise<RawUpdate[]> {
    const key = `${boardId}\u0000${o.since ?? ""}`;
    if (!this.updatesCache.has(key)) this.updatesCache.set(key, await this.readUpdates(String(boardId), o.since ?? null));
    return [...this.updatesCache.get(key)!];
  }

  private async readUpdates(boardId: string, since: string | null): Promise<RawUpdate[]> {
    const out: RawUpdate[] = [];
    const seen = new Set<string>();
    const schema = z.looseObject({ boards: z.array(z.looseObject({ updates: z.array(rawUpdateSchema).nullish() })) });
    for (let page = 1; ; page++) {
      const boards = (await this.read(schema, UPDATES_QUERY, { ids: [boardId], limit: UPDATES_PAGE, page, from: since })).boards;
      const board = boards[0];
      if (!board) throw new MondayError(`monday.com board ${boardId} not found or not accessible`);
      const batch = board.updates ?? [];
      for (const update of batch) {
        const id = String(update.id);
        if (seen.has(id)) throw new MondayError(`monday.com update paging repeated update ${id}; refusing to continue with an ambiguous read`);
        seen.add(id);
        out.push(update);
      }
      if (batch.length < UPDATES_PAGE) return out;
    }
  }

  async assetMeta(assetIds: Iterable<string>): Promise<Map<string, RawAssetMeta>> {
    return this.cached(this.assetMetas, "assets", ASSET_META_QUERY, assetMetaRow, assetIds, ASSET_BATCH, true);
  }

  async assets(assetIds: string[]): Promise<Map<string, RawAsset>> {
    const out = new Map<string, RawAsset>();
    const ids = assetIds.map(String);
    for (let at = 0; at < ids.length; at += ASSET_BATCH) {
      const rows = (await this.read(z.looseObject({ assets: nullableRow(assetRow) }), ASSETS_QUERY, { ids: ids.slice(at, at + ASSET_BATCH) })).assets ?? [];
      for (const row of rows) if (row) out.set(String(row.id), row);
    }
    return out;
  }
}
