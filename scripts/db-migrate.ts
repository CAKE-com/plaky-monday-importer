import { join } from "node:path";
import { migrate } from "drizzle-orm/libsql/migrator";
import { startupRefusal } from "../src/server/env-schema";
import { migrationFailure } from "./lib/migration-failure";

const asStart = process.argv.includes("--start");
const refusal = startupRefusal(asStart ? { ...process.env, NODE_ENV: process.env.NODE_ENV || "production" } : process.env);
if (refusal) {
  console.error(refusal);
  process.exit(1);
}

try {
  const { openDb } = await import("../src/db/client");
  const db = await openDb();
  await migrate(db, { migrationsFolder: join(import.meta.dir, "..", "drizzle") });
  await db.$client.execute("PRAGMA wal_checkpoint(TRUNCATE)");
  console.log("migrations applied");
  db.$client.close();
} catch (error) {
  console.error(migrationFailure(error));
  process.exit(1);
}
