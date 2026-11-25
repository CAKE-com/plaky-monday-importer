import { getTableName, is, sql } from "drizzle-orm";
import { SQLiteTable } from "drizzle-orm/sqlite-core";
import { z } from "zod";
import * as schema from "@/db/schema";
import { publicProcedure, router } from "./init";
import { connectionRouter } from "./routers/connection";
import { discoveryRouter } from "./routers/discovery";
import { linkRouter } from "./routers/link";
import { peopleRouter } from "./routers/people";
import { planRouter } from "./routers/plan";
import { provisionRouter } from "./routers/provision";
import { runRouter } from "./routers/run";
import { undoRouter } from "./routers/undo";
import { verifyRouter } from "./routers/verify";

const expectedTables = Object.values(schema).flatMap((value) =>
  is(value, SQLiteTable) ? [getTableName(value)] : [],
);

const healthSchema = z.object({
  ok: z.boolean(),
  db: z.boolean(),
  tables: z.number().int(),
  missing: z.array(z.string()),
});

export const appRouter = router({
  health: router({
    check: publicProcedure.output(healthSchema).query(async ({ ctx }) => {
      const rows = await ctx.db.all<{ name: string }>(
        sql`SELECT name FROM sqlite_master WHERE type = 'table'`,
      );
      const present = new Set(rows.map((row) => row.name));
      const missing = expectedTables.filter((name) => !present.has(name));
      const tables = expectedTables.length - missing.length;
      return { ok: missing.length === 0, db: true, tables, missing };
    }),
  }),
  connection: connectionRouter,
  discovery: discoveryRouter,
  provision: provisionRouter,
  link: linkRouter,
  people: peopleRouter,
  plan: planRouter,
  run: runRouter,
  undo: undoRouter,
  verify: verifyRouter,
});

export type AppRouter = typeof appRouter;
