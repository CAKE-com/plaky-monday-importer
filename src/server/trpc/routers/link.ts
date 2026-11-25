import { z } from "zod";
import { linkStep, previewLink } from "@/server/pipeline/migration";
import { router } from "../init";
import { linkPreview } from "./provision";
import { dropPlan, scanHomes, scanItemIds, withSetup } from "@/server/jobs/runner";
import { collect, depsFor, migrationProcedure } from "./shared";
import { PreconditionError } from "@/server/errors";
import { clearSyncPoints, getMigration, loadLinkConfig, loadManifest, saveLinkConfig, setSeedFailures, updateSetup } from "@/server/pipeline/store";
import { normalizeBoard } from "@/server/pipeline/extract";
import { CREATED, filterProblem, itemFilter, narrows } from "@/server/pipeline/scope";
import { changePairing, pairingOf } from "@/server/pipeline/pairing";
import { plakyFieldsFromBoard } from "@/server/pipeline/transform/mapping";

const pairingColumn = z.object({
  id: z.string(), title: z.string(), type: z.string(), state: z.enum(["paired", "skipped", "unpaired"]),
  field: z.object({ key: z.string(), name: z.string(), type: z.string() }).nullable(), labels: z.array(z.string()), labelMap: z.record(z.string(), z.string()),
});
const pairingBoard = z.object({
  mondayBoardId: z.string(), name: z.string(), plakyBoardId: z.number(), columns: z.array(pairingColumn),
  fields: z.array(z.object({ key: z.string(), name: z.string(), type: z.string(), typeLabel: z.string(), labels: z.array(z.string()) })),
});

const scopeBoard = z.object({
  mondayBoardId: z.string(), name: z.string(), groups: z.array(z.object({ id: z.string(), title: z.string() })),
  statuses: z.array(z.object({ id: z.string(), title: z.string(), labels: z.array(z.string()) })),
  dates: z.array(z.object({ id: z.string(), title: z.string() })), filter: itemFilter.nullable(),
});

async function linkedBoards(db: Parameters<typeof loadManifest>[0], migrationId: number) {
  const [loaded, manifest] = await Promise.all([loadLinkConfig(db, migrationId), loadManifest(db, migrationId)]);
  if (!loaded || !manifest) throw new PreconditionError("link the boards first: there is no pairing yet");
  return { loaded, manifest };
}

export const linkRouter = router({
  pairing: migrationProcedure.output(z.object({ boards: z.array(pairingBoard) })).query(async ({ ctx, input }) => {
    const { loaded, manifest } = await linkedBoards(ctx.db, input.migrationId);
    const { plaky } = await depsFor(ctx, input.migrationId, () => undefined);
    const linked = loaded.config.boards.flatMap((sync) => {
      const board = manifest.boards.find((b) => b.id === sync.mondayBoardId);
      return board ? [{ board, sync }] : [];
    });
    const boards = await Promise.all(linked.map(async ({ board, sync }) => pairingOf(board, sync, plakyFieldsFromBoard(await plaky.getBoard(sync.plakySpaceId, sync.plakyBoardId)))));
    return { boards };
  }),

  setPairing: migrationProcedure.input(z.object({
    mondayBoardId: z.string().max(40), columnId: z.string().max(200),
    choice: z.discriminatedUnion("kind", [z.object({ kind: z.literal("field"), key: z.string().max(200) }), z.object({ kind: z.literal("skip") }), z.object({ kind: z.literal("auto") })]),
    labels: z.record(z.string().max(500), z.string().max(500)).optional(),
  })).output(z.object({ saved: z.literal(true) })).mutation(async ({ ctx, input }) =>
    withSetup(input.migrationId, "the column pairing", async () => {
      const { loaded, manifest } = await linkedBoards(ctx.db, input.migrationId);
      const sync = loaded.config.boards.find((b) => b.mondayBoardId === input.mondayBoardId);
      const board = manifest.boards.find((b) => b.id === input.mondayBoardId);
      if (!sync || !board) throw new PreconditionError(`monday board ${input.mondayBoardId} is not linked in this migration`);
      const { plaky } = await depsFor(ctx, input.migrationId, () => undefined);
      const fields = plakyFieldsFromBoard(await plaky.getBoard(sync.plakySpaceId, sync.plakyBoardId));
      const entries = (loaded.legacy.boards as Record<string, unknown>[]);
      const next = entries.map((e) => (String(e.monday_board_id) === input.mondayBoardId ? changePairing(e, board, sync, fields, input.columnId, input.choice, input.labels) : e));
      await saveLinkConfig(ctx.db, input.migrationId, { ...loaded.legacy, boards: next });
      return { saved: true as const };
    })),

  scope: migrationProcedure.output(z.object({ boards: z.array(scopeBoard) })).query(async ({ ctx, input }) => {
    const { loaded, manifest } = await linkedBoards(ctx.db, input.migrationId);
    const { options } = await getMigration(ctx.db, input.migrationId);
    const { monday } = await depsFor(ctx, input.migrationId, () => undefined);
    const linked = loaded.config.boards.flatMap((sync) => {
      const board = manifest.boards.find((b) => b.id === sync.mondayBoardId);
      return board && !sync.subitemsOf ? [board] : [];
    });
    const read = new Map((await monday.boards(linked.map((b) => b.id))).map((raw) => [String(raw.id), raw]));
    const boards = [];
    for (const board of linked) {
      const raw = read.get(board.id);
      if (!raw) throw new PreconditionError(`monday board ${board.id} (${board.name}) is not accessible any more: read the boards again`);
      const { groups } = normalizeBoard(raw);
      boards.push({
        mondayBoardId: board.id, name: board.name, groups: groups.filter((g) => !g.archived).map((g) => ({ id: g.id, title: g.title })),
        statuses: board.columns.filter((c) => c.type === "status").map((c) => ({ id: c.id, title: c.title, labels: [...c.labels] })),
        dates: [{ id: CREATED, title: "Created in monday" }, ...board.columns.filter((c) => c.type === "date").map((c) => ({ id: c.id, title: c.title }))],
        filter: options.filters?.[board.id] ?? null,
      });
    }
    return { boards };
  }),

  setScope: migrationProcedure.input(z.object({ mondayBoardId: z.string().max(40), filter: itemFilter })).output(z.object({ saved: z.literal(true) })).mutation(async ({ ctx, input }) =>
    withSetup(input.migrationId, "the item filter", async () => {
      const { loaded, manifest } = await linkedBoards(ctx.db, input.migrationId);
      const sync = loaded.config.boards.find((b) => b.mondayBoardId === input.mondayBoardId);
      const board = manifest.boards.find((b) => b.id === input.mondayBoardId);
      if (!sync || !board) throw new PreconditionError(`monday board ${input.mondayBoardId} is not linked in this migration`);
      if (sync.subitemsOf) throw new PreconditionError("a subitem board follows its parent: filter the parent board");
      const { options } = await getMigration(ctx.db, input.migrationId);
      const others = Object.fromEntries(Object.entries(options.filters ?? {}).filter(([id]) => id !== input.mondayBoardId));
      if (narrows(input.filter)) {
        const { monday } = await depsFor(ctx, input.migrationId, () => undefined);
        const problem = filterProblem(input.filter, { groups: normalizeBoard(await monday.board(board.id)).groups, columns: board.columns });
        if (problem) throw new PreconditionError(problem);
      }
      await updateSetup(ctx.db, input.migrationId, { options: { filters: narrows(input.filter) ? { ...others, [input.mondayBoardId]: input.filter } : others } });
      await clearSyncPoints(ctx.db, input.migrationId, loaded.config.boards.filter((b) => b.mondayBoardId === input.mondayBoardId || b.subitemsOf === input.mondayBoardId).map((b) => b.mondayBoardId));
      dropPlan(input.migrationId);
      return { saved: true as const };
    })),

  dismissSeedFailures: migrationProcedure.output(z.object({ saved: z.literal(true) })).mutation(async ({ ctx, input }) => {
    await setSeedFailures(ctx.db, input.migrationId, []);
    return { saved: true as const };
  }),

  preview: migrationProcedure.output(linkPreview).mutation(async ({ ctx, input }) => {
    const deps = await depsFor(ctx, input.migrationId, () => undefined);
    return previewLink(deps, { itemIds: scanItemIds(input.migrationId, deps.monday), homes: scanHomes(input.migrationId) });
  }),

  commit: migrationProcedure.input(z.object({ force: z.boolean().default(false) })).output(z.discriminatedUnion("status", [
    z.object({ status: z.literal("linked"), boards: z.number(), deletedSeeds: z.number(), seedFailures: z.array(z.string()) }),
    z.object({ status: z.literal("blocked"), blocking: z.array(z.string()) }),
    z.object({ status: z.literal("confirm") }),
  ])).mutation(async ({ ctx, input }) => {
    const events = collect();
    const r = await withSetup(input.migrationId, "linking", async () => linkStep(await depsFor(ctx, input.migrationId, events.log), { force: input.force }));
    if (r.ok) dropPlan(input.migrationId);
    if (r.ok) return { status: "linked" as const, boards: r.boards, deletedSeeds: r.deletedSeeds, seedFailures: r.seedFailures };
    return r.reason === "blocked" ? { status: "blocked" as const, blocking: r.blocking } : { status: "confirm" as const };
  }),
});
