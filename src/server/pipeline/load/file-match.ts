import { truthy } from "../transform/pystr";
import { fileKey } from "./results";
import type { FileMapping } from "./store";

export type HeldFile = { id: number; keys: Set<string> };
export type WantedFile = { assetId: string; occurrence: number; meta: readonly [name: string, size: number | null] | null };
export type FilePlace = { state: "carried"; fileId: number } | { state: "adopt"; fileId: number } | { state: "upload" } | { state: "unknown" };
export type LookAlike = { name: string; wanted: number; held: number };

export function heldFile(entry: { id: number; name?: unknown; extension?: unknown; size?: unknown }): HeldFile {
  const name = String(entry.name ?? "");
  const keys = new Set([fileKey(name, entry.size)]);
  if (truthy(entry.extension)) keys.add(fileKey(`${name}.${entry.extension}`, entry.size));
  return { id: entry.id, keys };
}

const holds = (name: string, size: number | null) => (file: HeldFile): boolean =>
  size === null ? [...file.keys].some((k) => k.startsWith(fileKey(name, null))) : file.keys.has(fileKey(name, size));

export function matchFiles(plakyItemId: number, present: readonly HeldFile[], wanted: readonly WantedFile[], mapped: readonly FileMapping[]): { places: FilePlace[]; lookAlikes: LookAlike[] } {
  const own = mapped.filter((m) => m.plakyItemId === plakyItemId);
  const slot = (assetId: string, occurrence: number): string => `${assetId}\u0000${occurrence}`;
  const mappedTo = new Map(own.map((m) => [slot(m.assetId, m.occurrence), m.plakyFileId]));
  const claimed = new Set(own.map((m) => m.plakyFileId));
  const free = present.filter((p) => !claimed.has(p.id));
  const carriedBy = (w: WantedFile): number | null => {
    const fileId = mappedTo.get(slot(w.assetId, w.occurrence));
    return w.meta !== null && fileId !== undefined && present.some((p) => p.id === fileId && holds(w.meta![0], w.meta![1])(p)) ? fileId : null;
  };
  const carried = wanted.map(carriedBy);
  const claims = new Map<string, { name: string; size: number | null; n: number }>();
  wanted.forEach((w, i) => {
    if (w.meta === null || carried[i] !== null) return;
    const key = fileKey(w.meta[0], w.meta[1]);
    claims.set(key, { name: w.meta[0], size: w.meta[1], n: (claims.get(key)?.n ?? 0) + 1 });
  });
  const lookAlikes: LookAlike[] = [];
  const unclear = new Set<string>();
  for (const [key, c] of claims) {
    const held = free.filter(holds(c.name, c.size)).length;
    if (held > 0 && held < c.n) {
      unclear.add(key);
      lookAlikes.push({ name: c.name, wanted: c.n, held });
    }
  }
  const places = wanted.map((w, i): FilePlace => {
    if (w.meta === null) return { state: "unknown" };
    const fileId = carried[i];
    if (fileId !== null && fileId !== undefined) return { state: "carried", fileId };
    if (unclear.has(fileKey(w.meta[0], w.meta[1]))) return { state: "upload" };
    const at = free.findIndex(holds(w.meta[0], w.meta[1]));
    if (at < 0) return { state: "upload" };
    const [taken] = free.splice(at, 1);
    return { state: "adopt", fileId: taken!.id };
  });
  return { places, lookAlikes };
}
