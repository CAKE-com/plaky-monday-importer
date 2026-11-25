import { isIP } from "node:net";
import { ENCODINGS_MAP, SUFFIX_MAP, TYPES_MAP } from "./mimeTypes";
import { pyStrip, truthy } from "./pystr";
import { pyRepr, strOf } from "./pyvalue";

export const MAX_UPLOAD_BYTES = 100_000_000;
export const URL_LIFETIME_SECONDS = 50 * 60;

export type MondayFile = {
  name: string;
  assetId: string | null;
  url: string | null;
};

export function filesInValue(value: unknown): MondayFile[] {
  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      return [];
    }
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return [];
  const files = (parsed as Record<string, unknown>).files;
  if (typeof files === "number" && files !== 0) throw new TypeError(`'${Number.isInteger(files) ? "int" : "float"}' object is not iterable`);
  if (files === true) throw new TypeError("'bool' object is not iterable");
  const out: MondayFile[] = [];
  for (const entry of Array.isArray(files) ? files : []) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
    const row = entry as Record<string, unknown>;
    const name = truthy(row.name) ? strOf(row.name) : "file";
    const kind = (truthy(row.fileType) ? strOf(row.fileType) : "ASSET").toUpperCase();
    const asset = row.assetId;
    if (kind === "ASSET" && asset !== undefined && asset !== null) {
      out.push({ name, assetId: strOf(asset), url: null });
    } else {
      const link = truthy(row.linkToFile) ? row.linkToFile : row.url;
      out.push({ name, assetId: null, url: truthy(link) ? strOf(link) : null });
    }
  }
  return out;
}

const utf8 = new TextEncoder();

export function safeName(name: string): string {
  const base = name.replaceAll("\\", "/").split("/").pop()!;
  const cleaned = pyStrip([...base].filter((ch) => !/^\p{C}$/u.test(ch)).join("")) || "file";
  const encoded = utf8.encode(cleaned);
  if (encoded.length <= 255) return cleaned;
  const dot = cleaned.lastIndexOf(".");
  const stem = dot < 0 ? "" : cleaned.slice(0, dot);
  const ext = dot < 0 ? "" : cleaned.slice(dot + 1);
  const suffix = dot >= 0 && utf8.encode(ext).length < 20 ? `.${ext}` : "";
  const room = 255 - utf8.encode(suffix).length;
  const bytes = suffix ? utf8.encode(stem) : encoded;
  let cut = Math.min(room, bytes.length);
  while (cut > 0 && cut < bytes.length && (bytes[cut]! & 0xc0) === 0x80) cut--;
  return new TextDecoder().decode(bytes.subarray(0, cut)) + suffix;
}

const has = (table: Readonly<Record<string, string>>, key: string): boolean => Object.hasOwn(table, key);

function splitExt(path: string): [string, string] {
  const sep = path.lastIndexOf("/");
  const dot = path.lastIndexOf(".");
  if (dot > sep) {
    for (let i = sep + 1; i < dot; i++) if (path[i] !== ".") return [path.slice(0, dot), path.slice(dot)];
  }
  return [path, ""];
}

const USES_PARAMS = new Set(["", "ftp", "hdl", "prospero", "http", "imap", "https", "shttp", "rtsp", "rtspu", "sip", "sips", "mms", "sftp", "tel"]);

function urlPath(input: string): [scheme: string, path: string] {
  let url = input.replace(/^[\x00-\x20]+/, "").replace(/[\t\r\n]/g, "");
  let scheme = "";
  const colon = url.indexOf(":");
  if (colon > 0 && /^[A-Za-z]/.test(url) && /^[A-Za-z0-9+\-.]*$/.test(url.slice(0, colon))) {
    scheme = url.slice(0, colon).toLowerCase();
    url = url.slice(colon + 1);
  }
  if (url.startsWith("//")) {
    let end = url.length;
    for (const c of "/?#") {
      const at = url.indexOf(c, 2);
      if (at >= 0) end = Math.min(end, at);
    }
    const netloc = url.slice(2, end);
    if (netloc.includes("[") !== netloc.includes("]")) throw new Error("Invalid IPv6 URL");
    if (netloc.includes("[")) {
      const host = netloc.slice(netloc.indexOf("[") + 1).split("]")[0]!;
      if (host.startsWith("v")) {
        if (!/^v[0-9a-fA-F]+\..+$/.test(host)) throw new Error("IPvFuture address is invalid");
      } else if (isIP(host) === 0) {
        throw new Error(`${pyRepr(host)} does not appear to be an IPv4 or IPv6 address`);
      } else if (isIP(host) === 4) {
        throw new Error("An IPv4 address cannot be in brackets");
      }
    }
    url = url.slice(end);
  }
  const hash = url.indexOf("#");
  if (hash >= 0) url = url.slice(0, hash);
  const query = url.indexOf("?");
  if (query >= 0) url = url.slice(0, query);
  if (USES_PARAMS.has(scheme) && url.includes(";")) {
    const slash = url.lastIndexOf("/");
    const semi = url.indexOf(";", slash >= 0 ? slash : 0);
    if (semi >= 0) url = url.slice(0, semi);
  }
  return [scheme, url];
}

function guessType(name: string): string | null {
  const [scheme, path] = urlPath(name);
  let url = name;
  if (scheme.length > 1) {
    url = path;
    if (scheme === "data") {
      const comma = url.indexOf(",");
      if (comma < 0) return null;
      const semi = url.indexOf(";");
      const type = semi >= 0 && semi < comma ? url.slice(0, semi) : url.slice(0, comma);
      return type.includes("=") || !type.includes("/") ? "text/plain" : type;
    }
  }
  let [base, ext] = splitExt(url);
  for (let lower = ext.toLowerCase(); has(SUFFIX_MAP, lower); lower = ext.toLowerCase()) {
    [base, ext] = splitExt(base + SUFFIX_MAP[lower]!);
  }
  if (has(ENCODINGS_MAP, ext)) ext = splitExt(base)[1];
  ext = ext.toLowerCase();
  return has(TYPES_MAP, ext) ? TYPES_MAP[ext]! : null;
}

export function contentType(name: string): string {
  return guessType(name) ?? "application/octet-stream";
}

export const DOC_ASSET_PREFIX = "doc:";

export function docsInValue(value: unknown): MondayFile[] {
  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      return [];
    }
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return [];
  const files = (parsed as Record<string, unknown>).files;
  const out: MondayFile[] = [];
  for (const entry of Array.isArray(files) ? files : []) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
    const row = entry as Record<string, unknown>;
    if (String(row.fileType ?? "").toUpperCase() !== "MONDAY_DOC" || row.objectId === undefined || row.objectId === null) continue;
    out.push({ name: `${safeName(truthy(row.name) ? strOf(row.name) : "doc")}.md`, assetId: `${DOC_ASSET_PREFIX}${strOf(row.objectId)}`, url: null });
  }
  return out;
}
