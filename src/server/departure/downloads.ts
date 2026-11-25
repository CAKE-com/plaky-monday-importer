import { randomUUID } from "node:crypto";
import { createReadStream, type ReadStream } from "node:fs";
import { mkdtemp, rm, stat, readdir, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { DownloadTicket } from "./download-state";

const PREFIX = "monday-departure-";
const LIFETIME_MS = 30 * 60_000;
type Download = { dir: string; path: string; filename: string; expires: number; lifecycle: DownloadTicket<ReadStream>; migrationId: number };
const state = globalThis as typeof globalThis & { __departureDownloads?: Map<string, Download> };
const downloads = (state.__departureDownloads ??= new Map());

export async function archiveTemp(): Promise<{ dir: string; path: string }> {
  for (const name of await readdir(tmpdir())) {
    const owner = /^monday-departure-(\d+)-/.exec(name)?.[1];
    if (!owner) continue;
    try { process.kill(Number(owner), 0); continue; } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ESRCH") continue; }
    const dir = join(tmpdir(), name);
    const info = await lstat(dir).catch(() => null);
    if (info?.isDirectory() && Date.now() - info.mtimeMs > LIFETIME_MS && ![...downloads.values()].some((d) => d.dir === dir)) await rm(dir, { recursive: true, force: true });
  }
  const dir = await mkdtemp(join(tmpdir(), `${PREFIX}${process.pid}-`));
  return { dir, path: join(dir, "archive.zip") };
}

export function offerDownload(file: { dir: string; path: string }, migrationId: number): { url: string; expiresAt: number } {
  const ticket = randomUUID();
  const expires = Date.now() + LIFETIME_MS;
  const entry: Download = { ...file, filename: `monday-departure-${migrationId}-${Date.now()}.zip`, expires, lifecycle: new DownloadTicket(expires), migrationId };
  downloads.set(ticket, entry);
  setTimeout(() => {
    entry.lifecycle.expire(Date.now());
    void dispose(ticket, entry).catch(() => undefined);
  }, LIFETIME_MS).unref();
  return { url: `/api/departure/download/${ticket}`, expiresAt: expires };
}

export async function downloadArchive(ticket: string): Promise<Response> {
  const file = downloads.get(ticket);
  const expired = () => Response.json({ error: "This archive download expired. Create a fresh departure archive." }, { status: 410, headers: { "cache-control": "no-store" } });
  if (!file) return expired();
  file.lifecycle ??= new DownloadTicket(file.expires);
  const claim = file.lifecycle.acquire(Date.now());
  if (!claim) { await dispose(ticket, file); return expired(); }
  try {
    const info = await stat(file.path);
    if (file.lifecycle.state === "revoked") {
      file.lifecycle.release(claim);
      return expired();
    }
    const source = createReadStream(file.path);
    source.on("close", () => {
      file.lifecycle.release(claim);
      file.lifecycle.expire(Date.now());
      void dispose(ticket, file).catch(() => undefined);
    });
    if (!file.lifecycle.attach(claim, source)) return expired();
    const stream = Readable.toWeb(source) as unknown as ReadableStream<Uint8Array>;
    return new Response(stream, { headers: {
      "content-type": "application/zip", "content-disposition": `attachment; filename="${file.filename}"`,
      "content-length": String(info.size), "cache-control": "no-store", "x-content-type-options": "nosniff",
    } });
  } catch (error) {
    file.lifecycle.release(claim);
    await dispose(ticket, file);
    throw error;
  }
}

async function dispose(ticket: string, file: Download): Promise<void> {
  if (!file.lifecycle.disposable) return;
  if (downloads.get(ticket) === file) downloads.delete(ticket);
  await rm(file.dir, { recursive: true, force: true });
}

export async function forgetDepartureArchives(migrationId: number): Promise<void> {
  for (const [ticket, file] of downloads) {
    if (file.migrationId !== migrationId) continue;
    downloads.delete(ticket);
    file.lifecycle ??= new DownloadTicket(file.expires);
    file.lifecycle.revoke();
    await rm(file.dir, { recursive: true, force: true });
  }
}
