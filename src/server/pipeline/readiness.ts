import type { DiscoveredBoard, Manifest } from "./manifest";
import { isByHand } from "@/lib/people-entry";

type ReadinessItem = {
  key: string;
  board: string | null;
  text: string;
  kind: "checked" | "manual";
  done: boolean;
};

export type PlakyBoardShape = { title?: string | null | undefined; fields?: readonly { name?: string | null | undefined; type: string }[] | null | undefined };
export type GoneBoard = { gone: number };
export type Unread = { unread: string };
type PlakyTeamShape = { title?: string | null | undefined; members?: readonly unknown[] | null | undefined };

function standInProblems(teams: readonly PlakyTeamShape[], title: string): string[] {
  const found = teams.filter((t) => t.title === title);
  if (found.length !== 1) return [`${found.length} found, want 1`];
  const members = found[0]!.members?.length ?? 0;
  return members ? [`${members} member(s), want 0`] : [];
}

function boardItems(board: DiscoveredBoard, plaky: PlakyBoardShape, ticks: ReadonlySet<string>): ReadinessItem[] {
  const out: ReadinessItem[] = [];
  const title = (plaky.title ?? "").trim();
  if (!board.nested) out.push({
    key: `${board.id}:rename`, board: board.id, kind: "checked", done: title === board.name.trim(),
    text: title === board.name.trim() ? `Board renamed to "${board.name}"` : `Still called "${title || "New board"}": click the title and name it "${board.name}"`,
  });
  const fields = new Map((plaky.fields ?? []).map((f) => [f.name ?? "", f.type]));
  const seeded = [...board.columns, ...board.nestedColumns];
  const statuses = seeded.filter((c) => c.plakyType === "STATUS" && !c.importAs);
  const asTag = statuses.filter((c) => fields.get(c.fieldName) === "TAG").map((c) => c.fieldName);
  if (statuses.length) {
    out.push({
      key: `${board.id}:status-types`, board: board.id, kind: "checked", done: asTag.length === 0,
      text: asTag.length === 0
        ? "The Status field is not a Tag"
        : `Convert to Status (on each header: ⌄ → Change field type → Status → Convert): ${asTag.map((n) => `'${n}'`).join(", ")}`,
    });
  }
  for (const text of board.byHand.slice(1)) {
    const key = `${board.id}:hand:${text}`;
    out.push({ key, board: board.id, kind: "manual", done: ticks.has(key), text });
  }
  return out;
}

export function readiness(
  manifest: Manifest,
  plakyBoards: ReadonlyMap<string, PlakyBoardShape | GoneBoard | Unread>,
  teams: readonly PlakyTeamShape[] | Unread,
  ticks: ReadonlySet<string>,
  people: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {},
): ReadinessItem[] {
  const out: ReadinessItem[] = [];
  for (const board of manifest.boards) {
    const plaky = plakyBoards.get(board.id);
    if (plaky && "gone" in plaky) {
      out.push({
        key: `${board.id}:gone`, board: board.id, kind: "checked", done: false,
        text: `Plaky board ${plaky.gone} is not in this space any more: it was deleted, or moved to another space. Nothing on it can be checked.`,
      });
    } else if (plaky && "unread" in plaky) {
      out.push({ key: `${board.id}:unread`, board: board.id, kind: "checked", done: false, text: `This board could not be read from Plaky just now, so nothing on it is checked. ${plaky.unread}` });
    } else if (plaky) out.push(...boardItems(board, plaky, ticks));
  }
  const byHand = (id: string): boolean => Object.hasOwn(people, id) && isByHand(people[id]);
  const standIns = [...new Set(manifest.people.filter((p) => !byHand(p.id)).map((p) => p.placeholder).filter((t): t is string => !!t))];
  for (const title of standIns) {
    if ("unread" in teams) {
      out.push({ key: `team:${title}`, board: null, kind: "checked", done: false, text: `Stand-in team "${title}" could not be checked: Plaky's teams could not be read just now. ${teams.unread}` });
      continue;
    }
    const problems = standInProblems(teams, title);
    out.push({ key: `team:${title}`, board: null, kind: "checked", done: problems.length === 0, text: problems.length ? `Stand-in team "${title}": ${problems.join("; ")}` : `Stand-in team "${title}" exists and is empty` });
  }
  return out;
}
