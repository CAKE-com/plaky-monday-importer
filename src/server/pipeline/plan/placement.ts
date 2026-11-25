import { asId, spellingKey } from "../transform/mapping";
import type { PlakyRow } from "./compare";
import type { ExistingItem } from "./existing";
import type { BoardPlan, PlannedWrite } from "./writes";

export type PlacedRow = { mondayItemId: string; itemId: number; groupId: number | null; ranking: string };
export type Placement = { order: string[]; rows: PlacedRow[]; scope: "board" | "landed" };
export type ItemMove = { mondayItemId: string; itemId: number; groupId: number; fromGroupId: number | null };

const MOVED_RANKING = "0|hzzzzz:";

const rankingOf = (row: PlakyRow): string | null => (typeof row["ranking"] === "string" && row["ranking"] !== "" ? row["ranking"] : null);

export function rankings(listing: readonly PlakyRow[]): Map<number, string> {
  const ranked = listing.every((row) => rankingOf(row) !== null);
  const found = new Map<number, string>();
  for (const [at, row] of listing.entries()) {
    const id = asId(row["id"]);
    if (id !== null) found.set(id, ranked ? rankingOf(row)! : `\u0001${String(at).padStart(9, "0")}`);
  }
  return found;
}

export const rising = (ranks: readonly string[]): boolean => ranks.every((rank, at) => at === 0 || ranks[at - 1]! < rank);

export function placedRows(listing: readonly PlakyRow[], existing: ReadonlyMap<string, ExistingItem>): PlacedRow[] {
  const ranks = rankings(listing);
  return [...existing].map(([mondayItemId, row]) => ({ mondayItemId, itemId: row.itemId, groupId: row.groupId, ranking: ranks.get(row.itemId) ?? "" }));
}

export function inMondayOrder<T extends { mondayItemId: string }>(writes: readonly T[], order: readonly string[] | undefined): T[] {
  if (!order) return [...writes];
  const at = new Map(order.map((id, index) => [id, index]));
  return [...writes].sort((a, b) => (at.get(a.mondayItemId) ?? order.length) - (at.get(b.mondayItemId) ?? order.length));
}

export const changesGroup = (write: Pick<PlannedWrite, "existingItemId" | "existingGroupId" | "groupTitle">, groupIds: ReadonlyMap<string, number>): boolean =>
  Boolean(write.existingItemId && write.groupTitle) && write.existingGroupId !== (groupIds.get(spellingKey(write.groupTitle!)) ?? null);

export function groupTargets(writes: readonly Pick<PlannedWrite, "mondayItemId" | "groupTitle">[], groupIds: ReadonlyMap<string, number>, pending = false): Map<string, number> {
  const standIns = new Map<string, number>();
  const targets = new Map<string, number>();
  for (const write of writes) {
    if (!write.groupTitle) continue;
    const key = spellingKey(write.groupTitle);
    let groupId = groupIds.get(key);
    if (groupId === undefined && pending) {
      groupId = standIns.get(key) ?? -(standIns.size + 1);
      standIns.set(key, groupId);
    }
    if (groupId !== undefined) targets.set(write.mondayItemId, groupId);
  }
  return targets;
}

export function itemMoves(order: readonly string[], rows: readonly PlacedRow[], groups: ReadonlySet<number> | null = null, targets: ReadonlyMap<string, number> = new Map()): ItemMove[] {
  const position = new Map(order.map((id, at) => [id, at]));
  const goal = (row: PlacedRow): number | null => targets.get(row.mondayItemId) ?? row.groupId;
  const arriving = rows.flatMap((row) => {
    const groupId = goal(row);
    return groupId !== null && groupId !== row.groupId ? [groupId] : [];
  });
  const scope = groups === null ? null : new Set([...groups, ...arriving]);
  const byGroup = new Map<number, PlacedRow[]>();
  for (const row of rows) {
    const groupId = goal(row);
    if (groupId === null || !position.has(row.mondayItemId) || (scope !== null && !scope.has(groupId))) continue;
    byGroup.set(groupId, [...(byGroup.get(groupId) ?? []), row]);
  }
  const moves: ItemMove[] = [];
  for (const [groupId, members] of byGroup) {
    const wanted = [...members].sort((a, b) => position.get(a.mondayItemId)! - position.get(b.mondayItemId)!);
    const arrives = (row: PlacedRow): boolean => row.groupId !== groupId;
    const after = (moved: PlacedRow | null): string[] => wanted.map((row) => (arrives(row) || row === moved ? MOVED_RANKING : row.ranking));
    const last = wanted[wanted.length - 1]!;
    const placed = !rising(after(null)) && last.ranking !== MOVED_RANKING && rising(after(last)) ? last : null;
    for (const row of wanted) if (arrives(row) || row === placed) moves.push({ mondayItemId: row.mondayItemId, itemId: row.itemId, groupId, fromGroupId: row.groupId });
  }
  return moves;
}

export function plannedMoves(plan: Pick<BoardPlan, "placement" | "writes" | "groupIds">, rebuilt: ReadonlySet<string> = new Set()): number {
  const placement = plan.placement;
  if (!placement) return 0;
  const targets = groupTargets(plan.writes, plan.groupIds, true);
  const landing = inMondayOrder(plan.writes, placement.order)
    .filter((write) => !write.existingItemId || rebuilt.has(write.mondayItemId))
    .map((write, at) => ({ mondayItemId: write.mondayItemId, itemId: 0, groupId: targets.get(write.mondayItemId) ?? null, ranking: `\u0000${String(at).padStart(9, "0")}` }));
  const landed = new Set(landing.map((row) => row.mondayItemId));
  const groups = placement.scope === "landed" ? new Set(landing.flatMap((row) => (row.groupId === null ? [] : [row.groupId]))) : null;
  return itemMoves(placement.order, [...landing, ...placement.rows.filter((row) => !landed.has(row.mondayItemId))], groups, targets).length;
}
