import type { entityMappings } from "@/db/schema";

type Mapping = Pick<typeof entityMappings.$inferSelect, "status" | "lastError">;
export const REFUSED_FOR_GOOD = "refused for good: ";
type MappingState = "untracked" | "dispatched" | "committed" | "ambiguous" | "retryable_failure" | "refused";
export const RECONCILABLE_STATUSES = ["dispatched", "ambiguous", "failed"] as const;

export function mappingState(row: Mapping | null | undefined): MappingState {
  if (!row) return "untracked";
  if (row.status === "failed") return row.lastError?.startsWith(REFUSED_FOR_GOOD) ? "refused" : "retryable_failure";
  return row.status;
}

export function mappingUncertain(row: Mapping): boolean {
  const state = mappingState(row);
  return state === "dispatched" || state === "ambiguous";
}

export function mappingCanReconcile(row: Mapping): boolean {
  const state = mappingState(row);
  return state === "dispatched" || state === "ambiguous" || state === "retryable_failure";
}
