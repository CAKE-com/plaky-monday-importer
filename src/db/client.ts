import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createClient, type Client } from "@libsql/client";
import { drizzle, type LibSQLDatabase } from "drizzle-orm/libsql";
import { env } from "@/server/env";
import * as schema from "./schema";

export type Db = LibSQLDatabase<typeof schema> & { $client: Client };

const BUSY_TIMEOUT_MS = 5000;

export async function openDb(url: string = env.DATABASE_URL): Promise<Db> {
  if (url.startsWith("file:") && !url.includes(":memory:")) {
    const dir = dirname(url.slice("file:".length));
    const made = mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (made !== undefined) chmodSync(made, 0o700);
  }
  const client = createClient({ url, timeout: BUSY_TIMEOUT_MS, concurrency: 1 });
  if (url.startsWith("file:")) {
    await client.execute("PRAGMA journal_mode = WAL");
    await client.execute("PRAGMA secure_delete = ON");
    await client.execute("PRAGMA journal_size_limit = 0");
    if (!url.includes(":memory:")) ownerOnly(url.slice("file:".length));
  }
  await client.execute("PRAGMA foreign_keys = ON");
  return drizzle(client, { schema });
}

function ownerOnly(path: string): void {
  for (const f of [path, `${path}-wal`, `${path}-shm`]) {
    try {
      chmodSync(f, 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

const globalForDb = globalThis as unknown as { __mmwDb?: Promise<Db> };

export function getDb(): Promise<Db> {
  if (!globalForDb.__mmwDb) {
    const opening = openDb();
    opening.catch(() => {
      if (globalForDb.__mmwDb === opening) delete globalForDb.__mmwDb;
    });
    globalForDb.__mmwDb = opening;
  }
  return globalForDb.__mmwDb;
}
