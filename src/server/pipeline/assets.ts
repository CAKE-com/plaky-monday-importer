import { isMondayDailyLimit, MondayGraphQLError, type MondayClient } from "../clients/monday";
import { DOC_ASSET_PREFIX, MAX_UPLOAD_BYTES, safeName, URL_LIFETIME_SECONDS } from "./transform/files";

const ASSET_BATCH = 50;
const DOWNLOAD_TIMEOUT_MS = 120_000;

export class FileTooLarge extends Error {
  override readonly name = "FileTooLarge";
}
export class DownloadStatusError extends Error {
  override readonly name = "DownloadStatusError";
  constructor(readonly status: number) {
    super(`HTTP ${status}`);
  }
}

export type AssetInfo = { name: string | null; size: number | null; url: string | null };
export type FetchAssetUrls = (ids: readonly string[]) => Promise<Map<string, AssetInfo>>;
export type Download = (url: string, maxBytes: number) => Promise<Uint8Array>;

export const mondayAssetUrls =
  (monday: Pick<MondayClient, "assets">): FetchAssetUrls =>
  async (ids) =>
    new Map(
      [...(await monday.assets([...ids]))].map(([id, row]): [string, AssetInfo] => [id, { name: row.name ?? null, size: row.file_size ?? null, url: row.public_url ?? null }]),
    );

export interface AssetSource {
  prefetch(assetIds: Iterable<string>): void;
  meta(assetId: string): Promise<[name: string, size: number | null]>;
  fetch(assetId: string): Promise<[name: string, data: Uint8Array]>;
}

export const fetchDownload: Download = async (url, maxBytes) => {
  const response = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (response.status >= 400) {
    await response.body?.cancel();
    throw new DownloadStatusError(response.status);
  }
  const chunks: Uint8Array[] = [];
  let length = 0;
  const reader = response.body?.getReader();
  for (;;) {
    const part = await reader?.read();
    if (!part || part.done) break;
    length += part.value.length;
    if (length > maxBytes) {
      await reader?.cancel();
      throw new FileTooLarge(`over the API's ${maxBytes} bytes`);
    }
    chunks.push(part.value);
  }
  const data = new Uint8Array(length);
  let at = 0;
  for (const chunk of chunks) {
    data.set(chunk, at);
    at += chunk.length;
  }
  return data;
};

export type AssetFetcherOptions = {
  fetchAssetUrls: FetchAssetUrls;
  download?: Download;
  maxBytes?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

const DOWNLOAD_RETRY_MS = [1_000, 3_000];
const retriable = (error: unknown): boolean =>
  error instanceof DownloadStatusError ? error.status === 429 || error.status >= 500 : !(error instanceof FileTooLarge);

type Meta = { name: string; size: number | null; url: string | null; at: number };

export class AssetFetcher implements AssetSource {
  private readonly fetchAssetUrls: FetchAssetUrls;
  private readonly download: Download;
  private readonly maxBytes: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly cache = new Map<string, Meta>();
  private readonly wanted = new Set<string>();
  private readonly alone = new Set<string>();

  constructor(options: AssetFetcherOptions) {
    this.fetchAssetUrls = options.fetchAssetUrls;
    this.download = options.download ?? fetchDownload;
    this.maxBytes = options.maxBytes ?? MAX_UPLOAD_BYTES;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  prefetch(assetIds: Iterable<string>): void {
    for (const id of assetIds) this.wanted.add(String(id));
  }

  async meta(assetId: string): Promise<[string, number | null]> {
    const row = await this.resolve(assetId);
    return [row.name, row.size];
  }

  async fetch(assetId: string): Promise<[string, Uint8Array]> {
    const { name, size, url } = await this.resolve(assetId);
    if (size !== null && size > this.maxBytes) throw new FileTooLarge(`${name} is ${size} bytes, over the API's ${this.maxBytes}`);
    if (!url || !isHttps(url)) throw new Error(`monday gave no https download link for ${name}`);
    let data: Uint8Array;
    try {
      data = await this.downloadWithRetries(url);
    } catch (error) {
      if (error instanceof FileTooLarge) throw new FileTooLarge(`${name} is over the API's ${this.maxBytes} bytes`);
      if (error instanceof DownloadStatusError) throw new Error(`downloading ${name} from monday failed: ${error.status}`);
      throw new Error(`downloading ${name} from monday failed: ${error instanceof Error ? error.name : "error"}`);
    }
    if (data.length > this.maxBytes) throw new FileTooLarge(`${name} is over the API's ${this.maxBytes} bytes`);
    return [name, data];
  }

  private async downloadWithRetries(url: string): Promise<Uint8Array> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.download(url, this.maxBytes);
      } catch (error) {
        const wait = DOWNLOAD_RETRY_MS[attempt];
        if (wait === undefined || !retriable(error)) throw error;
        await this.sleep(wait);
      }
    }
  }

  private stale(assetId: string): boolean {
    const cached = this.cache.get(assetId);
    return cached === undefined || this.now() - cached.at > URL_LIFETIME_SECONDS * 1000;
  }

  private batchMates(assetId: string): string[] {
    if (this.alone.has(assetId)) return [];
    const named = [...this.wanted];
    const start = this.wanted.has(assetId) ? named.indexOf(assetId) + 1 : 0;
    return [...named.slice(start), ...named.slice(0, start)].filter((a) => a !== assetId && this.stale(a) && !this.alone.has(a)).slice(0, ASSET_BATCH - 1);
  }

  private async resolve(assetId: string): Promise<Meta> {
    if (this.stale(assetId)) {
      let batch = [assetId, ...this.batchMates(assetId)];
      let rows: Map<string, AssetInfo>;
      try {
        rows = await this.fetchAssetUrls(batch);
      } catch (error) {
        if (isMondayDailyLimit(error)) throw error;
        if (!(error instanceof MondayGraphQLError) || batch.length === 1) throw error;
        for (const id of batch) this.alone.add(id);
        batch = [assetId];
        rows = await this.fetchAssetUrls(batch);
      }
      const at = this.now();
      for (const id of batch) {
        const row = rows.get(id);
        this.cache.set(id, { name: safeName(row?.name || `asset-${id}`), size: typeof row?.size === "number" ? Math.trunc(row.size) : null, url: row?.url ?? null, at });
      }
    }
    return this.cache.get(assetId)!;
  }
}

function isHttps(url: string): boolean {
  try {
    return new URL(url).protocol === "https:";
  } catch {
    return false;
  }
}

export interface DocReader {
  docsByObjectIds(objectIds: readonly string[]): Promise<Map<string, { id: string; name: string }>>;
  exportDocMarkdown(docId: string): Promise<string | null>;
  docBlockCount(docId: string): Promise<number | null>;
}

type Doc = { id: string; name: string };
type DocBytes = [name: string, data: Uint8Array];
type DocState = { state: "resolving"; done: Promise<void> } | { state: "missing" }
  | { state: "resolved"; doc: Doc } | { state: "exporting"; doc: Doc; done: Promise<DocBytes> }
  | { state: "exported"; bytes: DocBytes };

export class DocAwareSource implements AssetSource {
  private readonly wanted = new Set<string>();
  private readonly documents = new Map<string, DocState>();

  constructor(private readonly inner: AssetSource, private readonly reader: DocReader) {}

  prefetch(assetIds: Iterable<string>): void {
    const others: string[] = [];
    for (const id of assetIds) {
      if (id.startsWith(DOC_ASSET_PREFIX)) this.wanted.add(id.slice(DOC_ASSET_PREFIX.length));
      else others.push(id);
    }
    this.inner.prefetch(others);
  }

  async meta(assetId: string): Promise<[string, number | null]> {
    if (!assetId.startsWith(DOC_ASSET_PREFIX)) return this.inner.meta(assetId);
    const [name, data] = await this.doc(assetId.slice(DOC_ASSET_PREFIX.length));
    return [name, data.length];
  }

  async fetch(assetId: string): Promise<[string, Uint8Array]> {
    if (!assetId.startsWith(DOC_ASSET_PREFIX)) return this.inner.fetch(assetId);
    return this.doc(assetId.slice(DOC_ASSET_PREFIX.length));
  }

  private async resolveDocs(objectId: string): Promise<void> {
    const held = this.documents.get(objectId);
    if (held) { if (held.state === "resolving") await held.done; return; }
    const ids = [...new Set([objectId, ...this.wanted])].filter((id) => !this.documents.has(id));
    const pending: Extract<DocState, { state: "resolving" }> = { state: "resolving", done: Promise.resolve().then(async () => {
      try {
        const found = await this.reader.docsByObjectIds(ids);
        for (const id of ids) {
          const doc = found.get(id);
          this.documents.set(id, doc ? { state: "resolved", doc } : { state: "missing" });
        }
      } catch (error) {
        for (const id of ids) if (this.documents.get(id) === pending) this.documents.delete(id);
        throw error;
      }
    }) };
    for (const id of ids) this.documents.set(id, pending);
    await pending.done;
  }

  private async doc(objectId: string): Promise<DocBytes> {
    await this.resolveDocs(objectId);
    const held = this.documents.get(objectId)!;
    switch (held.state) {
      case "exported": return held.bytes;
      case "exporting": return held.done;
      case "missing": throw new Error(`monday has no doc with object id ${objectId} (deleted, or not shared with this key)`);
      case "resolving": throw new Error("Document lookup has not settled");
      case "resolved": break;
    }
    const pending: Extract<DocState, { state: "exporting" }> = { state: "exporting", doc: held.doc, done: Promise.resolve().then(async () => {
      try {
        const bytes = await this.exportDoc(held.doc);
        this.documents.set(objectId, { state: "exported", bytes });
        return bytes;
      } catch (error) {
        this.documents.set(objectId, held);
        throw error;
      }
    }) };
    this.documents.set(objectId, pending);
    return pending.done;
  }

  private async exportDoc(doc: Doc): Promise<DocBytes> {
    const title = doc.name.trim() || "doc";
    let markdown = await this.reader.exportDocMarkdown(doc.id);
    if (markdown === null) {
      const blocks = await this.reader.docBlockCount(doc.id);
      if (blocks !== 0) throw new Error(`monday could not export the doc '${title}'${blocks === null ? "" : ` (${blocks} blocks)`}: the next run tries again`);
      markdown = `# ${title}\n\nThis monday doc was empty when it was moved.\n`;
    }
    const out: [string, Uint8Array] = [`${safeName(title)}.md`, new TextEncoder().encode(markdown)];
    return out;
  }
}
