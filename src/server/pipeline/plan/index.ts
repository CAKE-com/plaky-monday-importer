import type { PlakyClient } from "../../clients/plaky";
import type { BoardSync, PeopleMap } from "../config";
import type { BoardExtract } from "../extract";
import { planBoard } from "./board";
import { loadDirectory } from "./existing";
import { failureText, type BoardPlan } from "./writes";

export * from "./writes";
export * from "./compare";
export * from "./existing";
export * from "./groups";
export * from "./board";
export * from "./ir";
export * from "./copies";
export * from "./placement";
export * from "./refused";

export type ParentTitles = (mondayBoardId: string, only?: readonly string[]) => ReadonlyMap<string, string> | undefined | Promise<ReadonlyMap<string, string> | undefined>;
type PlanBoardsOptions = {
  allowDuplicateImport?: boolean; isDelta?: boolean; parentTitles?: ParentTitles; docs?: boolean; rich?: boolean; links?: boolean;
  syncPoint?: (mondayBoardId: string) => string | null | undefined;
  mondayOrder?: (mondayBoardId: string) => Promise<readonly string[]>;
};

export async function planBoards(
  read: (board: BoardSync) => Promise<BoardExtract>,
  plaky: PlakyClient,
  config: { boards: readonly BoardSync[]; people: PeopleMap },
  options: PlanBoardsOptions = {},
): Promise<{ plans: BoardPlan[]; failures: string[] }> {
  const directory = await loadDirectory(plaky);
  const plans: BoardPlan[] = [];
  const failures: string[] = [];
  const names = new Map<string, ReadonlyMap<string, string>>();
  for (const board of config.boards) {
    try {
      const extract = await read(board);
      if (!options.isDelta && !extract.isDelta) names.set(extract.board.id, new Map(extract.items.map((item) => [item.id, item.name])));
      const only = extract.isDelta ? [...new Set(extract.items.flatMap((item) => (item.parentId ? [item.parentId] : [])))] : undefined;
      const parentTitles = board.subitemsOf ? (names.get(board.subitemsOf) ?? (await options.parentTitles?.(board.subitemsOf, only))) : undefined;
      plans.push(
        await planBoard(extract, plaky, board, {
          directory,
          peopleMap: config.people,
          ...(options.allowDuplicateImport === undefined ? {} : { allowDuplicateImport: options.allowDuplicateImport }),
          ...(options.isDelta === undefined ? {} : { isDelta: options.isDelta }),
          ...(options.docs ? { docs: true } : {}),
          ...(options.rich ? { rich: true } : {}),
          ...(options.links ? { links: true } : {}),
          ...(parentTitles === undefined ? {} : { parentTitles }),
          syncPoint: options.syncPoint?.(board.mondayBoardId) ?? null,
          ...(options.mondayOrder ? { mondayOrder: () => options.mondayOrder!(board.mondayBoardId) } : {}),
        }),
      );
    } catch (error) {
      failures.push(`${board.name}: ${failureText(error)}`);
    }
  }
  return { plans, failures };
}
