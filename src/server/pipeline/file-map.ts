import { and, eq } from "drizzle-orm";
import type { Db } from "../../db/client";
import { fileMap } from "../../db/schema";
import type { FileMapping } from "./load";

export async function readFileMap(db: Db, migrationId: number, mondayItemId: string): Promise<FileMapping[]> {
  return db.select({ assetId: fileMap.mondayAssetId, occurrence: fileMap.occurrence, plakyItemId: fileMap.plakyItemId, plakyFileId: fileMap.plakyFileId })
    .from(fileMap).where(and(eq(fileMap.migrationId, migrationId), eq(fileMap.mondayItemId, mondayItemId)));
}

export async function mappedFileIds(db: Db, migrationId: number, plakyItemId?: number): Promise<Set<number>> {
  const rows = await db.select({ plakyFileId: fileMap.plakyFileId }).from(fileMap)
    .where(plakyItemId === undefined ? eq(fileMap.migrationId, migrationId) : and(eq(fileMap.migrationId, migrationId), eq(fileMap.plakyItemId, plakyItemId)));
  return new Set(rows.map((r) => r.plakyFileId));
}

export async function writeFileMap(db: Db, migrationId: number, mondayItemId: string, mapping: FileMapping, at: Date): Promise<void> {
  const target = { plakyItemId: mapping.plakyItemId, plakyFileId: mapping.plakyFileId, updatedAt: at };
  await db.insert(fileMap)
    .values({ migrationId, mondayItemId, mondayAssetId: mapping.assetId, occurrence: mapping.occurrence, ...target })
    .onConflictDoUpdate({ target: [fileMap.migrationId, fileMap.mondayItemId, fileMap.mondayAssetId, fileMap.occurrence], set: target });
}
