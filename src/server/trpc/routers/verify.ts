import { and, desc, eq, gt, inArray, isNotNull } from "drizzle-orm";
import { z } from "zod";
import { migrationBoards, migrationRuns } from "@/db/schema";
import { withSetup } from "@/server/jobs/runner";
import { verifyStep } from "@/server/pipeline/migration";
import { getMigration } from "@/server/pipeline/store";
import { clearSyncPoints, finishRun, setStatusUnlessOtherRun, startRun } from "@/server/pipeline/store";
import { changesPlan, shortAtVerify } from "@/server/pipeline/changes";
import { PreconditionError } from "@/server/errors";
import type { Db } from "@/db/client";
import { receiptJson } from "@/server/pipeline/verify";
import { receiptSchema } from "@/lib/reports";
import { receiptFreshness, receiptFreshnessSchema, stampOf } from "@/lib/receipt-envelope";
import { currentScope, stampedReceipt } from "@/server/pipeline/receipt-scope";
import { router } from "../init";
import { depsFor, migrationProcedure, plakyLinksFor } from "./shared";
import { runSchema } from "./run";

async function changesNow(db: Db, migrationId: number): Promise<{ full: string[]; unsynced: string[] } | null> {
  try {
    const { full, unsynced } = await changesPlan(db, migrationId);
    const names = new Map((await db.select().from(migrationBoards).where(eq(migrationBoards.migrationId, migrationId))).map((b) => [b.mondayBoardId, b.mondayBoardName]));
    return { full: full.map((id) => names.get(id) ?? id), unsynced: unsynced.map((id) => names.get(id) ?? id) };
  } catch (error) {
    if (error instanceof PreconditionError) return null;
    throw error;
  }
}

export const verifyRouter = router({
  summary: migrationProcedure.output(z.object({
    migrationName: z.string(), receipt: receiptSchema.nullable(), receiptRunId: z.number().nullable(), run: runSchema.nullable(), links: z.array(z.object({ name: z.string(), url: z.string() })),
    receiptAt: z.number().nullable(),
    changes: z.object({ full: z.array(z.string()), unsynced: z.array(z.string()) }).nullable(),
    undoneAfter: z.boolean(),
    checkedAt: z.number().nullable(), sourceReadAt: z.number().nullable(), writtenAt: z.number().nullable(),
    scopeFingerprint: z.string().nullable(),
    freshness: receiptFreshnessSchema,
  })).query(async ({ ctx, input }) => {
    const migration = await getMigration(ctx.db, input.migrationId);
    const links = await plakyLinksFor(ctx.db, input.migrationId);
    const ofMigration = and(eq(migrationRuns.migrationId, input.migrationId), inArray(migrationRuns.kind, ["apply", "verify"]));
    const row = (await ctx.db.select().from(migrationRuns).where(ofMigration).orderBy(desc(migrationRuns.id)).limit(1))[0];
    const receipts = await ctx.db.select({ id: migrationRuns.id, receipt: migrationRuns.receipt, finishedAt: migrationRuns.finishedAt }).from(migrationRuns)
      .where(and(ofMigration, isNotNull(migrationRuns.receipt))).orderBy(desc(migrationRuns.id)).limit(10);
    const withReceipt = receipts.map((r) => ({ id: r.id, at: r.finishedAt?.getTime() ?? null, parsed: receiptSchema.safeParse(r.receipt), stamp: stampOf(r.receipt) })).find((p) => p.parsed.success);
    const receipt = withReceipt?.parsed.data ?? null;
    const stamp = withReceipt?.stamp ?? null;
    const at = (iso: string | undefined): number | null => (iso === undefined ? null : Date.parse(iso));
    const undos = await ctx.db.select({ id: migrationRuns.id, counts: migrationRuns.counts }).from(migrationRuns)
      .where(and(eq(migrationRuns.migrationId, input.migrationId), eq(migrationRuns.kind, "undo"), gt(migrationRuns.id, Math.max(withReceipt?.id ?? 0, row?.id ?? 0))));
    const undoneAfter = undos.some((u) => (u.counts?.undone === undefined ? (u.counts?.deletedItems ?? 0) + (u.counts?.deletedGroups ?? 0) > 0 : u.counts.undone > 0));
    return {
      migrationName: migration.name,
      receipt,
      receiptRunId: withReceipt?.id ?? null,
      receiptAt: withReceipt?.at ?? null,
      run: row ? { id: row.id, kind: row.kind, status: row.status, plannedWrites: row.plannedWrites, counts: row.counts, startedAt: row.startedAt.getTime(), finishedAt: row.finishedAt?.getTime() ?? null } : null,
      links: migration.plakySpaceId === null || !links ? [] : (receipt?.boards ?? []).map((b) => ({ name: b.name, url: links(migration.plakySpaceId!, b.plaky_board_id) })),
      changes: await changesNow(ctx.db, input.migrationId),
      undoneAfter,
      checkedAt: at(stamp?.checked_at), sourceReadAt: at(stamp?.source_read_at), writtenAt: at(stamp?.written_at), scopeFingerprint: stamp?.scope.fingerprint ?? null,
      freshness: receiptFreshness({
        checked: receipt?.boards ?? null, stamp, receiptRunId: withReceipt?.id ?? null, latestRunId: row?.id ?? null, undoneAfter,
        scope: await currentScope(ctx.db, input.migrationId),
      }),
    };
  }),

  run: migrationProcedure.output(receiptSchema).mutation(async ({ ctx, input }) => {
    return withSetup(input.migrationId, "verification", async () => {
      const deps = await depsFor(ctx, input.migrationId, () => undefined);
      const monday = deps.monday;
      const runId = await startRun(ctx.db, input.migrationId, "verify");
      try {
        const sourceReadAt = Date.now();
        const report = await verifyStep(deps);
        await clearSyncPoints(ctx.db, input.migrationId, shortAtVerify(report));
        const receipt = receiptSchema.parse(receiptJson(report));
        const stored = await stampedReceipt(ctx.db, input.migrationId, receipt, { sourceReadAt, checkedAt: Date.now() });
        await finishRun(ctx.db, runId, receipt.ok ? "succeeded" : "failed", { receipt: stored, counts: { writes: 0, mondayCalls: monday.calls } });
        const { status } = await getMigration(ctx.db, input.migrationId);
        if (status === "completed" && !receipt.ok) await setStatusUnlessOtherRun(ctx.db, input.migrationId, "failed");
        if (status === "failed" && receipt.ok) await setStatusUnlessOtherRun(ctx.db, input.migrationId, "completed");
        return receipt;
      } catch (error) {
        await finishRun(ctx.db, runId, "failed", { counts: { mondayCalls: monday.calls } });
        throw error;
      }
    });
  }),
});
