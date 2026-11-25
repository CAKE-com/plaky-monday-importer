import { createHash } from "node:crypto";
import type { MondayClient } from "../clients/monday";
import { ArchiveReads } from "./archive-state";
import { extractBoard, fileColumnAssetIds, sanitizePayload, type BoardExtract, type RawSink } from "../pipeline/extract";
import { baseBoardId } from "../pipeline/names";
import { docsInValue, filesInValue, MAX_UPLOAD_BYTES } from "../pipeline/transform/files";
import type { AssetSource } from "../pipeline/assets";
import { DEPARTURE_LABELS, type DeparturePreflight } from "@/lib/departure";

type Gap = { kind: "failed" | "manual" | "unavailable"; subject: string; action: string };
type SavedFile = { path: string; bytes: number; sha256: string };
type SavedBoard = { id: string; name: string; state: "read" | "failed" | "not_attempted"; items?: number; updates?: number; path?: string };
type DepartureManifest = {
  format: "monday-departure"; version: 1; startedAt: string; finishedAt: string;
  status: "review_required" | "incomplete";
  scope: string; boards: SavedBoard[]; attachments: { id: string; name: string; path: string; representation: "original" | "markdown"; sourceBytes: number | null }[];
  gaps: Gap[]; files: SavedFile[];
};
type ArchiveSource = {
  inventory(): Promise<unknown>;
  board(id: string, sink: RawSink): Promise<BoardExtract>;
  automations(id: string): Promise<unknown>;
};

export function departureSource(monday: MondayClient): ArchiveSource {
  return {
    inventory: () => monday.listBoards(),
    board: (id, sink) => extractBoard(monday, id, { since: null, allLevels: true, archived: true, sink }),
    automations: (id) => monday.boardAutomations(id),
  };
}

const escape = (s: unknown): string => String(s).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
const html = (title: string, body: string): string => `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src 'none'; base-uri 'none'; form-action 'none'"><title>${escape(title)}</title><style>body{font:17px/1.6 system-ui;max-width:1000px;margin:40px auto;padding:0 24px;color:#182030;overflow-wrap:anywhere}h1,h2{line-height:1.2}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f4f5f7;padding:16px}li{margin:8px 0}a{color:#174ca1}</style><body><main><h1>${escape(title)}</h1>${body}</main></body></html>`;
const MAX_DOWNLOAD_NAME = 150;
function downloadName(raw: string, taken: Set<string>): string {
  const last = raw.normalize("NFC").replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g, "").split(/[\\/]/).filter(Boolean).pop() ?? "";
  let name = last.replace(/[<>:"|?*]/g, "_").trim().replace(/^\.+/, "").replace(/[. ]+$/, "") || "attachment";
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(name)) name = `_${name}`;
  const dot = name.lastIndexOf(".");
  const [stem, ext] = dot > 0 && name.length - dot <= 11 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
  const cut = (value: string, room: number): string => Array.from(value).slice(0, Math.max(1, room)).join("");
  for (let n = 1; ; n++) {
    const tag = n === 1 ? "" : ` (${n})`;
    const candidate = `${cut(stem, MAX_DOWNLOAD_NAME - Array.from(ext).length - tag.length)}${tag}${ext}`;
    if (!taken.has(candidate.toLowerCase())) { taken.add(candidate.toLowerCase()); return candidate; }
  }
}
const json = (data: unknown): Uint8Array => Buffer.from(`${JSON.stringify(sanitizePayload(data), null, 2)}\n`);
const text = (data: string): Uint8Array => Buffer.from(String(sanitizePayload(data)));
const safePart = (s: string): string => createHash("sha256").update(s).digest("hex").slice(0, 24);

export async function writeDepartureArchive(input: {
  name: string; boardIds: readonly string[]; preflight: DeparturePreflight; evidence: unknown;
  source: ArchiveSource; assets: AssetSource; add(path: string, data: Uint8Array): Promise<void>; signal: AbortSignal;
}): Promise<DepartureManifest> {
  const manifest: DepartureManifest = {
    format: "monday-departure", version: 1, startedAt: new Date().toISOString(), finishedAt: "",
    status: "review_required", scope: input.preflight.scope, boards: [], attachments: [], files: [], gaps: [
      { kind: "manual", subject: "Final export", action: "Stop monday edits before the final move, check and export. Reads are not simultaneous." },
      { kind: "unavailable", subject: "Other boards", action: "Selected boards only. Review account-inventory.json for omissions; inaccessible content may be unlisted." },
      { kind: "manual", subject: "Archive and trash", action: "Archived content may be missing. Restore needed items and groups, then export again. Review monday’s trash." },
      { kind: "unavailable", subject: "History and settings", action: "History and workspace settings are incomplete. Copy standalone docs separately; rebuild automations, dashboards, integrations and access settings." },
      { kind: "unavailable", subject: "Other content", action: "Reactions, read receipts, doc comments and original document blocks are excluded. View settings are partial. Copy needed details separately." },
      { kind: "manual", subject: "External content", action: "Download remote images and linked content separately. Test documents offline." },
      { kind: "unavailable", subject: "Sensitive data", action: "Credentials and signed links are removed from snapshots. Original attachments may still contain sensitive data." },
    ],
  };
  const reads = new ArchiveReads();
  const add = async (path: string, data: Uint8Array): Promise<void> => {
    input.signal.throwIfAborted();
    try { await input.add(path, data); } catch (e) { reads.storageFailed(e); }
    manifest.files.push({ path, bytes: data.length, sha256: createHash("sha256").update(data).digest("hex") });
  };
  const failure = (subject: string, error: unknown): void => {
    const outcome = reads.failedRead(error, input.signal);
    manifest.gaps.push({ kind: "failed", subject, action: outcome === "limit" ? "monday's daily limit was reached. Keep monday access and export again after the limit resets." : "Could not read this content. Keep monday access, check access and availability, and export again or save it manually." });
  };
  await add("preflight.json", json(input.preflight));
  await add("migration-evidence.json", json(input.evidence));
  const wanted = [...new Set(input.boardIds.map(baseBoardId))];
  let inventory: unknown;
  try {
    inventory = await input.source.inventory();
    await add("account-inventory.json", json(inventory));
  } catch (e) { failure("Account inventory", e); }
  const assets = new Map<string, string>();
  for (const id of wanted) {
    input.signal.throwIfAborted();
    const board: SavedBoard = { id, name: id, state: "not_attempted" };
    manifest.boards.push(board);
    if (reads.limited) { manifest.gaps.push({ kind: "failed", subject: `Board ${id}`, action: "Not attempted after monday's daily limit; export again after reset." }); continue; }
    const dir = `boards/${safePart(id)}`;
    try {
      const archivedIds: string[] = [];
      const snapshot = await input.source.board(id, { save: async (type, key, payload) => {
        await add(`${dir}/raw/${type}-${safePart(key)}.json`, json(payload));
        if (type === "archive_discovery") {
          const coverage = payload as { states: [string, string][]; unresolved: string[] };
          for (const [itemId, state] of coverage.states) {
            if (state === "archived") archivedIds.push(itemId);
            if (state === "deleted") manifest.gaps.push({ kind: "unavailable", subject: `Board ${id}: deleted item ${itemId}`, action: "Deleted content was not exported. Restore or save it from monday’s trash if needed." });
          }
          for (const itemId of coverage.unresolved) manifest.gaps.push({ kind: "manual", subject: `Board ${id}: unresolved item ${itemId}`, action: "monday did not return this item’s state. Check for deleted, moved or inaccessible content." });
        }
      } });
      if (snapshot.isDelta || snapshot.outOfScope?.length) throw new Error("Archive requires a full source read");
      const savedIds = new Set(snapshot.items.map((item) => item.id));
      for (const itemId of archivedIds) if (!savedIds.has(itemId)) failure(`Board ${id}: archived item ${itemId} was not returned in the content read`, new Error("Missing archived item"));
      for (const child of snapshot.board.subitemBoardIds) if (!wanted.includes(child)) wanted.push(child);
      board.name = snapshot.board.name;
      await add(`${dir}/source.json`, json(snapshot));
      const safe = sanitizePayload(snapshot) as BoardExtract;
      await add(`${dir}/index.html`, text(html(safe.board.name,
        `<p><a href="../../START-HERE.html">Archive index</a> · <a href="source.json">Source JSON</a></p><p>${safe.items.length} items; ${safe.updates.length} updates and replies. Archived items may use reconstructed groups or parents. Original API data is in raw/.</p>` +
        safe.items.map((i) => `<h2>${escape(i.name)}</h2><p>Monday ID: ${escape(i.id)} · Parent: ${escape(i.parentId ?? "none")} · Group: ${escape(i.groupTitle ?? "none")}</p><pre>${escape(JSON.stringify(i.columnValues, null, 2))}</pre>`).join("") +
        `<h2>Updates and replies (including board posts)</h2>` + safe.updates.map((u) => `<p>${escape(u.author)} · ${escape(u.createdAt)} · item ${escape(u.itemId || "board post")} · reply to ${escape(u.parentId ?? "none")}</p><pre>${escape(u.text)}</pre>`).join(""))));
      Object.assign(board, { state: "read", items: snapshot.items.length, updates: snapshot.updates.length, path: `${dir}/index.html` });
      for (const asset of Object.values(snapshot.assets)) assets.set(asset.id, asset.name ?? asset.id);
      for (const asset of fileColumnAssetIds(snapshot.items)) if (!assets.has(asset)) assets.set(asset, asset);
      for (const item of snapshot.items) for (const [asset, name] of item.assets ?? []) assets.set(asset, name);
      for (const update of snapshot.updates) for (const [asset, name] of update.assets) assets.set(asset, name);
      for (const item of snapshot.items) for (const value of Object.values(item.columnValues)) {
        for (const image of Array.isArray(value.images) ? value.images : []) if (image && typeof image.assetId === "string") assets.set(image.assetId, String(image.name ?? image.assetId));
        if (value.type !== "doc" && value.type !== "file") continue;
        for (const doc of docsInValue(value.value)) if (doc.assetId) assets.set(doc.assetId, doc.name);
        let parsed: unknown = value.value;
        if (typeof parsed === "string") { try { parsed = JSON.parse(parsed); } catch { } }
        const rows = parsed && typeof parsed === "object" && "files" in parsed && Array.isArray(parsed.files) ? parsed.files : [];
        const links = rows.filter((row) => !docsInValue({ files: [row] }).length);
        for (const file of filesInValue({ files: links })) {
          if (file.assetId) assets.set(file.assetId, file.name);
          else manifest.gaps.push({ kind: "manual", subject: `${board.name}: ${item.name}: ${file.name}`, action: "External or unresolved file reference: its available details are in the source JSON. Save the content separately; no file bytes were archived for this reference." });
        }
      }
    } catch (e) { board.state = "failed"; failure(`Board ${id}`, e); }
    if (!reads.limited) try { await add(`${dir}/automations.json`, json(await input.source.automations(id))); } catch (e) { failure(`${board.name}: automations`, e); }
  }
  if (Array.isArray(inventory)) for (const row of inventory) {
    if (row && typeof row === "object" && "id" in row && !wanted.includes(String(row.id))) {
      manifest.gaps.push({ kind: "unavailable", subject: `Outside archive: ${String(row.name ?? row.id)} (${String(row.id)})`, action: "This account entry was not selected. Export or review its content separately before closing monday." });
    }
  }
  input.assets.prefetch(assets.keys());
  for (const [id, label] of assets) {
    input.signal.throwIfAborted();
    if (reads.limited) { manifest.gaps.push({ kind: "failed", subject: `Attachment ${id}: ${label}`, action: "Not attempted after monday's daily limit. Export again after reset." }); continue; }
    try {
      const [, expectedSize] = await input.assets.meta(id);
      if (expectedSize !== null && expectedSize > MAX_UPLOAD_BYTES) throw new Error("Manual copy required: file too large");
      const [name, bytes] = await input.assets.fetch(id);
      if (bytes.length > MAX_UPLOAD_BYTES || (expectedSize !== null && bytes.length !== expectedSize)) throw new Error("Attachment size does not match the source");
      const ext = /\.([a-zA-Z0-9]{1,10})$/.exec(name)?.[1]?.toLowerCase();
      const path = `attachments/${safePart(id)}${ext ? `.${ext}` : ""}`;
      await add(path, bytes);
      manifest.attachments.push({ id, name: String(sanitizePayload(name)), path, representation: id.startsWith("doc:") ? "markdown" : "original", sourceBytes: expectedSize });
      if (expectedSize === null) manifest.gaps.push({ kind: "manual", subject: `Attachment ${id}: ${label}`, action: "Downloaded, but monday did not provide a source size. The checksum only protects these downloaded bytes; open the file and check it against monday before departure." });
    } catch (e) { failure(`Attachment ${id}: ${label} (files over 100 MB need a manual copy)`, e); }
  }
  manifest.status = reads.outcome;
  manifest.finishedAt = new Date().toISOString();
  const gapGroups = new Map<string, { kind: Gap["kind"]; action: string; subjects: string[] }>();
  for (const gap of manifest.gaps) {
    const key = JSON.stringify([gap.kind, gap.action]);
    const group = gapGroups.get(key) ?? { kind: gap.kind, action: gap.action, subjects: [] };
    group.subjects.push(gap.subject);
    gapGroups.set(key, group);
  }
  const gaps = [...gapGroups.values()].map((gap) => `<li><strong>${escape(gap.kind)}${gap.subjects.length === 1 ? ` — ${escape(gap.subjects[0])}` : ""}:</strong> ${escape(gap.action)}${gap.subjects.length > 1 ? `<details><summary>Affected content (${gap.subjects.length})</summary><ul>${gap.subjects.map((subject) => `<li>${escape(subject)}</li>`).join("")}</ul></details>` : ""}</li>`).join("");
  const preflight = input.preflight.entries.map((e) => `<li><strong>${DEPARTURE_LABELS[e.category]} — ${escape(e.subject)}:</strong> ${escape(e.detail)}</li>`).join("");
  const taken = new Set<string>();
  await add("START-HERE.html", text(html(String(sanitizePayload(input.name)),
    `<p><strong>${manifest.status === "incomplete" ? "INCOMPLETE: some content could not be saved." : "Archive ready — review gaps before leaving monday."}</strong></p><p>Snapshot: ${escape(manifest.startedAt)} to ${escape(manifest.finishedAt)}. ${escape(manifest.scope)}</p><p>Extract the ZIP, test files offline, and keep two secure copies.</p>` +
    `<h2>Boards</h2><ul>${manifest.boards.map((b) => `<li>${b.path ? `<a href="${b.path}">${escape(b.name)}</a>` : escape(b.name)} — ${b.state}${b.items !== undefined ? `, ${b.items} items, ${b.updates} updates/replies` : ""}</li>`).join("")}</ul>` +
    `<h2>Attachments</h2><ul>${manifest.attachments.map((a) => `<li><a href="${a.path}" download="${escape(downloadName(a.name, taken))}">${escape(a.name)}</a> ${a.representation === "markdown" ? "(Markdown export)" : ""}</li>`).join("")}</ul>` +
    `<h2>Gaps to review</h2><ul>${gaps}</ul>` +
    `<details><summary>Migration details</summary><p>Plaky check: ${escape(input.preflight.verification)}. Check again after source edits.</p><ul>${preflight}</ul></details>` +
    `<h2>Integrity and contents</h2><p><a href="archive-manifest.json">Archive manifest</a> · <a href="preflight.json">Preflight</a> · <a href="migration-evidence.json">Migration evidence</a>${manifest.files.some((f) => f.path === "account-inventory.json") ? ' · <a href="account-inventory.json">Account inventory</a>' : " (account inventory could not be read)"}</p><details><summary>Verify file integrity</summary><p>After extraction, run <code>shasum -a 256 -c SHA256SUMS</code> (macOS) or <code>sha256sum -c SHA256SUMS</code> (Linux), or use a SHA-256 tool on Windows. Hashes detect corruption, not missing content.</p></details>`)));
  const manifestBytes = json(manifest);
  await add("archive-manifest.json", manifestBytes);
  await input.add("SHA256SUMS", text(manifest.files.map((f) => `${f.sha256}  ${f.path}`).join("\n") + "\n"));
  return manifest;
}
