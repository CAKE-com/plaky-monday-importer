import { randomUUID } from "node:crypto";
import { and, eq, inArray, lte, or, sql } from "drizzle-orm";
import type { Db } from "../../db/client";
import { boardLocks, entityMappings, migrationBoards, unansweredWrites } from "../../db/schema";
import { WRITE_LANDS_WITHIN_MS } from "../clients/plaky";
import { BoardLockedError, REFUSED_FOR_GOOD, type BoardKey, type Commit, type EntityRef, type FileMapping, type LoadStore } from "./load";
import { mappedFileIds, readFileMap, writeFileMap } from "./file-map";
import type { BoardSync } from "./config";
import { mappingState, mappingCanReconcile, RECONCILABLE_STATUSES } from "./mapping-state";
import { appliedSet } from "./board-state";

export const LEASE_MS = 2 * 60_000;

type DbLoadStoreOptions = {
  db: Db;
  migrationId: number;
  owner?: string;
  leaseMs?: number;
  autoHeartbeatMs?: number;
  now?: () => number;
};

type Status = (typeof entityMappings.$inferSelect)["status"];

export class DbLoadStore implements LoadStore {
  private readonly db: Db;
  private readonly migrationId: number;
  readonly owner: string;
  private readonly leaseMs: number;
  private readonly now: () => number;
  private readonly beatMs: number;
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly held = new Map<string, number>();

  constructor(options: DbLoadStoreOptions) {
    this.db = options.db;
    this.migrationId = options.migrationId;
    this.owner = options.owner ?? randomUUID();
    this.leaseMs = options.leaseMs ?? LEASE_MS;
    this.now = options.now ?? Date.now;
    this.beatMs = options.autoHeartbeatMs ?? this.leaseMs / 3;
  }

  async lock(boards: readonly BoardKey[]): Promise<void> {
    const taken: BoardKey[] = [];
    try {
      for (const key of boards) {
        if (!(await this.acquire(key))) throw new BoardLockedError(key);
        taken.push(key);
      }
    } catch (error) {
      await this.unlock(taken).catch(() => undefined);
      throw error;
    }
  }

  private async acquire(key: BoardKey): Promise<boolean> {
    const now = this.now();
    await this.db
      .insert(boardLocks)
      .values({ plakySpaceId: key.space, plakyBoardId: key.board, owner: this.owner, expiresAt: new Date(now + this.leaseMs) })
      .onConflictDoUpdate({
        target: [boardLocks.plakySpaceId, boardLocks.plakyBoardId],
        set: { owner: this.owner, expiresAt: new Date(now + this.leaseMs) },
        setWhere: sql`${boardLocks.expiresAt} < ${now} OR ${boardLocks.owner} = ${this.owner}`,
      });
    const [row] = await this.db
      .select({ owner: boardLocks.owner })
      .from(boardLocks)
      .where(and(eq(boardLocks.plakySpaceId, key.space), eq(boardLocks.plakyBoardId, key.board)));
    if (row?.owner !== this.owner) return false;
    const id = keyOf(key);
    this.held.set(id, (this.held.get(id) ?? 0) + 1);
    if (this.timer === undefined && this.beatMs > 0) {
      this.timer = setInterval(() => void this.heartbeat().catch(() => undefined), this.beatMs);
      this.timer.unref();
    }
    return true;
  }

  async heartbeat(): Promise<boolean> {
    const expiresAt = new Date(this.now() + this.leaseMs);
    for (const id of this.held.keys()) {
      const key = parseKey(id);
      const updated = await this.db
        .update(boardLocks)
        .set({ expiresAt })
        .where(and(eq(boardLocks.plakySpaceId, key.space), eq(boardLocks.plakyBoardId, key.board), eq(boardLocks.owner, this.owner)))
        .returning({ board: boardLocks.plakyBoardId });
      if (updated.length === 0) return false;
    }
    return true;
  }

  async unlock(boards: readonly BoardKey[]): Promise<void> {
    const failures: unknown[] = [];
    for (const key of boards) {
      const id = keyOf(key);
      const count = (this.held.get(id) ?? 0) - 1;
      if (count > 0) {
        this.held.set(id, count);
        continue;
      }
      this.held.delete(id);
      try {
        await this.db.delete(boardLocks).where(and(eq(boardLocks.plakySpaceId, key.space), eq(boardLocks.plakyBoardId, key.board), eq(boardLocks.owner, this.owner)));
      } catch (error) {
        failures.push(error);
      }
    }
    if (this.held.size === 0 && this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    if (failures.length) throw failures[0];
  }

  async markDispatched(ref: EntityRef): Promise<void> {
    await this.write(ref, "dispatched", {}, true);
  }
  async rowWriteSent(board: BoardKey, mondayItemId: string): Promise<void> {
    const sentAt = new Date(this.now());
    await this.db.insert(unansweredWrites)
      .values({ migrationId: this.migrationId, plakySpaceId: board.space, plakyBoardId: board.board, mondayItemId, sentAt })
      .onConflictDoUpdate({ target: [unansweredWrites.plakySpaceId, unansweredWrites.plakyBoardId, unansweredWrites.mondayItemId], set: { migrationId: this.migrationId, sentAt } });
  }
  async rowWriteAnswered(board: BoardKey, mondayItemId: string): Promise<void> {
    await this.db.delete(unansweredWrites).where(and(eq(unansweredWrites.plakySpaceId, board.space), eq(unansweredWrites.plakyBoardId, board.board), eq(unansweredWrites.mondayItemId, mondayItemId)));
  }
  async landingDeadline(boards: readonly BoardKey[]): Promise<number | null> {
    if (boards.length === 0) return null;
    const [row] = await this.db.select({ last: sql<number | null>`max(${unansweredWrites.sentAt})` }).from(unansweredWrites).where(onBoards(boards));
    return row?.last == null ? null : Number(row.last) + WRITE_LANDS_WITHIN_MS;
  }
  async forgetLanded(boards: readonly BoardKey[]): Promise<void> {
    if (boards.length === 0) return;
    await this.db.delete(unansweredWrites).where(and(onBoards(boards), lte(unansweredWrites.sentAt, new Date(this.now() - WRITE_LANDS_WITHIN_MS))));
  }
  async markCommitted(ref: EntityRef, commit: Commit): Promise<void> {
    await this.write(ref, "committed", commit, false);
  }
  async markAmbiguous(ref: EntityRef, error: string): Promise<void> {
    await this.write(ref, "ambiguous", { error }, false);
  }
  async markFailed(ref: EntityRef, error: string): Promise<void> {
    await this.write(ref, "failed", { error }, false);
  }

  private async write(ref: EntityRef, status: Status, patch: Commit & { error?: string }, attempt: boolean): Promise<void> {
    const at = new Date(this.now());
    const known = {
      ...(patch.plakyId == null ? {} : { plakyId: patch.plakyId }),
      ...(patch.plakyParentId == null ? {} : { plakyParentId: patch.plakyParentId }),
      ...(patch.matchKey == null ? {} : { matchKey: patch.matchKey }),
    };
    const lastError = status === "ambiguous" || status === "failed" ? (patch.error ?? null) : null;
    await this.db
      .insert(entityMappings)
      .values({
        migrationId: this.migrationId,
        entityType: ref.type,
        mondayId: ref.mondayId,
        scope: ref.scope,
        occurrence: ref.occurrence,
        status,
        attempts: attempt ? 1 : 0,
        lastError,
        updatedAt: at,
        ...known,
      })
      .onConflictDoUpdate({
        target: [entityMappings.migrationId, entityMappings.entityType, entityMappings.scope, entityMappings.mondayId, entityMappings.occurrence],
        set: { status, lastError, updatedAt: at, ...known, ...(attempt ? { attempts: sql`${entityMappings.attempts} + 1` } : {}) },
      });
  }

  async refusedBefore(ref: EntityRef): Promise<string | null> {
    const row = (await this.db.select({ status: entityMappings.status, lastError: entityMappings.lastError }).from(entityMappings)
      .where(and(eq(entityMappings.migrationId, this.migrationId), eq(entityMappings.entityType, ref.type), eq(entityMappings.scope, ref.scope), eq(entityMappings.mondayId, ref.mondayId), eq(entityMappings.occurrence, ref.occurrence))).limit(1))[0];
    return mappingState(row) === "refused" ? row!.lastError!.slice(REFUSED_FOR_GOOD.length) : null;
  }

  async filesMapped(mondayItemId: string): Promise<FileMapping[]> {
    return readFileMap(this.db, this.migrationId, mondayItemId);
  }

  async fileIdsOn(plakyItemId: number): Promise<ReadonlySet<number>> {
    return mappedFileIds(this.db, this.migrationId, plakyItemId);
  }

  async mapFile(mondayItemId: string, mapping: FileMapping): Promise<void> {
    await writeFileMap(this.db, this.migrationId, mondayItemId, mapping, new Date(this.now()));
  }

  async reconcile(settled: readonly { ref: EntityRef; commit: Commit }[]): Promise<void> {
    if (!settled.length) return;
    const types = [...new Set(settled.map((s) => s.ref.type))];
    const pending = (await this.db.select().from(entityMappings)
      .where(and(eq(entityMappings.migrationId, this.migrationId), inArray(entityMappings.entityType, types), inArray(entityMappings.status, [...RECONCILABLE_STATUSES]))))
      .filter(mappingCanReconcile);
    if (!pending.length) return;
    const keyOf = (type: string, scope: string, mondayId: string, occurrence: number): string => [type, scope, mondayId, String(occurrence)].join("\u0000");
    const byKey = new Map(settled.map((s) => [keyOf(s.ref.type, s.ref.scope, s.ref.mondayId, s.ref.occurrence), s.commit]));
    const at = new Date(this.now());
    for (const row of pending) {
      const commit = byKey.get(keyOf(row.entityType, row.scope, row.mondayId, row.occurrence));
      if (commit === undefined) continue;
      await this.db.update(entityMappings)
        .set({ status: "committed", lastError: null, updatedAt: at, plakyId: commit.plakyId, ...(commit.plakyParentId == null ? {} : { plakyParentId: commit.plakyParentId }), ...(commit.matchKey == null ? {} : { matchKey: commit.matchKey }) })
        .where(eq(entityMappings.id, row.id));
    }
  }

  async markApplied(board: BoardSync): Promise<void> {
    const updated = await appliedSet(this.db, this.migrationId, board.mondayBoardId, true).returning({ id: migrationBoards.id });
    if (updated.length === 0) throw new Error(`migration ${this.migrationId} has no board row for monday board ${board.mondayBoardId} to mark applied`);
  }

  async markUnapplied(board: BoardSync): Promise<void> {
    await appliedSet(this.db, this.migrationId, board.mondayBoardId, false);
  }
}

const keyOf = (key: BoardKey): string => `${key.space}/${key.board}`;
const onBoards = (boards: readonly BoardKey[]) =>
  or(...boards.map((b) => and(eq(unansweredWrites.plakySpaceId, b.space), eq(unansweredWrites.plakyBoardId, b.board))));
const parseKey = (id: string): BoardKey => {
  const [space, board] = id.split("/").map(Number);
  return { space: space!, board: board! };
};
