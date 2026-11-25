import { z } from "zod";
import { cancelResume, cancelSchedule, withSetup } from "@/server/jobs/runner";
import { PreconditionError } from "@/server/errors";
import { dbLog, finishRun, getMigration, loadLinkConfig, setStatusUnlessOtherRun, startRun } from "@/server/pipeline/store";
import { applyUndo, previewUndo, undoChangedPlaky } from "@/server/pipeline/undo";
import { router } from "../init";
import { depsFor, plakyBoardUrl, plakyLinksFor, migrationProcedure } from "./shared";

const boardInput = z.object({ mondayBoardId: z.string().regex(/^\d{1,20}$/, "a monday board id") });
const preview = z.object({
  board: z.object({ mondayBoardId: z.string(), name: z.string(), plakySpaceId: z.number(), plakyBoardId: z.number(), url: z.string().nullable() }),
  items: z.array(z.object({ mondayId: z.string(), plakyId: z.number(), title: z.string() })),
  groups: z.array(z.object({ plakyId: z.number(), title: z.string() })),
  nested: z.array(z.object({ mondayId: z.string(), plakyId: z.number(), title: z.string(), parent: z.number() })),
  worked: z.array(z.object({ mondayId: z.string(), plakyId: z.number(), title: z.string(), comments: z.number(), files: z.number() })),
  kept: z.array(z.string()),
  gone: z.array(z.string()),
});
const withUrl = <T extends { board: { plakySpaceId: number; plakyBoardId: number } }>(p: T, links: typeof plakyBoardUrl | null) => ({ ...p, board: { ...p.board, url: links ? links(p.board.plakySpaceId, p.board.plakyBoardId) : null } });

export const undoRouter = router({
  boards: migrationProcedure.output(z.array(z.object({ mondayBoardId: z.string(), name: z.string(), applied: z.boolean() }))).query(async ({ ctx, input }) =>
    ((await loadLinkConfig(ctx.db, input.migrationId))?.config.boards ?? []).map((b) => ({ mondayBoardId: b.mondayBoardId, name: b.name, applied: b.applied }))),

  preview: migrationProcedure.input(boardInput).output(preview).mutation(async ({ ctx, input }) =>
    withUrl(await previewUndo(ctx.db, input.migrationId, (await depsFor(ctx, input.migrationId, () => undefined)).plaky, input.mondayBoardId), await plakyLinksFor(ctx.db, input.migrationId))),

  commit: migrationProcedure.input(boardInput.extend({
    confirm: z.string().max(300),
    expected: z.object({ items: z.array(z.number().int().positive()).max(100_000), groups: z.array(z.number().int().positive()).max(10_000) }),
  })).output(preview.extend({ runId: z.number(), deletedItems: z.number(), deletedNested: z.number(), deletedGroups: z.number(), failures: z.array(z.string()), reset: z.boolean(), scheduleCancelled: z.boolean() })).mutation(async ({ ctx, input }) =>
    withSetup(input.migrationId, "an undo", async () => {
      await getMigration(ctx.db, input.migrationId);
      const loaded = await loadLinkConfig(ctx.db, input.migrationId);
      if (!loaded) throw new PreconditionError("link first: this migration has no config");
      const name = loaded.config.boards.find((b) => b.mondayBoardId === input.mondayBoardId)?.name;
      if (name === undefined || input.confirm.trim() !== name.trim()) throw new PreconditionError(name === undefined ? `monday board ${input.mondayBoardId} is not linked in this migration` : `type the board's name, "${name}", to confirm`);
      const runId = await startRun(ctx.db, input.migrationId, "undo");
      const { log, flush } = dbLog(ctx.db, runId);
      try {
        log({ level: "info", code: "undo.started", message: `Undo of monday board ${input.mondayBoardId} started.`, data: { mondayBoardId: input.mondayBoardId } });
        const r = await applyUndo(ctx.db, input.migrationId, (await depsFor(ctx, input.migrationId, () => undefined)).plaky, input.mondayBoardId, input.confirm, log, input.expected, String(runId));
        log({ level: "info", code: "undo.finished", message: `Deleted ${r.deletedItems} item(s)${r.deletedNested ? `, ${r.deletedNested} nested subitem(s)` : ""} and ${r.deletedGroups} group(s); ${r.kept.length} kept, ${r.failures.length} failed.` });
        await cancelResume(ctx.db, input.migrationId);
        const deleted = undoChangedPlaky(r);
        const scheduleCancelled = deleted && await cancelSchedule(ctx.db, input.migrationId);
        if (deleted && (await getMigration(ctx.db, input.migrationId)).status === "completed") await setStatusUnlessOtherRun(ctx.db, input.migrationId, "linked", runId);
        await flush();
        await finishRun(ctx.db, runId, r.failures.length ? "failed" : "succeeded", { counts: { deletedItems: r.deletedItems, deletedNested: r.deletedNested, deletedGroups: r.deletedGroups, kept: r.kept.length, failures: r.failures.length, undone: deleted ? 1 : 0 } });
        return { ...withUrl(r, await plakyLinksFor(ctx.db, input.migrationId)), runId, scheduleCancelled };
      } catch (error) {
        log({ level: "error", code: "undo.crashed", message: (error instanceof Error ? error.message : String(error)).slice(0, 500) });
        await flush();
        await finishRun(ctx.db, runId, "failed").catch(() => undefined);
        throw error;
      }
    })),
});
