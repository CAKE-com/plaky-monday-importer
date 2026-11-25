import Decimal from "decimal.js";
import type { ExtractedBoard, ExtractedGroup, ExtractedItem } from "../extract";
import { spellingKey } from "../transform/mapping";
import { plannedGroup, type PlannedGroup } from "../transform/order";
import { pyDecimal } from "../transform/pystr";
import { cmpCodePoints } from "../transform/pyvalue";
import type { ExistingItem } from "./existing";
import { GROUP_COLORS, MAX_TITLE } from "./writes";

const HEX_COLOR = /^#[0-9A-Fa-f]{6}$/;

export type PlakyGroupState = { id: number; title: string; color: string | null; ranking: string | null };

export type GroupInput = { id?: number | null | undefined; title?: string | null | undefined; color?: string | null | undefined; ranking?: string | null | undefined };

export function groupStates(listing: readonly GroupInput[]): PlakyGroupState[] {
  return listing.flatMap((group) =>
    group.id === null || group.id === undefined ? [] : [{ id: Math.trunc(group.id), title: String(group.title || ""), color: group.color ?? null, ranking: group.ranking ?? null }],
  );
}

const position = (value: string): Decimal => {
  const parsed = pyDecimal(value);
  return parsed?.kind === "num" ? parsed.value : new Decimal(Infinity);
};

function activeGroups(board: ExtractedBoard): ExtractedGroup[] {
  return board.groups.filter((group) => !group.archived).sort((a, b) => position(a.position).cmp(position(b.position)));
}

export const groupTitleFor = (title: string, suffix = ""): string => [...title].slice(0, MAX_TITLE - [...suffix].length).join("") + suffix;

export function groupTitles(board: ExtractedBoard): Map<string, string> {
  const titles = new Map<string, string>();
  const taken = new Set<string>();
  for (const group of activeGroups(board).sort((a, b) => cmpCodePoints(a.id, b.id))) {
    if (!group.title) continue;
    let [title, number] = [groupTitleFor(group.title), 2];
    while (taken.has(spellingKey(title))) [title, number] = [groupTitleFor(group.title, ` (${number})`), number + 1];
    taken.add(spellingKey(title));
    titles.set(group.id, title);
  }
  return titles;
}

export function followRenamedGroups(
  items: readonly ExtractedItem[],
  existing: ReadonlyMap<string, ExistingItem>,
  titles: ReadonlyMap<string, string>,
  plakyGroups: PlakyGroupState[],
  groupIds: Map<string, number>,
  seedGroupId: number | null,
): Map<number, string> {
  const wanted = new Map([...titles.values()].map((title) => [spellingKey(title), title]));
  const homes = new Map<string, Set<number | null>>();
  for (const item of items) {
    const title = titles.get(item.groupId ?? "") ?? item.groupTitle;
    if (!title) continue;
    if (!wanted.has(spellingKey(title))) wanted.set(spellingKey(title), title);
    const match = existing.get(item.id);
    if (match !== undefined) {
      const where = homes.get(spellingKey(title)) ?? new Set<number | null>();
      where.add(match.groupId);
      homes.set(spellingKey(title), where);
    }
  }
  const byId = new Map(plakyGroups.map((group) => [group.id, group]));
  const renamed = new Map<number, string>();
  for (const [key, where] of homes) {
    if (groupIds.has(key) || where.size !== 1) continue;
    const homeId = [...where][0];
    const group = homeId === null || homeId === undefined ? undefined : byId.get(homeId);
    if (group === undefined || group.id === seedGroupId || renamed.has(group.id) || !group.ranking) continue;
    if (wanted.has(spellingKey(group.title))) continue;
    renamed.set(group.id, group.title);
    groupIds.delete(spellingKey(group.title));
    group.title = wanted.get(key) ?? group.title;
    groupIds.set(key, group.id);
  }
  return renamed;
}

export function withRenames(
  writes: readonly PlannedGroup[],
  renamed: ReadonlyMap<number, string>,
  plakyGroups: ReadonlyMap<number, PlakyGroupState>,
  wanted: readonly (readonly [title: string, color: string])[],
): PlannedGroup[] {
  const colors = new Map(wanted.map(([title, color]) => [spellingKey(title), color]));
  const out = writes.map((write) => {
    const oldTitle = write.groupId === null ? undefined : renamed.get(write.groupId);
    return oldTitle === undefined ? write : { ...write, renamedFrom: oldTitle };
  });
  const written = new Set(writes.map((write) => write.groupId));
  for (const [groupId, oldTitle] of renamed) {
    if (written.has(groupId)) continue;
    const group = plakyGroups.get(groupId);
    if (group === undefined) throw new Error(`KeyError: ${groupId}`);
    out.push(plannedGroup({ title: group.title, color: group.color || colors.get(spellingKey(group.title)) || "", ranking: group.ranking, groupId, renamedFrom: oldTitle }));
  }
  return out;
}

export function wantedGroups(board: ExtractedBoard, titles: ReadonlyMap<string, string>, referenced: readonly string[]): [title: string, color: string][] {
  const ordered: [string, string][] = activeGroups(board).flatMap((group) => {
    const title = titles.get(group.id);
    return title === undefined ? [] : [[title, group.color] as [string, string]];
  });
  const wanted: [string, string][] = [];
  const known = new Set<string>();
  for (const [title, color] of [...ordered, ...referenced.map((t): [string, string] => [t, ""])]) {
    const key = spellingKey(title);
    if (!title || known.has(key)) continue;
    known.add(key);
    wanted.push([title, HEX_COLOR.test(color || "") ? color : (GROUP_COLORS[wanted.length % GROUP_COLORS.length] ?? "")]);
  }
  return wanted;
}
