import { createHash } from "node:crypto";
import type { Db } from "@/db/client";
import type { ReceiptScope, ReceiptStamp } from "@/lib/receipt-envelope";
import { baseBoardId } from "./names";
import type { BoardSync, SyncConfig } from "./config";
import { getMigration, loadLinkConfig } from "./store";

function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => [k, sorted(v)]));
  }
  return value;
}
const hash = (value: unknown): string => createHash("sha256").update(JSON.stringify(sorted(value))).digest("hex").slice(0, 16);

const RUNTIME_BOARD_KEYS = new Set<keyof BoardSync>(["applied", "seedGroupId", "name"]);
const UNCOMPARED_OPTIONS = new Set(["draft", "pick", "filters", "prune", "recreateDrifted", "allowDuplicateImport"]);

type MigrationSetup = { options: Record<string, unknown>; people: Record<string, unknown> };

function receiptScope(migration: MigrationSetup, config: SyncConfig | null): ReceiptScope {
  const filters = (migration.options["filters"] ?? {}) as Record<string, unknown>;
  const options = Object.fromEntries(Object.entries(migration.options).filter(([key]) => !UNCOMPARED_OPTIONS.has(key)));
  const boards: Record<string, string> = {};
  for (const board of config?.boards ?? []) {
    const pairing = Object.fromEntries(Object.entries(board).filter(([key]) => !RUNTIME_BOARD_KEYS.has(key as keyof BoardSync)));
    const filterOf = (id: string | null): unknown => (id === null ? null : (filters[id] ?? filters[baseBoardId(id)] ?? null));
    boards[board.mondayBoardId] = hash({ pairing, options, people: migration.people, filter: filterOf(board.mondayBoardId), parentFilter: filterOf(board.subitemsOf) });
  }
  return { fingerprint: hash(boards), boards };
}

export async function currentScope(db: Db, migrationId: number): Promise<ReceiptScope> {
  const [migration, loaded] = await Promise.all([getMigration(db, migrationId), loadLinkConfig(db, migrationId)]);
  return receiptScope(migration, loaded?.config ?? null);
}

export async function stampedReceipt(db: Db, migrationId: number, receipt: Record<string, unknown>, at: { sourceReadAt: number; checkedAt: number; writtenAt?: number | undefined }): Promise<Record<string, unknown>> {
  const stamp: ReceiptStamp = {
    source_read_at: new Date(at.sourceReadAt).toISOString(),
    ...(at.writtenAt === undefined ? {} : { written_at: new Date(at.writtenAt).toISOString() }),
    checked_at: new Date(at.checkedAt).toISOString(),
    scope: await currentScope(db, migrationId),
  };
  return { ...receipt, ...stamp };
}
