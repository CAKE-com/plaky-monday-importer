import { and, asc, count, desc, eq, gt, inArray, ne, sql } from "drizzle-orm";
import { TRPCError, tracked } from "@trpc/server";
import { z } from "zod";
import { connections, migrationBoards, migrationLogs, migrationRuns, migrations } from "@/db/schema";
import { activeJob, cancelResume, cancelSchedule, RESUME_MARGIN_MS, setSchedule, startApply, stopJob } from "@/server/jobs/runner";
import { changesPlan } from "@/server/pipeline/changes";
import { getMigration } from "@/server/pipeline/store";
import { loadLinkConfig } from "@/server/pipeline/store";
import { PreconditionError } from "@/server/errors";
import { appliedState, readBoardStates, type BoardState } from "@/server/pipeline/board-state";
import type { Db } from "@/db/client";
import { planSummary, receiptSchema } from "@/lib/reports";
import { router } from "../init";
import { migrationProcedure, mondayItemUrl, plakyLinksFor, clientsOf } from "./shared";

const eventSchema = z.object({
  id: z.number(), runId: z.number(),
  prev: z.number().nullable(), board: z.string().nullable(), ts: z.number(), level: z.enum(["info", "warn", "error", "ambiguous", "progress"]), code: z.string(), message: z.string(),
  data: z.unknown(),
});
export type RunEvent = z.infer<typeof eventSchema>;

export const runStatus = z.enum(migrationRuns.status.enumValues);
export const runSchema = z.object({
  id: z.number(), kind: z.enum(migrationRuns.kind.enumValues), status: runStatus, plannedWrites: z.number().nullable(), counts: z.record(z.string(), z.number()).nullable(), startedAt: z.number(), finishedAt: z.number().nullable(),
});

async function runOf(db: Db, migrationId: number, runId: number | undefined): Promise<typeof migrationRuns.$inferSelect | null> {
  if (runId === undefined) {
    return (await db.select().from(migrationRuns).where(and(eq(migrationRuns.migrationId, migrationId), eq(migrationRuns.kind, "apply"))).orderBy(desc(migrationRuns.id)).limit(1))[0] ?? null;
  }
  const row = (await db.select().from(migrationRuns).where(and(eq(migrationRuns.id, runId), eq(migrationRuns.migrationId, migrationId))).limit(1))[0];
  if (!row) throw new TRPCError({ code: "NOT_FOUND", message: `Migration ${migrationId} has no run ${runId}.` });
  return row;
}

const boardStateSchema = z.object({ pairing: z.enum(["unpaired", "paired"]), applied: z.enum(["untouched", "written"]), sync: z.enum(["unsynced", "in_step"]) });

const POLL_MS = 400;
const PROBLEMS_SHOWN = 500;
const PAGE = 500;

export const runRouter = router({
  start: migrationProcedure.input(z.object({ mode: z.enum(["full", "changes"]).default("full") })).output(z.object({ runId: z.number(), since: z.string().nullable(), full: z.array(z.string()) })).mutation(async ({ ctx, input }) => {
    if (!(await loadLinkConfig(ctx.db, input.migrationId))) throw new PreconditionError("link the boards first");
    const changes = input.mode === "changes" ? await changesPlan(ctx.db, input.migrationId) : null;
    const pending = (await getMigration(ctx.db, input.migrationId)).resume;
    const job = await startApply(ctx.db, input.migrationId, await clientsOf(ctx, input.migrationId), { changes, byHand: true });
    if (pending) await cancelResume(ctx.db, input.migrationId, pending.at);
    return { runId: job.runId, since: changes?.since ?? null, full: changes?.full ?? [] };
  }),

  cancelResume: migrationProcedure.output(z.object({ cancelled: z.boolean() })).mutation(async ({ ctx, input }) => ({ cancelled: await cancelResume(ctx.db, input.migrationId) })),

  setSchedule: migrationProcedure.input(z.object({ at: z.number().int().positive(), everyHours: z.number().int().min(1).max(168).nullable() }))
    .output(z.object({ saved: z.literal(true) })).mutation(async ({ ctx, input }) => {
      if (input.at <= Date.now()) throw new PreconditionError("pick a time in the future");
      await changesPlan(ctx.db, input.migrationId);
      await setSchedule(ctx.db, input.migrationId, { at: input.at, everyHours: input.everyHours }, ctx.clients ? await clientsOf(ctx, input.migrationId) : undefined);
      return { saved: true as const };
    }),

  cancelSchedule: migrationProcedure.output(z.object({ cancelled: z.boolean() })).mutation(async ({ ctx, input }) => ({ cancelled: await cancelSchedule(ctx.db, input.migrationId) })),

  stop: migrationProcedure.output(z.object({ stopping: z.boolean() })).mutation(({ input }) => ({ stopping: stopJob(input.migrationId) })),

  status: migrationProcedure.output(z.object({
    active: z.boolean(), run: runSchema.nullable(),
    elsewhere: z.boolean(),
    progress: z.object({ done: z.number(), planned: z.number(), at: z.number(), from: z.object({ done: z.number(), at: z.number() }) }).nullable(),
    counters: z.object({ ambiguous: z.number(), errors: z.number(), warnings: z.number() }),
    boards: z.array(z.object({ name: z.string(), plakyBoardId: z.number().nullable(), applied: z.boolean(), state: boardStateSchema })), migrationStatus: z.string(),
    since: z.string().nullable(),
    waiting: z.object({ reset: z.number(), resumeAt: z.number() }).nullable(),
    schedule: z.object({ at: z.number(), everyHours: z.number().nullable() }).nullable(),
    deletions: z.boolean(),
  })).query(async ({ ctx, input }) => {
    const migration = await getMigration(ctx.db, input.migrationId);
    const run = (await ctx.db.select().from(migrationRuns).where(and(eq(migrationRuns.migrationId, input.migrationId), eq(migrationRuns.kind, "apply"))).orderBy(desc(migrationRuns.id)).limit(1))[0] ?? null;
    let progress: { done: number; planned: number; at: number; from: { done: number; at: number } } | null = null;
    let since: string | null = null;
    const counters = { ambiguous: 0, errors: 0, warnings: 0 };
    if (run) {
      for (const row of await ctx.db.select({ level: migrationLogs.level, n: count() }).from(migrationLogs).where(and(eq(migrationLogs.runId, run.id), ne(migrationLogs.code, "run.board_failed"))).groupBy(migrationLogs.level)) {
        if (row.level === "ambiguous") counters.ambiguous = row.n;
        else if (row.level === "error") counters.errors = row.n;
        else if (row.level === "warn") counters.warnings = row.n;
      }
      const last = (await ctx.db.select({ data: migrationLogs.data, ts: migrationLogs.ts }).from(migrationLogs).where(and(eq(migrationLogs.runId, run.id), eq(migrationLogs.code, "apply.progress"))).orderBy(desc(migrationLogs.id)).limit(1))[0];
      const firstSeen = (await ctx.db.select({ data: migrationLogs.data, ts: migrationLogs.ts }).from(migrationLogs).where(and(eq(migrationLogs.runId, run.id), eq(migrationLogs.code, "apply.progress"))).orderBy(asc(migrationLogs.id)).limit(1))[0];
      const d = last?.data as { done?: number; planned?: number } | null | undefined;
      const f = firstSeen?.data as { done?: number } | null | undefined;
      if (d && typeof d.done === "number" && typeof d.planned === "number" && last) {
        progress = { done: d.done, planned: d.planned, at: last.ts.getTime(), from: { done: typeof f?.done === "number" ? f.done : d.done, at: firstSeen?.ts.getTime() ?? last.ts.getTime() } };
      }
      const started = (await ctx.db.select({ data: migrationLogs.data }).from(migrationLogs).where(and(eq(migrationLogs.runId, run.id), eq(migrationLogs.code, "run.started"))).limit(1))[0];
      const s = (started?.data as { since?: unknown } | null | undefined)?.since;
      if (typeof s === "string") since = s;
    }
    const loaded = await loadLinkConfig(ctx.db, input.migrationId);
    const states = await readBoardStates(ctx.db, input.migrationId);
    const here = activeJob(input.migrationId) !== undefined;
    const elsewhere = !here && run?.status === "running";
    return {
      active: here || elsewhere, elsewhere,
      run: run ? { id: run.id, kind: run.kind, status: run.status, plannedWrites: run.plannedWrites, counts: run.counts, startedAt: run.startedAt.getTime(), finishedAt: run.finishedAt?.getTime() ?? null } : null,
      progress, counters, migrationStatus: migration.status, since,
      waiting: migration.resume ? { reset: migration.resume.reset ?? migration.resume.at - RESUME_MARGIN_MS, resumeAt: migration.resume.at } : null,
      schedule: migration.schedule,
      deletions: migration.options.prune || migration.options.recreateDrifted,
      boards: (loaded?.config.boards ?? []).map((b) => ({
        name: b.name, plakyBoardId: b.plakyBoardId, applied: b.applied,
        state: states.get(b.mondayBoardId) ?? ({ pairing: "paired", applied: appliedState(b), sync: "unsynced" } satisfies BoardState),
      })),
    };
  }),

  problems: migrationProcedure.input(z.object({ runId: z.number().int().positive().optional() })).output(z.object({
    runId: z.number().nullable(),
    items: z.array(z.object({ id: z.number(), level: z.enum(["error", "ambiguous"]), code: z.string(), message: z.string(), board: z.string().nullable(), boardUrl: z.string().nullable(), mondayItemUrl: z.string().nullable() })),
    truncated: z.boolean(),
  })).query(async ({ ctx, input }) => {
    const migration = await getMigration(ctx.db, input.migrationId);
    const run = await runOf(ctx.db, input.migrationId, input.runId);
    if (!run) return { runId: null, items: [], truncated: false };
    const links = await plakyLinksFor(ctx.db, input.migrationId);
    const slug = (await ctx.db.select({ slug: connections.mondayAccountSlug }).from(connections).where(eq(connections.id, migration.connectionId)).limit(1))[0]?.slug ?? null;
    const rows = await ctx.db.select({ log: migrationLogs, board: migrationBoards.mondayBoardName, mondayBoardId: migrationBoards.mondayBoardId, plakyBoardId: migrationBoards.plakyBoardId }).from(migrationLogs)
      .leftJoin(migrationBoards, eq(migrationBoards.id, migrationLogs.migrationBoardId))
      .where(and(eq(migrationLogs.runId, run.id), inArray(migrationLogs.level, ["error", "ambiguous"]), ne(migrationLogs.code, "run.board_failed")))
      .orderBy(asc(migrationLogs.id)).limit(PROBLEMS_SHOWN + 1);
    return {
      runId: run.id,
      truncated: rows.length > PROBLEMS_SHOWN,
      items: rows.slice(0, PROBLEMS_SHOWN).map(({ log, board, mondayBoardId, plakyBoardId }) => ({
        id: log.id, level: log.level as "error" | "ambiguous", code: log.code, message: log.message, board,
        boardUrl: links && migration.plakySpaceId !== null && plakyBoardId != null ? links(migration.plakySpaceId, plakyBoardId) : null,
        mondayItemUrl: mondayItemUrl(slug, mondayBoardId, (log.data as { mondayItemId?: unknown } | null)?.mondayItemId),
      })),
    };
  }),

  history: migrationProcedure.output(z.array(runSchema.extend({
    mode: z.enum(["full", "changes"]).nullable(), since: z.string().nullable(), mondayCalls: z.number().nullable(), durationMs: z.number().nullable(), hasReceipt: z.boolean(),
  }))).query(async ({ ctx, input }) => {
    const runs = await ctx.db.select({
      id: migrationRuns.id, kind: migrationRuns.kind, status: migrationRuns.status, plannedWrites: migrationRuns.plannedWrites, counts: migrationRuns.counts,
      startedAt: migrationRuns.startedAt, finishedAt: migrationRuns.finishedAt, hasReceipt: sql<number>`${migrationRuns.receipt} IS NOT NULL`,
    }).from(migrationRuns).where(eq(migrationRuns.migrationId, input.migrationId)).orderBy(desc(migrationRuns.id)).limit(500);
    const firsts = runs.length
      ? ctx.db.select({ id: sql<number>`min(${migrationLogs.id})` }).from(migrationLogs).where(inArray(migrationLogs.runId, runs.map((r) => r.id))).groupBy(migrationLogs.runId)
      : null;
    const started = firsts
      ? await ctx.db.select({ runId: migrationLogs.runId, data: migrationLogs.data }).from(migrationLogs).where(and(inArray(migrationLogs.id, firsts), eq(migrationLogs.code, "run.started")))
      : [];
    const sinceOf = new Map(started.map((row) => [row.runId, (row.data as { since?: unknown } | null)?.since]));
    return runs.map((r) => {
      const since = sinceOf.get(r.id);
      return {
        id: r.id, kind: r.kind, status: r.status, plannedWrites: r.plannedWrites, counts: r.counts, startedAt: r.startedAt.getTime(), finishedAt: r.finishedAt?.getTime() ?? null,
        mode: r.kind === "apply" ? (typeof since === "string" ? "changes" as const : "full" as const) : null,
        since: typeof since === "string" ? since : null,
        mondayCalls: typeof r.counts?.mondayCalls === "number" ? r.counts.mondayCalls : null,
        durationMs: r.finishedAt ? r.finishedAt.getTime() - r.startedAt.getTime() : null,
        hasReceipt: Boolean(r.hasReceipt),
      };
    });
  }),

  receipt: migrationProcedure.input(z.object({ runId: z.number().int().positive() })).output(z.object({ kind: z.string(), receipt: receiptSchema.nullable(), plan: planSummary.nullable() })).query(async ({ ctx, input }) => {
    const run = (await runOf(ctx.db, input.migrationId, input.runId))!;
    const receipt = run.kind === "plan" ? null : receiptSchema.safeParse(run.receipt);
    const plan = run.kind === "plan" ? planSummary.safeParse(run.receipt) : null;
    return { kind: run.kind, receipt: receipt?.success ? receipt.data : null, plan: plan?.success ? plan.data : null };
  }),

  events: migrationProcedure.input(z.object({ lastEventId: z.string().max(20).nullish() })).subscription(async function* ({ ctx, input, signal }) {
    let last = Number(input.lastEventId ?? 0);
    if (!Number.isFinite(last) || last < 0) last = 0;
    if (input.lastEventId == null) {
      const newest = (await ctx.db.select({ id: migrationRuns.id }).from(migrationRuns).where(and(eq(migrationRuns.migrationId, input.migrationId), eq(migrationRuns.kind, "apply"))).orderBy(desc(migrationRuns.id)).limit(1))[0];
      const first = newest ? (await ctx.db.select({ id: migrationLogs.id }).from(migrationLogs).where(eq(migrationLogs.runId, newest.id)).orderBy(asc(migrationLogs.id)).limit(1))[0] : undefined;
      if (first) last = first.id - 1;
      else if (newest) last = (await ctx.db.select({ id: sql<number | null>`max(${migrationLogs.id})` }).from(migrationLogs))[0]?.id ?? 0;
    }
    while (!signal?.aborted) {
      const rows = await ctx.db.select({ log: migrationLogs, board: migrationBoards.mondayBoardName, prev: sql<number | null>`(SELECT max(l2.id) FROM migration_logs l2 WHERE l2.run_id = ${migrationLogs.runId} AND l2.id < ${migrationLogs.id})` }).from(migrationLogs)
        .innerJoin(migrationRuns, eq(migrationRuns.id, migrationLogs.runId))
        .leftJoin(migrationBoards, eq(migrationBoards.id, migrationLogs.migrationBoardId))
        .where(and(eq(migrationRuns.migrationId, input.migrationId), eq(migrationRuns.kind, "apply"), gt(migrationLogs.id, last)))
        .orderBy(asc(migrationLogs.id)).limit(PAGE);
      for (const { log, board, prev } of rows) {
        last = log.id;
        yield tracked(String(log.id), eventSchema.parse({ id: log.id, runId: log.runId, prev: prev === null ? null : Number(prev), board, ts: log.ts.getTime(), level: log.level, code: log.code, message: log.message, data: log.data }));
      }
      if (rows.length < PAGE) {
        const still = await ctx.db.select({ id: migrations.id }).from(migrations).where(eq(migrations.id, input.migrationId)).limit(1);
        if (!still[0]) return;
      }
      if (rows.length < PAGE) await new Promise<void>((resolve) => {
        const onAbort = (): void => { clearTimeout(timer); resolve(); };
        const timer = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, POLL_MS);
        signal?.addEventListener("abort", onAbort, { once: true });
      });
    }
  }),
});
