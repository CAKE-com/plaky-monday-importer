import { isSeedMarker } from "../names";
import { asId } from "../transform/mapping";
import { isDict, pyStrip, truthy } from "../transform/pystr";
import type { PlakyRow } from "./compare";
import { canonicalJson } from "./ir";

export type SpareCopy = { mondayItemId: string; keep: number; copy: number; title: string };

const fieldsOf = (row: PlakyRow): Record<string, unknown> =>
  Object.fromEntries((Array.isArray(row["fields"]) ? row["fields"] : []).flatMap((f) => (isDict(f) && typeof f["key"] === "string" ? [[f["key"], f["value"]] as const] : [])));

const idsOf = (value: unknown): number[] => (Array.isArray(value) ? value.map(asId).filter((id): id is number => id !== null).sort((a, b) => a - b) : []);

const holdsAnything = (row: PlakyRow): boolean => Number(row["commentCount"] ?? 0) > 0 || Number(row["fileCount"] ?? 0) > 0;

const likeness = (row: PlakyRow): string =>
  canonicalJson({
    title: row["title"] ?? null, group: asId(row["group"]), parent: asId(row["parent"]), createdBy: asId(row["createdBy"]),
    fields: fieldsOf(row), users: idsOf(row["subscribedUsers"]), teams: idsOf(row["subscribedTeams"]),
  });

const created = (row: PlakyRow): number => {
  const at = Date.parse(String(row["createdAt"] ?? ""));
  return Number.isNaN(at) ? Number.POSITIVE_INFINITY : at;
};
const olderFirst = (a: PlakyRow, b: PlakyRow): number => created(a) - created(b) || (asId(a["id"]) ?? 0) - (asId(b["id"]) ?? 0);

export function spareCopies(listing: readonly PlakyRow[], idKey: string): { rows: PlakyRow[]; copies: SpareCopy[] } {
  const carriers = new Map<string, PlakyRow[]>();
  for (const row of listing) {
    if (truthy(row["archived"]) || truthy(row["deleted"]) || asId(row["id"]) === null) continue;
    const value = fieldsOf(row)[idKey];
    const key = typeof value === "string" ? pyStrip(value) : "";
    if (!key || isSeedMarker(key)) continue;
    carriers.set(key, [...(carriers.get(key) ?? []), row]);
  }
  const copies: SpareCopy[] = [];
  const spare = new Set<PlakyRow>();
  for (const [mondayItemId, rows] of carriers) {
    if (rows.length < 2) continue;
    const ordered = [...rows].sort(olderFirst);
    const holders = ordered.filter(holdsAnything);
    if (holders.length > 1) continue;
    const keep = holders[0] ?? ordered[0]!;
    const others = ordered.filter((row) => row !== keep);
    if (others.some((row) => likeness(row) !== likeness(keep))) continue;
    for (const row of others) {
      spare.add(row);
      copies.push({ mondayItemId, keep: asId(keep["id"])!, copy: asId(row["id"])!, title: String(row["title"] ?? "") });
    }
  }
  return { rows: listing.filter((row) => !spare.has(row)), copies };
}
