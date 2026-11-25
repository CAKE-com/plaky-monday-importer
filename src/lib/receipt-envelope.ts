import { z } from "zod";
import { receiptDownload, type OutsideTheMove } from "./outside";
import type { ReceiptView } from "./reports";

export const receiptScope = z.object({ fingerprint: z.string(), boards: z.record(z.string(), z.string()) });
export type ReceiptScope = z.infer<typeof receiptScope>;

const receiptStamp = z.object({ source_read_at: z.string(), written_at: z.string().optional(), checked_at: z.string(), scope: receiptScope });
export type ReceiptStamp = z.infer<typeof receiptStamp>;

export function stampOf(stored: unknown): ReceiptStamp | null {
  const parsed = receiptStamp.safeParse(stored);
  return parsed.success ? parsed.data : null;
}

export const receiptFreshnessSchema = z.object({ stale: z.boolean(), whole: z.boolean(), boards: z.array(z.string()), reasons: z.array(z.string()) });
type ReceiptFreshness = z.infer<typeof receiptFreshnessSchema>;

export const LATER_RUN = "A later run changed data after this check.";
const UNDONE_AFTER = "An undo deleted data after this check.";
export const UNDATED = "This check was saved without its check time (an earlier version), so it cannot be shown as current.";
const SETUP_CHANGED = "Settings changed after this check (pairing, people, item filter or options)";

export function receiptFreshness(f: {
  checked: readonly { monday_board_id: string; name: string }[] | null; stamp: ReceiptStamp | null;
  receiptRunId: number | null; latestRunId: number | null; undoneAfter: boolean; scope: ReceiptScope;
}): ReceiptFreshness {
  if (f.checked === null) return { stale: false, whole: false, boards: [], reasons: [] };
  const reasons: string[] = [];
  if (f.stamp === null) reasons.push(UNDATED);
  if (f.receiptRunId !== null && f.latestRunId !== null && f.latestRunId !== f.receiptRunId) reasons.push(LATER_RUN);
  if (f.undoneAfter) reasons.push(UNDONE_AFTER);
  const whole = reasons.length > 0;
  const stamp = f.stamp;
  const changed = stamp === null ? [] : f.checked.filter((b) => stamp.scope.boards[b.monday_board_id] !== f.scope.boards[b.monday_board_id]);
  if (changed.length) reasons.push(`${SETUP_CHANGED}: ${changed.map((b) => b.name).join(", ")}.`);
  return { stale: reasons.length > 0, whole, boards: changed.map((b) => b.monday_board_id), reasons };
}

export const RECEIPT_ENVELOPE_VERSION = 2;

type EnvelopeSource = {
  receipt: ReceiptView; receiptRunId: number | null;
  run?: { id: number; kind: string; status: string; startedAt: number; finishedAt: number | null } | null;
  checkedAt?: number | null; sourceReadAt?: number | null; writtenAt?: number | null; scopeFingerprint?: string | null;
  freshness?: ReceiptFreshness | undefined;
};

const iso = (ms: number | null | undefined): string | null => (ms === null || ms === undefined ? null : new Date(ms).toISOString());

export function receiptEnvelope(v: EnvelopeSource, outside: OutsideTheMove) {
  const freshness = v.freshness ?? { stale: true, whole: true, boards: [], reasons: [UNDATED] };
  return {
    version: RECEIPT_ENVELOPE_VERSION,
    runId: v.receiptRunId,
    checkedAt: iso(v.checkedAt),
    sourceReadAt: iso(v.sourceReadAt),
    ...(v.writtenAt ? { writtenAt: iso(v.writtenAt) } : {}),
    scopeFingerprint: v.scopeFingerprint ?? null,
    stale: freshness.stale,
    staleReasons: freshness.reasons,
    staleBoards: freshness.boards,
    lastRun: v.run ? { id: v.run.id, kind: v.run.kind, status: v.run.status, startedAt: iso(v.run.startedAt), finishedAt: iso(v.run.finishedAt) } : null,
    receipt: receiptDownload(v.receipt, outside),
  };
}
