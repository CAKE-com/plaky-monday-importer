import { getDb, type Db } from "@/db/client";
import { clientsWith, sweepInterrupted, type Clients } from "@/server/jobs/runner";
import type { Keys } from "@/server/pipeline/store";

export type Context = {
  db: Db;
  clients?: ((keys: Partial<Keys>) => Clients) | undefined;
};

export async function createContext(): Promise<Context> {
  const db = await getDb();
  await sweepInterrupted(db);
  return { db, clients: clientsWith };
}
