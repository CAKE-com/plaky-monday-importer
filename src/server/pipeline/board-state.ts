import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "@/db/client";
import { migrationBoards } from "@/db/schema";

export type Pairing = "unpaired" | "paired";
export type Applied = "untouched" | "written";
export type Sync = "unsynced" | "in_step";
export type BoardState = { pairing: Pairing; applied: Applied; sync: Sync };

type Moves<S extends string> = Readonly<Record<S, { readonly from: readonly S[]; readonly by: string }>>;
export const BOARD_REACHED_FROM: { pairing: Moves<Pairing>; applied: Moves<Applied>; sync: Moves<Sync> } = {
  pairing: {
    paired: { from: ["unpaired", "paired"], by: "link: a seed found for the board, or an earlier pairing re-pointed" },
    unpaired: { from: ["paired"], by: "link: the recorded Plaky board is gone from the space" },
  },
  applied: {
    written: { from: ["untouched"], by: "the loader, just before the board's first write" },
    untouched: { from: ["written"], by: "the loader, when every write of the run was definitely refused and no row carried a Monday ID; undo, once nothing of ours is left; link, when the board is re-paired" },
  },
  sync: {
    in_step: { from: ["unsynced", "in_step"], by: "recordSyncPoints, after a run that left the board clean" },
    unsynced: { from: ["in_step"], by: "a shortfall at verify, a re-link that changes the board's writes, undo, an option that needs a full read" },
  },
};

export function boardState(row: { plakyBoardId: number | null; applied: boolean; syncedReadAt: Date | null }): BoardState {
  return { pairing: row.plakyBoardId === null ? "unpaired" : "paired", applied: appliedState(row), sync: row.syncedReadAt === null ? "unsynced" : "in_step" };
}

export const appliedState = (board: { applied: boolean }): Applied => (board.applied ? "written" : "untouched");

export async function readBoardStates(db: Db, migrationId: number): Promise<Map<string, BoardState>> {
  const rows = await db.select({ mondayBoardId: migrationBoards.mondayBoardId, plakyBoardId: migrationBoards.plakyBoardId, applied: migrationBoards.applied, syncedReadAt: migrationBoards.syncedReadAt })
    .from(migrationBoards).where(eq(migrationBoards.migrationId, migrationId));
  return new Map(rows.map((r) => [r.mondayBoardId, boardState(r)]));
}

const ofBoard = (migrationId: number, mondayBoardId: string) => and(eq(migrationBoards.migrationId, migrationId), eq(migrationBoards.mondayBoardId, mondayBoardId));

export const pairingSet = (db: Db, migrationId: number, mondayBoardId: string, plakyBoardId: number | null) =>
  db.update(migrationBoards).set({ plakyBoardId }).where(ofBoard(migrationId, mondayBoardId));

export const appliedSet = (db: Db, migrationId: number, mondayBoardId: string, applied: boolean) =>
  db.update(migrationBoards).set({ applied }).where(ofBoard(migrationId, mondayBoardId));

export const syncPointSet = (db: Db, migrationId: number, mondayBoardIds: readonly string[], readAt: number) =>
  db.update(migrationBoards).set({ syncedReadAt: new Date(readAt) }).where(and(eq(migrationBoards.migrationId, migrationId), inArray(migrationBoards.mondayBoardId, [...mondayBoardIds])));

export const syncPointsCleared = (db: Db, migrationId: number, mondayBoardIds?: readonly string[]) =>
  db.update(migrationBoards).set({ syncedReadAt: null })
    .where(and(eq(migrationBoards.migrationId, migrationId), ...(mondayBoardIds ? [inArray(migrationBoards.mondayBoardId, [...mondayBoardIds])] : [])));
