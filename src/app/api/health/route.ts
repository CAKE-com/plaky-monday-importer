import { sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import { refuseRequest } from "@/server/request-guard";
import { appRouter } from "@/server/trpc/router";
import journal from "../../../../drizzle/meta/_journal.json";

const SHIPPED = journal.entries.length;

export async function GET(req: Request): Promise<Response> {
  const refusal = refuseRequest(req.headers);
  if (refusal) return Response.json({ error: refusal }, { status: 403 });
  try {
    const db = await getDb();
    const check = await appRouter.createCaller({ db }).health.check();
    const applied = await db.all<{ n: number }>(sql`SELECT count(*) AS n FROM __drizzle_migrations`).then((rows) => Number(rows[0]?.n ?? 0), () => 0);
    const pending = Math.max(0, SHIPPED - applied);
    const ok = check.ok && pending === 0;
    const body = { app: "monday-to-plaky-migrator", ok, db: "ok", tables: check.tables, missing: check.missing, migrations: applied, pending };
    return Response.json(body, { status: ok ? 200 : 503, headers: { "cache-control": "no-store" } });
  } catch {
    return Response.json({ app: "monday-to-plaky-migrator", ok: false, db: "unavailable", tables: 0, missing: [], migrations: 0, pending: SHIPPED }, { status: 503, headers: { "cache-control": "no-store" } });
  }
}
