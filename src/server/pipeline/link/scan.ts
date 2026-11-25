import { PAGE_CAP, PlakyDecodeError, type PlakyClient } from "../../clients/plaky";
import { type Manifest } from "../manifest";
import { MONDAY_ID_FIELD, isSeedMarker, markerBoardId } from "../names";
import { MAX_PLAKY_PAGE_SIZE } from "../plan";
import { asId, normalizeTitle, plakyFieldsFromBoard } from "../transform/mapping";
import { sortedStrings } from "../transform/pyvalue";
import { LinkError, type SeededBoard } from "./types";

const seedRowGroup = (data: { group?: unknown }): number | null => asId(data.group);

export async function scanSpace(
  plaky: PlakyClient,
  space: number,
  wanted: ReadonlySet<string> | null = null,
  options: { skipRows?: ReadonlySet<number> } = {},
): Promise<{ found: Map<string, SeededBoard>; held: Map<number, Set<string>>; unmarked: Map<number, Unmarked> }> {
  const skipRows = options.skipRows ?? new Set<number>();
  const found = new Map<string, SeededBoard>();
  const held = new Map<number, Set<string>>();
  const unmarked = new Map<number, Unmarked>();
  for (const board of await plaky.collect((page) => plaky.listBoards(space, { page }))) {
    const boardId = board.id;
    const fields = plakyFieldsFromBoard(board);
    const idFields = fields.filter((f) => normalizeTitle(f.name) === normalizeTitle(MONDAY_ID_FIELD));
    if (idFields.length > 1) {
      throw new LinkError(
        `Plaky board ${boardId} has multiple fields named '${MONDAY_ID_FIELD}' after normalization. Rename or remove the duplicate before linking.`,
      );
    }
    const idKey = idFields[0]?.key;
    if (idKey === undefined || skipRows.has(boardId)) continue;

    const markers = new Set<string>();
    const looseMarkers = new Set<string>();
    let seedTitled = 0;
    const seeds: number[] = [];
    const seedGroups = new Set<number | null>();
    const mondayIds = held.get(boardId) ?? new Set<string>();
    held.set(boardId, mondayIds);
    for (let page = 1; ; page++) {
      if (page > PAGE_CAP) throw new PlakyDecodeError(`paging exceeded ${PAGE_CAP} pages`);
      const got = await plaky.listItems(space, boardId, { page, pageSize: MAX_PLAKY_PAGE_SIZE, subitemsBehaviour: "EXCLUDE" });
      for (const item of got.data) {
        const value = (item.fields ?? []).find((f) => f.key === idKey)?.value;
        if (isSeedMarker(value)) {
          markers.add(markerBoardId(String(value)));
          seeds.push(item.id);
          seedGroups.add(seedRowGroup(item));
        } else if (typeof value === "string" && value.trim()) {
          const loose = /^seed:(\d+(?::level\d+)?)$/.exec(value.toLowerCase().replace(/\s+/g, ""));
          if (loose) looseMarkers.add(loose[1]!);
          else mondayIds.add(value.trim());
        }
        if (String(item.title ?? "").startsWith(SEED_TITLE_PREFIX)) seedTitled++;
      }
      if (!got.hasMore) break;
    }
    if (markers.size === 0) unmarked.set(boardId, { title: String(board.title ?? ""), seedTitled, looseMarkers: [...looseMarkers], rows: mondayIds.size });
    if (wanted !== null && ![...markers].some((m) => wanted.has(m))) continue;
    if (markers.size === 0) continue;

    if (markers.size > 1) {
      throw new LinkError(
        `Plaky board ${boardId} carries seed rows for ${markers.size} monday boards (${sortedStrings(markers).join(", ")}). ` +
          "Each monday board needs a Plaky board of its own, and a subitem board especially: its columns are not the parent board's. " +
          "Delete this board, import one CSV per board, and run link again.",
      );
    }
    const marker = [...markers][0]!;
    const earlier = found.get(marker);
    if (earlier !== undefined) {
      throw new LinkError(
        `monday board ${marker} is seeded onto two Plaky boards (${earlier.plakyBoardId} and ${boardId}). Delete the wrong one and run link again.`,
      );
    }
    found.set(marker, {
      plakyBoardId: boardId,
      mondayBoardId: marker,
      title: String(board.title ?? ""),
      fields,
      seedItemIds: seeds,
      seedGroupId: seedGroups.size === 1 ? [...seedGroups][0]! : null,
    });
  }
  return { found, held, unmarked };
}

const SEED_TITLE_PREFIX = "__MPS_SEED__";

export type Unmarked = { title: string; seedTitled: number; looseMarkers: string[]; rows: number };

type HintKind = "loose-marker" | "cleared-marker" | "moved-before";
type BoardHint = { id: string; name: string; plakyBoardId: number; kind: HintKind; text: string };

export function boardHints(manifest: Manifest, missing: readonly string[], unmarked: ReadonlyMap<number, Unmarked>, recorded: ReadonlySet<number>, homes: ReadonlyMap<string, readonly number[]> = new Map()): BoardHint[] {
  const out: BoardHint[] = [];
  for (const id of missing) {
    const board = manifest.boards.find((b) => b.id === id);
    if (!board) continue;
    for (const [plakyBoardId, u] of unmarked) {
      if (recorded.has(plakyBoardId)) continue;
      if (u.looseMarkers.includes(id)) {
        out.push({ id, name: board.name, plakyBoardId, kind: "loose-marker", text: `Plaky board ${plakyBoardId} carries this board's seed marker in another spelling: set its Monday ID cell to exactly "seed:${id}", and do not import the file again` });
      } else if (u.seedTitled > 0 && u.looseMarkers.length === 0 && u.rows === 0 && normalizeTitle(u.title) !== normalizeTitle(board.name)) {
        out.push({ id, name: board.name, plakyBoardId, kind: "cleared-marker", text: `Plaky board ${plakyBoardId} ("${u.title}") looks like a seed import whose Monday ID cell was edited or cleared: if it is this board's, set the cell of its "${SEED_TITLE_PREFIX} 1" row to "seed:${id}" instead of importing again` });
      } else if (u.rows > 0 && (homes.get(id) ?? []).includes(plakyBoardId)) {
        out.push({ id, name: board.name, plakyBoardId, kind: "moved-before", text: `Already in Plaky from an earlier move: the board called "${u.title || "New board"}" holds its ${u.rows} item(s). Its file is not offered again; "Link with the boards in Plaky" carries on with that board` });
      }
    }
  }
  return out;
}

export async function readBoard(plaky: PlakyClient, space: number, boardId: number, mondayBoardId: string): Promise<SeededBoard> {
  const board = await plaky.getBoard(space, boardId);
  return { plakyBoardId: boardId, mondayBoardId, title: String(board.title ?? ""), fields: plakyFieldsFromBoard(board), seedItemIds: [], seedGroupId: null };
}
