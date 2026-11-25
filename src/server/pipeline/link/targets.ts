import { isPlakyNotFound, type PlakyClient } from "../../clients/plaky";
import { type Manifest } from "../manifest";
import { cmpCodePoints } from "../transform/pyvalue";
import { readBoard, scanSpace, type Unmarked } from "./scan";
import { LinkError, type MaybePromise, type SeededBoard } from "./types";

export type MondayLookups = {
  itemIds?: (boardId: string) => MaybePromise<Iterable<string>>;
  itemBoards?: (ids: readonly string[]) => MaybePromise<ReadonlyMap<string, string>>;
};

export type ResolveOptions = MondayLookups & {
  sweepSeeds?: boolean;
  preview?: boolean;
  homes?: Map<string, number[]>;
  knownHomes?: ReadonlyMap<string, readonly number[]>;
  refused?: string[];
  gone?: Map<string, number>;
  unmarked?: Map<number, Unmarked>;
};

type Stranded = { plakyBoardId: number; count: number; total: number; owner: string };

export async function resolveTargets(plaky: PlakyClient, manifest: Manifest, space: number, options: ResolveOptions = {}): Promise<Map<string, SeededBoard>> {
  const recorded = new Map<number, string>();
  const unrecorded: string[] = [];
  const own = manifest.boards.filter((b) => !b.nested);
  for (const b of own) {
    if (b.plakyBoardId === null) unrecorded.push(b.id);
    else recorded.set(b.plakyBoardId, b.id);
  }
  const { found, held, unmarked } = await scanSpace(plaky, space, new Set(own.map((b) => b.id)), {
    skipRows: options.preview || (unrecorded.length === 0 && !options.sweepSeeds) ? new Set(recorded.keys()) : new Set(),
  });
  for (const [id, u] of unmarked) options.unmarked?.set(id, u);
  const { homes, stranded } = options.preview && options.itemIds === undefined
    ? { homes: new Map([...(options.knownHomes ?? [])].map(([id, where]) => [id, [...where]])), stranded: new Map<string, Stranded[]>() }
    : await boardsHolding(held, unrecorded, options, { recorded });
  const refuse = (message: string): void => {
    if (!options.preview) throw new LinkError(message);
    options.refused?.push(message);
  };
  for (const board of own) {
    if (board.plakyBoardId === null) {
      const strays = homes.has(board.id) ? [] : (stranded.get(board.id) ?? []);
      const stray = strays[0];
      if (stray !== undefined) {
        refuse(
          `'${board.name}' has ${stray.count} of its ${stray.total} items on Plaky board ${stray.plakyBoardId}, ` +
            `which belongs to monday board ${stray.owner} now: the items were moved in monday since. Imported again, those ${stray.count} ` +
            `would be in Plaky twice. If board ${stray.plakyBoardId} is where '${board.name}' was migrated, bring back the pairing ` +
            "that run recorded (its sync config) and run link again; if not, delete " +
            `those rows from board ${stray.plakyBoardId} in Plaky and run link again.`,
        );
        continue;
      }
      const seed = found.get(board.id);
      const where = (homes.get(board.id) ?? []).filter((id) => seed === undefined || id !== seed.plakyBoardId);
      if (seed !== undefined && where.length) {
        refuse(
          `'${board.name}' is already in Plaky on board ${where[0]}: most of its items are this board's items in monday. ` +
            `The seed imported onto board ${seed.plakyBoardId} would migrate it a second time. Delete board ` +
            `${seed.plakyBoardId} in Plaky and run link again: it then updates board ${where[0]}.`,
        );
        continue;
      }
      if (where.length > 1) {
        refuse(
          `'${board.name}' is in Plaky on ${where.length} boards (${where.join(", ")}), each holding its items. Keep one, delete ` +
            "the others in Plaky, and run link again.",
        );
        continue;
      }
      if (!where.length) continue;
      if (options.preview) options.homes?.set(board.id, where);
      else found.set(board.id, await readBoard(plaky, space, where[0]!, board.id));
      continue;
    }
    const match = found.get(board.id);
    if (match !== undefined && match.plakyBoardId === board.plakyBoardId) continue;
    const recordedBoard = await readBoard(plaky, space, board.plakyBoardId, board.id).catch((error: unknown) => {
      if (isPlakyNotFound(error)) return null;
      throw error;
    });
    if (recordedBoard === null) {
      options.gone?.set(board.id, board.plakyBoardId);
      continue;
    }
    if (match === undefined) {
      found.set(board.id, recordedBoard);
    } else if (match.plakyBoardId !== board.plakyBoardId) {
      throw new LinkError(
        `'${board.name}' is already linked to Plaky board ${board.plakyBoardId}, but a new seed was imported onto board ` +
          `${match.plakyBoardId}. Delete the duplicate board and run link again.`,
      );
    }
  }
  for (const board of manifest.boards) {
    if (!board.nested) continue;
    const parent = board.parentBoardId === null ? undefined : found.get(board.parentBoardId);
    if (parent !== undefined) found.set(board.id, { ...parent, mondayBoardId: board.id, seedItemIds: [] });
    else if (board.plakyBoardId !== null && board.parentBoardId !== null && options.gone?.has(board.parentBoardId)) options.gone.set(board.id, board.plakyBoardId);
  }
  return found;
}

export async function boardsHolding(
  held: ReadonlyMap<number, ReadonlySet<string>>,
  boardIds: readonly string[],
  lookups: MondayLookups,
  options: { recorded?: ReadonlyMap<number, string> } = {},
): Promise<{ homes: Map<string, number[]>; stranded: Map<string, Stranded[]> }> {
  const homes = new Map<string, number[]>();
  const stranded = new Map<string, Stranded[]>();
  const { itemIds, itemBoards } = lookups;
  if (itemIds === undefined || ![...held.values()].some((ids) => ids.size > 0)) return { homes, stranded };
  const mine = new Map<string, Set<string>>();
  for (const boardId of boardIds) mine.set(boardId, new Set(await itemIds(boardId)));
  const known = new Map<string, string>();
  for (const [boardId, items] of mine) for (const item of items) known.set(item, boardId);
  for (const [plakyId, ids] of [...held].sort((a, b) => a[0] - b[0])) {
    const shared = new Map([...mine].map(([boardId, items]) => [boardId, [...ids].filter((id) => items.has(id)).length]));
    if (![...shared.values()].some(Boolean)) continue;
    const owner = options.recorded?.get(plakyId);
    const counts = new Map<string, number>();
    const bump = (board: string): void => void counts.set(board, (counts.get(board) ?? 0) + 1);
    if (owner === undefined) {
      const unknown = [...ids].filter((id) => !known.has(id));
      if (unknown.length && itemBoards === undefined) throw new TypeError("boardsHolding needs itemBoards to weigh the other ids");
      for (const id of ids) {
        const board = known.get(id);
        if (board !== undefined) bump(board);
      }
      if (unknown.length && itemBoards !== undefined) for (const board of (await itemBoards(unknown)).values()) bump(board);
    }
    const total = [...counts.values()].reduce((sum, n) => sum + n, 0);
    for (const [boardId, count] of shared) {
      if (!count) continue;
      const own = mine.get(boardId)!;
      if (owner === undefined && count * 2 > total) {
        homes.set(boardId, [...(homes.get(boardId) ?? []), plakyId]);
      } else if (count * 2 > own.size) {
        const others = [...counts.keys()].filter((b) => b !== boardId);
        const best = others.reduce<string | undefined>(
          (top, b) => (top === undefined || counts.get(b)! > counts.get(top)! || (counts.get(b) === counts.get(top) && cmpCodePoints(b, top) > 0) ? b : top),
          undefined,
        );
        const holder = owner ?? best;
        if (holder !== undefined) stranded.set(boardId, [...(stranded.get(boardId) ?? []), { plakyBoardId: plakyId, count, total: own.size, owner: holder }]);
      }
    }
  }
  return { homes, stranded };
}
