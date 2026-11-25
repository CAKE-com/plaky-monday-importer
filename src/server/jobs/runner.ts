import { planReuse, PLAN_MAX_AGE_MS } from "@/lib/plan-state";
export { PLAN_MAX_AGE_MS } from "@/lib/plan-state";
import { appliedOutcome, verifiedOutcome, RunExecution } from "./run-state";
import { timerState, nextOccurrence, RESUME_RETRY_MS, type Schedule } from "./timer-state";
import { hostname } from "node:os";
import { forgetDepartureArchives } from "../departure/downloads";
import { and, eq, inArray, isNotNull, isNull, ne, notInArray, sql } from "drizzle-orm";
import { getDb, type Db } from "@/db/client";
import { boardLocks, connections, migrationLogs, migrationRuns, migrations } from "@/db/schema";
import { MondayClient, isMondayDailyLimit } from "../clients/monday";
import { PlakyClient } from "../clients/plaky";
import type { PipelineEvent } from "../pipeline/events";
import { ExtractCache, applyStep, planStep, verifyStep, type Deps, type PlanStepResult } from "../pipeline/migration";
import { PROCESS_TOKEN, RUN_HEARTBEAT_MS, boardIdsByName, getMigration, keysFor, ownRunIds, type Keys, dbLog, finishRun, recordMondayCall, setStatus, setStatusUnlessOtherRun, startRun } from "../pipeline/store";
import { migrationBoards } from "@/db/schema";
import { baseBoardId } from "../pipeline/names";
import { changesPlan, recordSyncPoints, type ChangesPlan } from "../pipeline/changes";
import { receiptJson, receiptOk, type Receipt } from "../pipeline/verify";
import { stampedReceipt } from "../pipeline/receipt-scope";
import type { ApplyResult } from "../pipeline/load";
import { ConflictError, PreconditionError } from "../errors";
import { logger, redactString } from "../redact";

export type ResumeClock = { now: () => number; setTimeout: (fn: () => void, ms: number) => unknown; clearTimeout: (handle: unknown) => void };
const realResumeClock: ResumeClock = { now: () => Date.now(), setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) };
export const RESUME_MARGIN_MS = 5 * 60_000;
const MAX_TIMER_MS = 2 ** 31 - 1;
const timerDelay = (at: number, now: number): number => Math.min(Math.max(0, at - now), MAX_TIMER_MS);

export type Clients = { monday: () => MondayClient; plaky: () => PlakyClient };

type Job = {
  migrationId: number; runId: number; controller: AbortController; done: Promise<void>;
  byHand?: boolean;
};

type HeldPlan = { planned: PlanStepResult; at: number; readAt: number; monday?: MondayClient | undefined; calls: number };

type Registry = {
  jobs: Map<number, Job>;
  plans: Map<number, HeldPlan>;
  setup: Map<number, string>;
  plakyByKey: Map<string, PlakyClient>;
  itemIds: Map<number, { at: number; boards: Map<string, Promise<Set<string>>>; homes: Map<string, number[]> }>;
  swept?: WeakMap<Db, { at: number; done: Promise<void> }>;
  countWarned?: boolean;
  resumes: Map<number, unknown>;
  schedules: Map<number, unknown>;
  resumeClock?: ResumeClock | undefined;
  walRetry?: unknown;
};
const globalForJobs = globalThis as unknown as { __mmwJobs?: Registry };
function registry(): Registry {
  const r = (globalForJobs.__mmwJobs ??= { jobs: new Map(), plans: new Map(), setup: new Map(), resumes: new Map(), schedules: new Map(), plakyByKey: new Map(), itemIds: new Map() });
  r.setup ??= new Map();
  r.resumes ??= new Map();
  r.schedules ??= new Map();
  r.plakyByKey ??= new Map();
  r.itemIds ??= new Map();
  return r;
}

function plakyFor(key: string | null): PlakyClient {
  const r = registry();
  const id = key ?? "";
  let client = r.plakyByKey.get(id);
  if (!client) {
    client = key ? new PlakyClient({ apiKey: key }) : PlakyClient.fromEnv();
    r.plakyByKey.set(id, client);
  }
  return client;
}
export function countMondayCall(open: () => Promise<Db> = getDb): Promise<void> {
  const at = Date.now();
  return open().then((db) => recordMondayCall(db, at)).catch((error: unknown) => {
    const r = registry();
    if (r.countWarned) return;
    r.countWarned = true;
    logger.warn(`a monday call could not be counted, so "monday calls today" reads low from now on: ${error instanceof Error ? error.message : String(error)}`);
  });
}

export function clientsWith(keys: Partial<Keys> = {}): Clients {
  const precondition = <T>(make: () => T, variable: string): T => {
    try {
      return make();
    } catch (error) {
      if (error instanceof Error && /is not set$/.test(error.message)) {
        throw new PreconditionError(`${variable} is not set on this server and no key was typed for this connection: connect again with a key typed into Connect, or set ${variable} in .env and restart`);
      }
      throw error;
    }
  };
  return {
    monday: () => precondition(() => (keys.mondayToken ? new MondayClient({ token: keys.mondayToken, onCall: () => void countMondayCall() }) : MondayClient.fromEnv({ onCall: () => void countMondayCall() })), "MONDAY_API_TOKEN"),
    plaky: () => precondition(() => plakyFor(keys.plakyKey ?? null), "PLAKY_API_KEY"),
  };
}

export async function clientsFor(db: Db, migrationId: number): Promise<Clients> {
  return clientsWith(await keysFor(db, migrationId));
}

export const RUN_STALE_MS = 3 * RUN_HEARTBEAT_MS;

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function sweepInterrupted(db: Db, now: number = Date.now()): Promise<void> {
  const r = registry();
  const sweeps = (r.swept ??= new WeakMap());
  const last = sweeps.get(db);
  if (last && now - last.at < RUN_HEARTBEAT_MS) return last.done;
  const done = (async () => {
    const lastLogged = sql`coalesce((SELECT max(${migrationLogs.ts}) FROM ${migrationLogs} WHERE ${migrationLogs.runId} = ${migrationRuns.id}), ${migrationRuns.startedAt})`;
    const open = await db.select({ id: migrationRuns.id, host: migrationRuns.ownerHost, pid: migrationRuns.ownerPid, token: migrationRuns.ownerToken, silent: sql<number>`coalesce(${migrationRuns.heartbeatAt}, ${lastLogged}) < ${now - RUN_STALE_MS}` })
      .from(migrationRuns).where(and(eq(migrationRuns.status, "running"), notInArray(migrationRuns.id, ownRunIds(db))));
    const here = hostname();
    const gone = (run: (typeof open)[number]): boolean => {
      if (run.host !== here || run.pid === null) return false;
      if (run.pid !== process.pid) return !processAlive(run.pid);
      return run.token !== null && run.token !== PROCESS_TOKEN;
    };
    const dead = open.filter((run) => Boolean(run.silent) || gone(run)).map((run) => run.id);
    if (dead.length) {
      await db.update(migrationRuns).set({ status: "interrupted", finishedAt: lastLogged }).where(and(eq(migrationRuns.status, "running"), inArray(migrationRuns.id, dead)));
      await db.delete(boardLocks).where(inArray(boardLocks.owner, dead.map(String)));
    }
    await db.update(migrations).set({ status: "interrupted" }).where(and(
      eq(migrations.status, "running"),
      sql`NOT EXISTS (SELECT 1 FROM ${migrationRuns} WHERE ${migrationRuns.migrationId} = ${migrations.id} AND ${migrationRuns.status} = 'running')`,
    ));
    if (dead.length) {
      await db.update(migrations).set({ status: "interrupted" }).where(and(
        eq(migrations.status, "completed"),
        sql`EXISTS (SELECT 1 FROM ${migrationRuns} WHERE ${migrationRuns.migrationId} = ${migrations.id} AND ${inArray(migrationRuns.id, dead)} AND ${inArray(migrationRuns.kind, ["apply", "verify"])})`,
      ));
    }
  })();
  const swept = { at: now, done };
  sweeps.set(db, swept);
  done.catch(() => {
    if (sweeps.get(db) === swept) sweeps.delete(db);
  });
  return done;
}

export const activeJob = (migrationId: number): Job | undefined => registry().jobs.get(migrationId);

type MigrationActivity =
  | { state: "idle" }
  | { state: "setup"; what: string }
  | { state: "starting" | "running" | "stopping"; job: Job };

function migrationActivity(migrationId: number): MigrationActivity {
  const r = registry();
  const job = r.jobs.get(migrationId);
  if (job) return { state: job.controller.signal.aborted ? "stopping" : job.runId === 0 ? "starting" : "running", job };
  const what = r.setup.get(migrationId);
  return what === undefined ? { state: "idle" } : { state: "setup", what };
}

function assertIdle(migrationId: number, runMessage: string): void {
  const activity = migrationActivity(migrationId);
  if (activity.state === "setup") throw new ConflictError(`${activity.what} is in progress for this migration; wait for it to finish`);
  if (activity.state !== "idle") throw new ConflictError(runMessage);
}

export async function withSetup<T>(migrationId: number, what: string, work: () => Promise<T>): Promise<T> {
  const r = registry();
  assertIdle(migrationId, "a run is in progress for this migration; wait for it to finish or stop it first");
  r.setup.set(migrationId, what);
  try {
    return await work();
  } finally {
    r.setup.delete(migrationId);
  }
}
function evictStale(plans: Registry["plans"]): void {
  for (const [id, held] of plans) if (planReuse(held, Date.now()).state === "expired") plans.delete(id);
}
export const rememberPlan = (migrationId: number, planned: PlanStepResult, o: { readAt?: number; monday?: MondayClient } = {}): void => {
  const { plans } = registry();
  evictStale(plans);
  const at = Date.now();
  plans.set(migrationId, { planned, at, readAt: o.readAt ?? at, monday: o.monday, calls: o.monday?.calls ?? 0 });
};
function scanCache(migrationId: number) {
  const { itemIds } = registry();
  for (const [id, held] of itemIds) if (Date.now() - held.at > PLAN_MAX_AGE_MS) itemIds.delete(id);
  let held = itemIds.get(migrationId);
  if (!held) itemIds.set(migrationId, (held = { at: Date.now(), boards: new Map(), homes: new Map() }));
  return held;
}
export const scanHomes = (migrationId: number): Map<string, number[]> => scanCache(migrationId).homes;
export function scanItemIds(migrationId: number, monday: MondayClient): (boardId: string) => Promise<Set<string>> {
  const boards = scanCache(migrationId).boards;
  return (boardId) => {
    let ids = boards.get(boardId);
    if (!ids) {
      ids = monday.itemTitles(baseBoardId(boardId)).then((titles) => new Set(titles.keys()));
      boards.set(boardId, ids);
      ids.catch(() => boards.delete(boardId));
    }
    return ids;
  };
}
export const dropPlan = (migrationId: number): void => void registry().plans.delete(migrationId);
export const lastPlan = (migrationId: number): HeldPlan | undefined => {
  const { plans } = registry();
  evictStale(plans);
  return plans.get(migrationId);
};

const sum = (results: readonly { result: ApplyResult }[], pick: (r: ApplyResult) => number): number => results.reduce((n, r) => n + pick(r.result), 0);

function applyCounts(applied: { results: { result: ApplyResult }[]; notStarted: string[] } | null): Record<string, number> {
  if (!applied) return {};
  const r = applied.results;
  return {
    writes: sum(r, (x) => x.writes), created: sum(r, (x) => x.created), updated: sum(r, (x) => x.updated), unchanged: sum(r, (x) => x.unchanged),
    recreated: sum(r, (x) => x.recreated), pruned: sum(r, (x) => x.pruned), groupsCreated: sum(r, (x) => x.groupsCreated),
    groupsReordered: sum(r, (x) => x.groupsReordered), commentsCreated: sum(r, (x) => x.commentsCreated), filesUploaded: sum(r, (x) => x.filesUploaded),
    ambiguous: sum(r, (x) => x.ambiguous.length), failures: sum(r, (x) => x.failures.length), notStarted: applied.notStarted.length,
    rateLimited: r.some((x) => x.result.rateLimited) ? 1 : 0, stopped: r.some((x) => x.result.stopped) ? 1 : 0,
  };
}

export const STOPPED: unique symbol = Symbol("stopped");
export function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T | typeof STOPPED> {
  if (signal.aborted) {
    work.catch(() => undefined);
    return Promise.resolve(STOPPED);
  }
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      work.catch(() => undefined);
      resolve(STOPPED);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (v) => { signal.removeEventListener("abort", onAbort); resolve(v); },
      (e: unknown) => { signal.removeEventListener("abort", onAbort); reject(e instanceof Error ? e : new Error(String(e))); },
    );
  });
}

function progressLogger(log: (e: PipelineEvent) => void, getPlanned: () => number): { tick: () => void; flush: () => void } {
  let done = 0;
  let lastEmit = 0;
  const emit = (): void => {
    lastEmit = Date.now();
    log({ level: "progress", code: "apply.progress", message: `${done} of ${getPlanned()} write(s) done`, data: { done, planned: getPlanned() } });
  };
  return {
    tick() {
      done++;
      if (Date.now() - lastEmit >= 400) emit();
    },
    flush: emit,
  };
}

export async function startApply(db: Db, migrationId: number, given?: Clients, o: { changes?: ChangesPlan | null; byHand?: boolean; unattended?: boolean } = {}): Promise<Job> {
  const changes = o.changes ?? null;
  const since = changes?.since ?? null;
  const r = registry();
  assertIdle(migrationId, "a run is already in progress for this migration");
  const controller = new AbortController();
  const job: Job = { migrationId, runId: 0, controller, done: Promise.resolve(), ...(o.byHand ? { byHand: true } : {}) };
  r.jobs.set(migrationId, job);
  let runId: number | null = null;
  let log: (e: PipelineEvent) => void;
  let flush: () => Promise<void>;
  let deps: Deps;
  let clients: Clients;
  let boardNames: Map<string, string>;
  try {
    await sweepInterrupted(db);
    clients = given ?? await clientsFor(db, migrationId);
    const monday = clients.monday();
    const plaky = clients.plaky();
    runId = await startRun(db, migrationId, "apply");
    const boardRows = await db.select().from(migrationBoards).where(eq(migrationBoards.migrationId, migrationId));
    boardNames = new Map(boardRows.map((b) => [b.mondayBoardId, b.mondayBoardName]));
    const boardIds = boardIdsByName(boardRows);
    ({ log, flush } = dbLog(db, runId, boardIds));
    deps = { db, migrationId, monday, plaky, log, signal: controller.signal };
    monday.stopOn?.(controller.signal);
  } catch (error) {
    r.jobs.delete(migrationId);
    if (runId !== null) await finishRun(db, runId, "failed").catch(() => undefined);
    throw error;
  }
  job.runId = runId;
  const held = r.plans.get(migrationId);
  r.plans.delete(migrationId);
  const reuse = planReuse(held, Date.now(), since !== null);
  const cached = reuse.state === "reusable" ? reuse.plan : undefined;
  const readAt = cached ? cached.readAt : Date.now();
  const mondayLimited = (): boolean => deps.monday.dailyLimited || (cached?.monday?.dailyLimited ?? false);
  const mondayCalls = (): number => deps.monday.calls + (cached?.monday ? cached.monday.calls - cached.calls : 0);
  let planned = 0;
  const progress = progressLogger(log, () => planned);
  const finalRunId = runId;
  const execution = new RunExecution();
  job.done = (async () => {
    try {
      const full = (changes?.full ?? []).map((b) => boardNames.get(b) ?? b);
      log({
        level: "info", code: "run.started",
        message: changes ? `Run started: monday items changed since ${since}${full.length ? `; read in full: ${full.join(", ")}` : ""}.` : "Run started.",
        data: { since, readAt: new Date(readAt).toISOString(), ...(changes ? { from: Object.fromEntries(changes.from) } : {}) },
      });
      if (o.unattended) log({ level: "info", code: "run.unattended", message: "Started by itself, on schedule or after monday's limit. Nothing is deleted in this run: prune and rebuild are off." });
      const run = await applyStep(deps, {
        ...(o.unattended ? { unattended: true } : {}),
        owner: String(runId),
        ...(cached ? { cache: cached.planned.cache } : changes ? { cache: new ExtractCache(deps, changes.from), since: changes.from } : {}),
        progress: progress.tick,
        confirm: (p) => {
          planned = p.plannedWrites;
          progress.flush();
          return true;
        },
      });
      progress.flush();
      const counts = applyCounts(run.applied);
      execution.applied(counts);
      let limited = mondayLimited();
      for (const f of run.planned.failures) log({ level: "error", code: "run.board_failed", message: f });
      let status = appliedOutcome({ applied: run.applied !== null, aborted: controller.signal.aborted,
        mondayLimited: limited, planFailures: run.planned.failures.length, counts });
      let receipt: Record<string, unknown> | null = null;
      let report: Receipt | null = null;
      if (limited) {
        if (status === "rate_limited") {
          await waitForMondayReset(db, migrationId, since, log, clients, o.unattended);
          await setStatus(db, migrationId, "interrupted");
        }
      } else if (run.applied && since && status !== "interrupted") {
        log({ level: "info", code: "verify.skipped", message: "Changes-only run: not verified. Use Verify now for a full check." });
      } else if (run.applied && status !== "interrupted") {
        log({ level: "info", code: "verify.started", message: "Verifying against monday." });
        const writtenAt = Date.now();
        const sourceReadAt = cached ? writtenAt : readAt;
        const verifying = verifyStep(deps, cached ? {} : { cache: run.planned.cache });
        const verified = await untilAborted(verifying, controller.signal);
        if (verified === STOPPED) {
          execution.drain(verifying);
          status = verifiedOutcome(status, "stopped");
          log({ level: "warn", code: "verify.stopped", message: "Stopped before verification finished; no receipt for this run." });
          await setStatusUnlessOtherRun(db, migrationId, "interrupted", finalRunId);
        } else if (mondayLimited()) {
          limited = true;
          status = verifiedOutcome(status, "monday_limited");
          await waitForMondayReset(db, migrationId, since, log, clients, o.unattended);
          await setStatus(db, migrationId, "interrupted");
        } else {
          report = verified;
          receipt = await stampedReceipt(db, migrationId, receiptJson(verified), { sourceReadAt, writtenAt, checkedAt: Date.now() });
          log({ level: receiptOk(verified) ? "info" : "error", code: "verify.done", message: receiptOk(verified) ? "Verification OK." : "Verification found a shortfall." });
          const checked = verifiedOutcome(status, receiptOk(verified) ? "matched" : "short");
          if (checked !== status) {
            status = checked;
            await setStatusUnlessOtherRun(db, migrationId, "failed", finalRunId);
          }
        }
      }
      if (run.applied) await recordSyncPoints(db, migrationId, run.applied, report, readAt);
      log({ level: "info", code: "run.finished", message: `Run ${status}.`, data: { status } });
      await flush();
      await finishRun(db, finalRunId, status, { plannedWrites: planned, counts: { ...counts, mondayCalls: mondayCalls() }, ...(receipt ? { receipt } : {}) });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const limited = isMondayDailyLimit(error) || mondayLimited();
      log({ level: limited ? "warn" : "error", code: limited ? "monday.daily_limit_hit" : "run.crashed", message: message.slice(0, 500) });
      if (limited) await waitForMondayReset(db, migrationId, since, log, clients, o.unattended).catch((unsaved: unknown) => {
        log({ level: "error", code: "resume.unsaved", message: `The automatic restart could not be stored (${unsaved instanceof Error ? unsaved.message : String(unsaved)}). Move again after the reset.`.slice(0, 500) });
      });
      log({ level: "info", code: "run.finished", message: `Run ${limited ? "rate_limited" : "failed"}.`, data: { status: limited ? "rate_limited" : "failed" } });
      await flush();
      await finishRun(db, finalRunId, limited ? "rate_limited" : "failed", { plannedWrites: planned, counts: { ...(execution.counts ?? {}), mondayCalls: mondayCalls() } }).catch(() => undefined);
      const refused = error instanceof Error && error.name === "BoardLockedError";
      if (limited) await setStatusUnlessOtherRun(db, migrationId, "interrupted", finalRunId).catch(() => undefined);
      else if (!refused && !execution.hasApplied) await setStatusUnlessOtherRun(db, migrationId, "failed", finalRunId).catch(() => undefined);
      else if (!refused) {
        const current = await getMigration(db, migrationId).then((m) => m.status, () => null);
        if (current === "completed") await setStatusUnlessOtherRun(db, migrationId, "interrupted", finalRunId).catch(() => undefined);
      }
    } finally {
      await execution.release();
      r.jobs.delete(migrationId);
    }
  })();
  return job;
}

export function stopJob(migrationId: number): boolean {
  const job = registry().jobs.get(migrationId);
  if (!job) return false;
  job.controller.abort();
  return true;
}

export function dryRun(db: Db, migrationId: number, clients?: Clients): Promise<{ planned: PlanStepResult; runId: number; mondayCalls: number }> {
  return withSetup(migrationId, "a dry run", () => planHeld(db, migrationId, clients));
}

async function planHeld(db: Db, migrationId: number, given?: Clients): Promise<{ planned: PlanStepResult; runId: number; mondayCalls: number }> {
  await sweepInterrupted(db);
  const clients = given ?? await clientsFor(db, migrationId);
  const runId = await startRun(db, migrationId, "plan");
  const { log, flush } = dbLog(db, runId);
  const monday = clients.monday();
  try {
    const deps: Deps = { db, migrationId, monday, plaky: clients.plaky(), log };
    const readAt = Date.now();
    const planned = await planStep(deps, { cache: new ExtractCache(deps), ownRunId: runId });
    rememberPlan(migrationId, planned, { readAt, monday });
    await flush();
    return { planned, runId, mondayCalls: monday.calls };
  } catch (error) {
    await flush();
    await finishRun(db, runId, "failed", { counts: { mondayCalls: monday.calls } }).catch(() => undefined);
    throw error;
  }
}

export async function finishPlanRun(db: Db, runId: number, plannedWrites: number, summary: unknown, mondayCalls = 0): Promise<void> {
  await finishRun(db, runId, "succeeded", { plannedWrites, receipt: summary, counts: { mondayCalls } });
}

const resumeClock = (): ResumeClock => registry().resumeClock ?? realResumeClock;
export const setResumeClock = (clock: ResumeClock | undefined): void => void (registry().resumeClock = clock);

export function nextUtcMidnight(now: number): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
}

async function waitForMondayReset(db: Db, migrationId: number, since: string | null, log: (e: PipelineEvent) => void, clients: Clients | undefined, unattended?: boolean): Promise<void> {
  const reset = nextUtcMidnight(resumeClock().now());
  const at = reset + RESUME_MARGIN_MS;
  await db.update(migrations).set({ resume: { at, since, reset, ...(unattended ? { unattended } : {}) } }).where(eq(migrations.id, migrationId));
  armResume(db, migrationId, at, clients);
  log({
    level: "warn", code: "monday.daily_limit",
    message: `monday's daily API limit is used up. Waiting until ${new Date(reset).toISOString()} (00:00 UTC); the run then resumes on its own.`,
    data: { resumeAt: at, since },
  });
}

export function armResume(db: Db, migrationId: number, at: number, clients?: Clients): void {
  const r = registry();
  const clock = resumeClock();
  if (r.resumes.has(migrationId)) clock.clearTimeout(r.resumes.get(migrationId));
  const handle = clock.setTimeout(() => {
    r.resumes.delete(migrationId);
    void fireResume(db, migrationId, clients).catch(() => undefined);
  }, timerDelay(at, clock.now()));
  (handle as { unref?: () => void } | null)?.unref?.();
  r.resumes.set(migrationId, handle);
}

type Resume = NonNullable<(typeof migrations.$inferSelect)["resume"]>;
const stillAt = (migrationId: number, at: number) => and(eq(migrations.id, migrationId), sql`json_extract(${migrations.resume}, '$.at') = ${at}`);

async function retryLater(db: Db, migrationId: number, resume: Resume, from: { at: number } | null, now: number, clients: Clients | undefined): Promise<void> {
  if (registry().jobs.get(migrationId)?.byHand) {
    await cancelResume(db, migrationId);
    return;
  }
  const at = now + RESUME_RETRY_MS;
  const moved = await db.update(migrations).set({ resume: { ...resume, at } })
    .where(from ? stillAt(migrationId, from.at) : and(eq(migrations.id, migrationId), isNull(migrations.resume))).returning({ id: migrations.id });
  if (moved.length) armResume(db, migrationId, at, clients);
}

export async function fireResume(db: Db, migrationId: number, clients?: Clients): Promise<Job | null> {
  const row = (await db.select({ resume: migrations.resume }).from(migrations).where(eq(migrations.id, migrationId)).limit(1))[0];
  const resume = row?.resume ?? null;
  const now = resumeClock().now();
  const state = timerState(resume, now, migrationActivity(migrationId).state !== "idle");
  if (!resume || state.state === "absent") return null;
  if (state.state === "waiting") {
    armResume(db, migrationId, state.at, clients);
    return null;
  }
  if (state.state === "deferred") {
    await retryLater(db, migrationId, resume, resume, now, clients);
    return null;
  }
  const claimed = await db.update(migrations).set({ resume: null }).where(stillAt(migrationId, resume.at)).returning({ id: migrations.id });
  if (!claimed.length) return null;
  try {
    const changes = resume.since === null ? null : await changesPlan(db, migrationId).catch((error: unknown) => {
      if (error instanceof PreconditionError) return null;
      throw error;
    });
    return await startApply(db, migrationId, clients, { changes, unattended: true });
  } catch (error) {
    if (error instanceof ConflictError) {
      await retryLater(db, migrationId, resume, null, now, clients);
      return null;
    }
    await recordResumeFailure(db, migrationId, error).catch(() => undefined);
    throw error;
  }
}

async function recordResumeFailure(db: Db, migrationId: number, error: unknown, what = "resume", code = "resume.failed", hint = "Press Move to run it by hand once that is fixed."): Promise<void> {
  const why = redactString(error instanceof Error ? error.message : String(error)).slice(0, 500);
  logger.error(`migration ${migrationId}: the scheduled ${what} could not start: ${why}`);
  const runId = await startRun(db, migrationId, "apply");
  const { log, flush } = dbLog(db, runId);
  log({ level: "error", code, message: `The automatic ${what} could not start: ${why}. ${hint}` });
  await flush();
  await finishRun(db, runId, "failed");
  await setStatusUnlessOtherRun(db, migrationId, "failed");
}

export async function cancelResume(db: Db, migrationId: number, onlyAt?: number): Promise<boolean> {
  const r = registry();
  const cleared = await db.update(migrations).set({ resume: null })
    .where(onlyAt === undefined ? and(eq(migrations.id, migrationId), isNotNull(migrations.resume)) : stillAt(migrationId, onlyAt)).returning({ id: migrations.id });
  if (cleared.length && r.resumes.has(migrationId)) {
    resumeClock().clearTimeout(r.resumes.get(migrationId));
    r.resumes.delete(migrationId);
  }
  return cleared.length > 0;
}

export async function rearmResumes(db: Db, clients?: Clients): Promise<number> {
  const rows = await db.select({ id: migrations.id, resume: migrations.resume }).from(migrations).where(isNotNull(migrations.resume));
  for (const row of rows) if (row.resume) armResume(db, row.id, row.resume.at, clients);
  return rows.length;
}

const scheduleStillAt = (migrationId: number, at: number) => and(eq(migrations.id, migrationId), sql`json_extract(${migrations.schedule}, '$.at') = ${at}`);

async function writeSchedule(db: Db, migrationId: number, next: Schedule | null, onlyAt?: number): Promise<boolean> {
  const written = await db.update(migrations).set({ schedule: next })
    .where(onlyAt === undefined ? eq(migrations.id, migrationId) : scheduleStillAt(migrationId, onlyAt)).returning({ id: migrations.id });
  return written.length > 0;
}

function armSchedule(db: Db, migrationId: number, at: number, clients?: Clients): void {
  const r = registry();
  const clock = resumeClock();
  if (r.schedules.has(migrationId)) clock.clearTimeout(r.schedules.get(migrationId));
  const handle = clock.setTimeout(() => {
    r.schedules.delete(migrationId);
    void fireSchedule(db, migrationId, clients).catch(() => undefined);
  }, timerDelay(at, clock.now()));
  (handle as { unref?: () => void } | null)?.unref?.();
  r.schedules.set(migrationId, handle);
}

export async function setSchedule(db: Db, migrationId: number, schedule: Schedule, clients?: Clients): Promise<void> {
  await writeSchedule(db, migrationId, schedule);
  armSchedule(db, migrationId, schedule.at, clients);
}

export async function cancelSchedule(db: Db, migrationId: number): Promise<boolean> {
  const r = registry();
  if (r.schedules.has(migrationId)) {
    resumeClock().clearTimeout(r.schedules.get(migrationId));
    r.schedules.delete(migrationId);
  }
  const cleared = await db.update(migrations).set({ schedule: null }).where(and(eq(migrations.id, migrationId), isNotNull(migrations.schedule))).returning({ id: migrations.id });
  return cleared.length > 0;
}

export async function fireSchedule(db: Db, migrationId: number, clients?: Clients): Promise<Job | null> {
  const row = (await db.select({ schedule: migrations.schedule, resume: migrations.resume }).from(migrations).where(eq(migrations.id, migrationId)).limit(1))[0];
  const schedule = row?.schedule;
  if (!row || !schedule) return null;
  const now = resumeClock().now();
  const state = timerState(schedule, now, migrationActivity(migrationId).state !== "idle", row.resume?.at ?? null);
  if (state.state === "waiting") {
    armSchedule(db, migrationId, state.at, clients);
    return null;
  }
  const later = async (from: number | undefined, base: Schedule): Promise<void> => {
    const at = Math.max(now, row.resume?.at ?? 0) + RESUME_RETRY_MS;
    if (await writeSchedule(db, migrationId, { ...base, at }, from)) armSchedule(db, migrationId, at, clients);
  };
  if (state.state === "deferred") {
    await later(schedule.at, schedule);
    return null;
  }
  const next = nextOccurrence(schedule, now);
  if (!(await writeSchedule(db, migrationId, next, schedule.at))) return null;
  if (next !== null) armSchedule(db, migrationId, next.at, clients);
  try {
    return await startApply(db, migrationId, clients, { changes: await changesPlan(db, migrationId), unattended: true });
  } catch (error) {
    if (error instanceof ConflictError) {
      await later(next?.at, schedule);
      return null;
    }
    await recordResumeFailure(db, migrationId, error, "Bring over changes", "schedule.failed", "Open the sheet to fix it, then use Bring over changes.").catch(() => undefined);
    throw error;
  }
}

export async function rearmSchedules(db: Db, clients?: Clients): Promise<number> {
  const rows = await db.select({ id: migrations.id, schedule: migrations.schedule }).from(migrations).where(isNotNull(migrations.schedule));
  for (const row of rows) if (row.schedule) armSchedule(db, row.id, row.schedule.at, clients);
  return rows.length;
}

export async function forgetMigration(db: Db, migrationId: number): Promise<void> {
  await withSetup(migrationId, "erasing", async () => {
    await forgetDepartureArchives(migrationId);
    await cancelResume(db, migrationId);
    registry().plans.delete(migrationId);
    registry().itemIds.delete(migrationId);
    const row = (await db.select({ connectionId: migrations.connectionId }).from(migrations).where(eq(migrations.id, migrationId)).limit(1))[0];
    if (!row) return;
    await cancelSchedule(db, migrationId);
    const { plakyKey } = await keysFor(db, migrationId);
    if (plakyKey) registry().plakyByKey.delete(plakyKey);
    const runs = await db.select({ id: migrationRuns.id }).from(migrationRuns).where(eq(migrationRuns.migrationId, migrationId));
    if (runs.length) await db.delete(boardLocks).where(inArray(boardLocks.owner, runs.map((r) => String(r.id))));
    const others = await db.select({ id: migrations.id }).from(migrations).where(and(eq(migrations.connectionId, row.connectionId), ne(migrations.id, migrationId))).limit(1);
    if (others.length) await db.delete(migrations).where(eq(migrations.id, migrationId));
    else await db.delete(connections).where(eq(connections.id, row.connectionId));
  });
  try {
    await db.$client.execute("VACUUM");
  } catch (error) {
    logger.warn(`migration ${migrationId}: erased; compacting the database file failed (${failureCode(error)}), and is done again at the next erase`);
  }
  await emptyWal(db, migrationId);
}

const WAL_RETRY_MS = 60_000;

const failureCode = (error: unknown): string => {
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : error instanceof Error ? error.name : "error";
};

async function emptyWal(db: Db, migrationId: number, retrying = false): Promise<void> {
  const r = registry();
  let busy: boolean;
  try {
    const row = (await db.$client.execute("PRAGMA wal_checkpoint(TRUNCATE)")).rows[0];
    busy = Number(row?.[0] ?? 0) !== 0;
  } catch (error) {
    logger.warn(`migration ${migrationId}: erased; emptying the write-ahead log failed (${failureCode(error)})`);
    busy = true;
  }
  if (!busy || r.walRetry !== undefined) return;
  if (!retrying) logger.warn(`migration ${migrationId}: erased, but another program has the database file open, so its write-ahead log still holds the erased pages; emptying it is tried again every minute until that program lets go`);
  const handle = resumeClock().setTimeout(() => {
    r.walRetry = undefined;
    void emptyWal(db, migrationId, true);
  }, WAL_RETRY_MS);
  (handle as { unref?: () => void } | null)?.unref?.();
  r.walRetry = handle;
}
