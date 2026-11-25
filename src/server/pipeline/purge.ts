import { and, desc, inArray, sql } from "drizzle-orm";
import type { Db } from "@/db/client";
import { boardLocks, connections, migrationRuns, migrations } from "@/db/schema";

export async function purgeFinished(db: Db): Promise<number> {
  const all = await db.select({ id: migrations.id, status: migrations.status, resume: migrations.resume, schedule: migrations.schedule, updatedAt: migrations.updatedAt }).from(migrations);
  const running = await db.select({ n: sql<number>`count(*)` }).from(migrationRuns).where(sql`${migrationRuns.status} = 'running'`);
  const newest = new Map<number, string>();
  for (const run of await db.select({ migrationId: migrationRuns.migrationId, status: migrationRuns.status }).from(migrationRuns).where(inArray(migrationRuns.kind, ["apply", "verify"])).orderBy(desc(migrationRuns.id))) {
    if (!newest.has(run.migrationId)) newest.set(run.migrationId, run.status);
  }
  const finished = (m: (typeof all)[number]): boolean => m.status === "completed" && (newest.get(m.id) ?? "succeeded") === "succeeded";
  if (!all.length || running[0]!.n > 0 || all.some((m) => !finished(m) || m.resume !== null || m.schedule !== null)) return 0;
  const selected = (await db.select({ id: connections.id }).from(connections)).map((c) => c.id);

  const revisions = sql.join(all.map((m) => sql`(${m.id}, ${m.updatedAt.getTime()})`), sql`, `);
  const stillEligible = sql`(SELECT count(*) FROM migrations) = ${all.length}
    AND NOT EXISTS (SELECT 1 FROM migrations m WHERE (m.id, m.updated_at) NOT IN (VALUES ${revisions})
      OR m.status <> 'completed' OR m.resume IS NOT NULL OR m.schedule IS NOT NULL
      OR coalesce((SELECT r.status FROM migration_runs r WHERE r.migration_id = m.id AND r.kind IN ('apply', 'verify') ORDER BY r.id DESC LIMIT 1), 'succeeded') <> 'succeeded')
    AND NOT EXISTS (SELECT 1 FROM migration_runs r WHERE r.status = 'running')`;
  const none = sql`NOT EXISTS (SELECT 1 FROM migrations)`;
  const [gone] = await db.batch([
    db.delete(migrations).where(and(inArray(migrations.id, all.map((m) => m.id)), stillEligible)).returning({ id: migrations.id }),
    db.delete(connections).where(and(inArray(connections.id, selected), sql`NOT EXISTS (SELECT 1 FROM migrations WHERE migrations.connection_id = ${connections.id})`, none)),
    db.delete(boardLocks).where(none),
  ]);
  if (!gone.length) return 0;
  await db.$client.execute("VACUUM");
  await db.$client.execute("PRAGMA wal_checkpoint(TRUNCATE)");
  return gone.length;
}
