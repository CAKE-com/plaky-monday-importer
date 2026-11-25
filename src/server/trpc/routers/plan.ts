import { z } from "zod";
import { commentChecks, commentsToWrite, filesToUpload, writeAction } from "@/server/pipeline/plan";
import type { PlanStepResult } from "@/server/pipeline/migration";
import { PLAN_MAX_AGE_MS, dropPlan, dryRun, finishPlanRun, lastPlan, withSetup } from "@/server/jobs/runner";
import { clearSyncPoints, finishRun, getMigration, loadLinkConfig, loadManifest, mondayCallsOn, mondayTierOf, planSetup, updateSetup } from "@/server/pipeline/store";
import { PreconditionError } from "@/server/errors";
import { dailyLimit } from "@/lib/monday-budget";
import { planDetails, planSummary, estimateMinutes, type PlanSummary } from "@/lib/reports";
import { skippedByChoice } from "@/lib/outside";
import { dropped } from "@/server/pipeline/manifest";
import { migrationRuns } from "@/db/schema";
import { and, desc, eq } from "drizzle-orm";
import { router } from "../init";
import { migrationProcedure, clientsOf } from "./shared";
import { runStatus } from "./run";

function summarizePlan(planned: PlanStepResult, notCarried: ReadonlyMap<string, ReadonlySet<string>>): PlanSummary {
  return {
    at: Date.now(),
    boards: planned.plans.map((p) => {
      let creates = 0, updates = 0, unchanged = 0, drifted = 0, notCarriedValues = 0;
      for (const w of p.writes) {
        const a = writeAction(w);
        if (a === "create") creates++;
        else if (a === "update") updates++;
        else unchanged++;
        if (w.drifted) drifted++;
        notCarriedValues += w.notCarried.length;
      }
      return {
        name: p.mondayBoardName, mondayBoardId: p.config.mondayBoardId, creates, updates, unchanged, drifted, orphans: p.orphans.length, groupWrites: p.groupWrites.length,
        comments: commentsToWrite(p), files: filesToUpload(p), uncarried: [...p.uncarried], notCarriedValues, archivedGroups: [...p.archivedGroups],
        docExports: [...p.files.values()].reduce((n, f) => n + f.assets.filter((a) => a.assetId?.startsWith("doc:")).length, 0),
        ...(p.outOfScope ? { outOfScope: p.outOfScope } : {}),
        ...(p.archivedCarried ? { archivedCarried: p.archivedCarried } : {}),
        ...(p.deeper ? { deeper: p.deeper.map((d) => `${d.name} (${d.id}), level ${d.level}`) } : {}),
        skippedByChoice: skippedByChoice(p.fieldMap.skipped, notCarried.get(p.config.mondayBoardId) ?? new Set()),
        notes: p.notes.filter((note) => !note.startsWith("People: ") && !note.startsWith("   ! ")),
      };
    }),
    plannedWrites: planned.plannedWrites,
    estimateMinutes: estimateMinutes(planned.plannedWrites + planned.plans.reduce((n, p) => n + commentChecks(p), 0)),
    failures: planned.failures,
  };
}

const held = z.object({ until: z.number() }).nullable();
function heldUntil(migrationId: number): { until: number } | null {
  const plan = lastPlan(migrationId);
  return plan ? { until: plan.at + PLAN_MAX_AGE_MS } : null;
}

export const planRouter = router({
  run: migrationProcedure.output(planSummary.extend({ held })).mutation(async ({ ctx, input }) => {
    const setup = planSetup(await getMigration(ctx.db, input.migrationId));
    const { planned, runId, mondayCalls } = await dryRun(ctx.db, input.migrationId, await clientsOf(ctx, input.migrationId));
    try {
      const manifest = await loadManifest(ctx.db, input.migrationId);
      const notCarried = new Map((manifest?.boards ?? []).map((b) => [b.id, new Set(dropped(b).map((c) => c.id))]));
      const summary = { ...summarizePlan(planned, notCarried), mondayCalls, setup };
      await finishPlanRun(ctx.db, runId, planned.plannedWrites, summary, mondayCalls);
      return { ...summary, held: heldUntil(input.migrationId) };
    } catch (error) {
      await finishRun(ctx.db, runId, "failed").catch(() => undefined);
      throw error;
    }
  }),

  latest: migrationProcedure.output(z.object({
    summary: planSummary.nullable(), latestRun: z.object({ at: z.number(), status: runStatus }).nullable(), prune: z.boolean(), recreateDrifted: z.boolean(), carryArchived: z.boolean(), mondayCallsToday: z.number(), held,
    stale: z.boolean(),
    mondayLimit: z.object({ calls: z.number(), plan: z.string(), reason: z.string().nullable() }),
  })).query(async ({ ctx, input }) => {
    const migration = await getMigration(ctx.db, input.migrationId);
    const plans = (status?: "succeeded") => ctx.db.select().from(migrationRuns)
      .where(and(eq(migrationRuns.migrationId, input.migrationId), eq(migrationRuns.kind, "plan"), ...(status ? [eq(migrationRuns.status, status)] : []))).orderBy(desc(migrationRuns.id)).limit(1);
    const [row] = await plans("succeeded");
    const [last] = await plans();
    const parsed = row ? planSummary.safeParse(row.receipt) : null;
    const summary = parsed?.success ? parsed.data : null;
    return {
      summary,
      stale: summary?.setup !== undefined && summary.setup !== planSetup(migration),
      latestRun: last ? { at: (last.finishedAt ?? last.startedAt).getTime(), status: last.status } : null,
      prune: migration.options.prune, recreateDrifted: migration.options.recreateDrifted, carryArchived: migration.options.carryArchived === true, mondayCallsToday: await mondayCallsOn(ctx.db), held: heldUntil(input.migrationId),
      mondayLimit: dailyLimit(await mondayTierOf(ctx.db, input.migrationId)),
    };
  }),

  details: migrationProcedure.input(z.object({ showValues: z.boolean() })).output(planDetails.nullable()).query(({ input }) => {
    const held = lastPlan(input.migrationId);
    if (!input.showValues || !held) return null;
    return {
      boards: held.planned.plans.map((p) => ({
        name: p.mondayBoardName,
        creates: p.writes.filter((w) => writeAction(w) === "create").map((w) => w.title).slice(0, 200),
        updates: p.writes.filter((w) => writeAction(w) === "update").map((w) => w.title).slice(0, 200),
        notCarried: p.writes.flatMap((w) => w.notCarried).slice(0, 200),
      })),
    };
  }),

  setOptions: migrationProcedure.input(z.object({ prune: z.boolean().optional(), recreateDrifted: z.boolean().optional(), carryArchived: z.boolean().optional() }))
    .output(z.object({ ok: z.literal(true), prune: z.boolean(), recreateDrifted: z.boolean(), carryArchived: z.boolean() })).mutation(async ({ ctx, input }) => {
      const stored = await withSetup(input.migrationId, "saving the options", async () => {
        const { options } = await getMigration(ctx.db, input.migrationId);
        const next = { prune: input.prune ?? options.prune, recreateDrifted: input.recreateDrifted ?? options.recreateDrifted, carryArchived: input.carryArchived ?? options.carryArchived === true };
        if (next.recreateDrifted && ((await loadManifest(ctx.db, input.migrationId))?.boards.some((b) => b.nested) || (await loadLinkConfig(ctx.db, input.migrationId))?.config.boards.some((b) => b.nested))) {
          throw new PreconditionError("Re-creating items is unavailable with nested subitems. Turn this option off.");
        }
        if (next.prune !== options.prune || next.recreateDrifted !== options.recreateDrifted || next.carryArchived !== (options.carryArchived === true)) {
          await clearSyncPoints(ctx.db, input.migrationId);
          dropPlan(input.migrationId);
        }
        await updateSetup(ctx.db, input.migrationId, { options: next });
        return next;
      });
      return { ok: true as const, ...stored };
    }),
});
