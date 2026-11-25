import { spellingKey } from "./mapping";
import { pyRepr } from "./pyvalue";

const DIGITS = "0123456789abcdefghijklmnopqrstuvwxyz";
const WIDTH = 6;

function parse(ranking: string): [bucket: string, digits: string] {
  const bar = ranking.indexOf("|");
  const bucket = bar < 0 ? ranking : ranking.slice(0, bar);
  const rest = bar < 0 ? "" : ranking.slice(bar + 1);
  const colon = rest.indexOf(":");
  const head = colon < 0 ? rest : rest.slice(0, colon);
  const tail = colon < 0 ? "" : rest.slice(colon + 1);
  const digits = head + tail;
  if (bar < 0 || colon < 0 || [...head].length !== WIDTH || !digits) throw new Error(`not a Plaky ranking: ${pyRepr(ranking)}`);
  const lower = digits.toLowerCase();
  for (const char of lower) if (!DIGITS.includes(char)) throw new Error(`not a Plaky ranking: ${pyRepr(ranking)}`);
  return [bucket, lower];
}

function format(bucket: string, value: bigint, width: number): string {
  const digits = value.toString(36).padStart(width, "0");
  return `${bucket}|${digits.slice(0, WIDTH)}:${digits.slice(WIDTH).replace(/0+$/, "")}`;
}

function fromBase36(digits: string): bigint {
  let value = 0n;
  for (const char of digits) value = value * 36n + BigInt(DIGITS.indexOf(char));
  return value;
}

function floorDiv(a: bigint, b: bigint): bigint {
  const q = a / b;
  return a % b !== 0n && a < 0n !== b < 0n ? q - 1n : q;
}

export function rankSequence(lo: string | null, hi: string | null, count: number, avoid: ReadonlySet<string> = new Set()): string[] {
  if (count < 1) return [];
  const parsed = [lo, hi].filter((r): r is string => r !== null).map(parse);
  const buckets = new Set(parsed.map(([bucket]) => bucket));
  if (buckets.size > 1) throw new Error(`rankings from different buckets: ${pyRepr(lo)}, ${pyRepr(hi)}`);
  const bucket = [...buckets][0] ?? "0";
  const loDigits = lo !== null ? parse(lo)[1] : "";
  const hiDigits = hi !== null ? parse(hi)[1] : "";
  const narrowest = Math.max(WIDTH, loDigits.length, hiDigits.length);
  for (let width = narrowest; width < narrowest + 13; width++) {
    const low = loDigits ? fromBase36(loDigits.padEnd(width, "0")) : 0n;
    const high = hiDigits ? fromBase36(hiDigits.padEnd(width, "0")) : 36n ** BigInt(width);
    const step = floorDiv(high - low, BigInt(count + 1));
    const shifts = step < BigInt(avoid.size + 1) ? step : BigInt(avoid.size + 1);
    for (let shift = 0n; shift < shifts; shift++) {
      const ranks = Array.from({ length: count }, (_, i) => format(bucket, low + step * BigInt(i + 1) + shift, width));
      if (!ranks.some((r) => avoid.has(r))) return ranks;
    }
  }
  throw new Error(`no free ranking for ${count} group(s) between ${pyRepr(lo)} and ${pyRepr(hi)}`);
}

export type PlannedGroup = {
  title: string;
  color: string;
  ranking: string | null;
  groupId: number | null;
  renamedFrom: string | null;
};

export function plannedGroup(fields: { title: string; color: string; ranking?: string | null; groupId?: number | null; renamedFrom?: string | null }): PlannedGroup {
  return { title: fields.title, color: fields.color, ranking: fields.ranking ?? null, groupId: fields.groupId ?? null, renamedFrom: fields.renamedFrom ?? null };
}

export function groupAction(group: PlannedGroup): "rename" | "reorder" | "create" {
  if (group.renamedFrom !== null) return "rename";
  return group.groupId !== null ? "reorder" : "create";
}

export type GroupRow = {
  id: number;
  title?: string | null | undefined;
  color?: string | null | undefined;
  ranking?: string | null | undefined;
};

function isRanking(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    parse(value);
  } catch {
    return false;
  }
  return true;
}

export function planGroupWrites(wanted: readonly (readonly [title: string, color: string])[], plakyGroups: readonly GroupRow[]): PlannedGroup[] {
  const byTitle = new Map<string, GroupRow>();
  for (const candidate of plakyGroups) {
    const key = spellingKey(candidate.title || "");
    if (!byTitle.has(key)) byTitle.set(key, candidate);
  }

  const unique: [string, string][] = [];
  const seen = new Set<string>();
  for (const [title, color] of wanted) {
    const key = spellingKey(title);
    if (!seen.has(key)) {
      seen.add(key);
      unique.push([title, color]);
    }
  }
  const matched = unique.map(([title]) => byTitle.get(spellingKey(title)) ?? null);

  const rankings = plakyGroups.map((group) => group.ranking).filter(isRanking);
  if (rankings.length < plakyGroups.length || new Set(rankings.map((r) => parse(r)[0])).size > 1) {
    return unique.flatMap(([title, color], i) => (matched[i] ? [] : [plannedGroup({ title, color })]));
  }

  const rankOf = (group: GroupRow): string => group.ranking as string;
  const present = matched.filter((group): group is GroupRow => group !== null).map(rankOf);
  const inOrder = present.every((r, i) => i === present.length - 1 || r < present[i + 1]!);
  const anchors = new Map<number, string>();
  matched.forEach((group, i) => {
    if (group !== null && inOrder) anchors.set(i, rankOf(group));
  });
  const matchedGroups = new Set(matched.filter((group): group is GroupRow => group !== null));
  const others = plakyGroups.filter((g) => !matchedGroups.has(g)).map(rankOf);

  const writes: PlannedGroup[] = [];
  let index = 0;
  while (index < unique.length) {
    if (anchors.has(index)) {
      index++;
      continue;
    }
    let end = index;
    while (end < unique.length && !anchors.has(end)) end++;
    const lo = anchors.get(index - 1) ?? null;
    let hi = anchors.get(end) ?? null;
    if (lo === null && hi === null && others.length) hi = others.reduce((a, b) => (b < a ? b : a));
    const taken = new Set(plakyGroups.map(rankOf));
    const slots = rankSequence(lo, hi, end - index, taken);
    for (let i = index; i < end; i++) {
      const [title, color] = unique[i]!;
      const group = matched[i] ?? null;
      const ranking = slots[i - index]!;
      if (group === null) writes.push(plannedGroup({ title, color, ranking }));
      else writes.push(plannedGroup({ title: group.title ?? "", color: group.color || color, ranking, groupId: group.id }));
    }
    index = end;
  }
  return writes;
}
