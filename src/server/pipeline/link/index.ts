import { isRateLimited, type PlakyClient } from "../../clients/plaky";
import { type PeopleMap, type SyncConfig } from "../config";
import type { PipelineLog } from "../events";
import { type Manifest } from "../manifest";
import { MONDAY_ID_FIELD } from "../names";
import { loadDirectory } from "../plan";
import { UserDirectory } from "../transform/people";

import { buildConfig, toSyncConfig } from "./config";
import { pairBoards } from "./pairing";
import { checkPeople, peopleWithStandIns } from "./people";
import type { Unmarked } from "./scan";
import { resolveTargets, type ResolveOptions } from "./targets";
import { RATE_LIMITED, isReady, type BoardLink, type JsonObject, type LegacyConfig, type LinkResult, type SeededBoard } from "./types";

export * from "./types";
export * from "./scan";
export * from "./targets";
export * from "./pairing";
export * from "./people";
export * from "./config";

type LinkOptions = ResolveOptions & {
  directory?: UserDirectory;
  people?: PeopleMap | null;
  comments?: boolean;
  files?: boolean;
  subscribers?: boolean;
  log?: PipelineLog;
};

type LinkOutcome = {
  seeded: Map<string, SeededBoard>;
  gone: Map<string, number>;
  unmarked: Map<number, Unmarked>;
  result: LinkResult;
  blocking: string[];
  peopleWarnings: string[];
  people: PeopleMap | null;
  built: { config: LegacyConfig; syncConfig: SyncConfig } | null;
};

export async function linkManifest(
  plaky: PlakyClient,
  manifest: Manifest,
  space: number,
  previousConfig: JsonObject | null,
  options: LinkOptions = {},
): Promise<LinkOutcome> {
  const log = options.log ?? (() => undefined);
  const gone = new Map<string, number>();
  const unmarked = new Map<number, Unmarked>();
  const seeded = await resolveTargets(plaky, manifest, space, { ...options, sweepSeeds: options.sweepSeeds ?? !options.preview, gone, unmarked });
  for (const [boardId, plakyBoardId] of gone) {
    const board = manifest.boards.find((b) => b.id === boardId);
    if (board?.nested) continue;
    const name = board?.name ?? boardId;
    const again = seeded.get(boardId);
    log({
      level: "warn",
      code: "link.board_gone",
      board: name,
      message: again
        ? `${name}: Plaky board ${plakyBoardId} is not in space ${space} any more (deleted, or moved to another space); the seed imported again on board ${again.plakyBoardId} takes its place.`
        : `${name}: Plaky board ${plakyBoardId} is not in space ${space} any more (deleted, or moved to another space). Import its file again to set it up again.`,
    });
  }
  for (const board of manifest.boards) {
    const found = seeded.get(board.id);
    if (!board.nested && board.plakyBoardId === null && found !== undefined && found.seedItemIds.length === 0) {
      log({
        level: "info",
        code: "link.already_in_plaky",
        board: board.name,
        message: `${board.name}: already in Plaky on board ${found.plakyBoardId} (most of its items are this board's items in monday), so it is paired with that board again.`,
      });
    }
  }

  const result = pairBoards(manifest, seeded, previousConfig);
  const blocking: string[] = [];
  for (const link of result.links) {
    for (const problem of link.unmatched) {
      blocking.push(problem);
      log({ level: "error", code: "link.unmatched", board: link.name, message: problem });
    }
    for (const warning of link.warnings) log({ level: "warn", code: "link.field_warning", board: link.name, message: warning });
    if (link.mondayIdKey === null) {
      const message = `no '${MONDAY_ID_FIELD}' field: re-runs would duplicate every item`;
      blocking.push(`${link.name}: ${message}`);
      log({ level: "error", code: "link.no_monday_id", board: link.name, message });
    }
  }
  for (const [id, name] of result.missing) log({ level: "info", code: "link.missing", board: name, message: `${name} (${id}): no seeded Plaky board found yet` });

  if (!result.links.length) {
    log({ level: "error", code: "link.nothing_linked", message: "Nothing linked. Import the seed CSVs from the blueprint first." });
    return { seeded, gone, unmarked, result, blocking, peopleWarnings: [], people: (previousConfig?.people ?? null) as PeopleMap | null, built: null };
  }

  let people = (previousConfig?.people ?? options.people ?? null) as PeopleMap | null;
  let peopleWarnings: string[] = [];
  if (manifest.people.length) {
    const directory = options.directory ?? (await loadDirectory(plaky));
    const [problems, warnings] = checkPeople(manifest, directory, people);
    peopleWarnings = warnings;
    people = peopleWithStandIns(manifest, directory, people);
    for (const problem of problems) {
      blocking.push(problem);
      log({ level: "error", code: "link.people_problem", message: problem });
    }
    for (const warning of warnings) log({ level: "warn", code: "link.people_warning", message: warning });
  }

  const outcome: LinkOutcome = { seeded, gone, unmarked, result, blocking, peopleWarnings, people, built: null };
  if (!result.links.every(isReady) || blocking.length) return outcome;
  const config = buildConfig(result.links, space, people, {
    previous: previousConfig,
    ...(options.comments === undefined ? {} : { comments: options.comments }),
    ...(options.files === undefined ? {} : { files: options.files }),
    ...(options.subscribers === undefined ? {} : { subscribers: options.subscribers }),
  });
  try {
    outcome.built = { config, syncConfig: toSyncConfig(config) };
  } catch (error) {
    blocking.push(error instanceof Error ? error.message : String(error));
  }
  return outcome;
}

export function recordPairings(manifest: Manifest, links: readonly BoardLink[], gone: ReadonlyMap<string, number> = new Map()): Manifest {
  const byMonday = new Map(links.map((link) => [link.mondayBoardId, link.plakyBoardId]));
  return {
    ...manifest,
    boards: manifest.boards.map((board) => (byMonday.has(board.id) ? { ...board, plakyBoardId: byMonday.get(board.id)! } : gone.has(board.id) ? { ...board, plakyBoardId: null } : board)),
  };
}

export async function deleteSeeds(plaky: PlakyClient, space: number, links: readonly BoardLink[]): Promise<{ deleted: number; failures: string[] }> {
  let deleted = 0;
  const failures: string[] = [];
  const seeds = links.reduce((sum, link) => sum + link.seedItemIds.length, 0);
  for (const link of links) {
    for (const itemId of link.seedItemIds) {
      try {
        await plaky.deleteItem(space, link.plakyBoardId, itemId);
        deleted++;
      } catch (error) {
        if (isRateLimited(error)) {
          failures.push(`${seeds - deleted} seed row(s) remain: ${RATE_LIMITED}`);
          return { deleted, failures };
        }
        failures.push(`${link.name}: seed item ${itemId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  return { deleted, failures };
}
