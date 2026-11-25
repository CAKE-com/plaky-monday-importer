import type { migrations } from "@/db/schema";

export type MigrationStatus = (typeof migrations.$inferSelect)["status"];

const SETTLED: readonly MigrationStatus[] = ["draft", "discovered", "linked", "planned", "interrupted", "completed", "failed"];

export const REACHED_FROM: Readonly<Record<MigrationStatus, readonly MigrationStatus[]>> = {
  draft: [],
  discovered: SETTLED,
  linked: SETTLED,
  planned: ["draft", "discovered", "linked", "planned"],
  running: SETTLED,
  completed: ["running", "failed"],
  failed: [...SETTLED, "running"],
  interrupted: [...SETTLED, "running"],
};
