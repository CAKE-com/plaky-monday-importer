import { z } from "zod";

const planBoardSummary = z.object({
  name: z.string(), mondayBoardId: z.string(), creates: z.number(), updates: z.number(), unchanged: z.number(), drifted: z.number(), orphans: z.number(),
  groupWrites: z.number(), comments: z.number(), files: z.number(), uncarried: z.array(z.string()), notCarriedValues: z.number(),
  archivedGroups: z.array(z.string()).optional(),
  skippedByChoice: z.array(z.string()).optional(),
  deeper: z.array(z.string()).optional(),
  archivedCarried: z.number().optional(),
  outOfScope: z.number().optional(),
  docExports: z.number().optional(),
  notes: z.array(z.string()).optional(),
});
export const planSummary = z.object({
  at: z.number(),
  boards: z.array(planBoardSummary),
  plannedWrites: z.number(),
  estimateMinutes: z.number(),
  failures: z.array(z.string()),
  mondayCalls: z.number().optional(),
  setup: z.string().optional(),
});
export type PlanSummary = z.infer<typeof planSummary>;

export const planDetails = z.object({ boards: z.array(z.object({ name: z.string(), creates: z.array(z.string()), updates: z.array(z.string()), notCarried: z.array(z.string()) })) });

const receiptBoard = z.object({
  name: z.string(), monday_board_id: z.string(), plaky_board_id: z.number(), monday_items: z.number(), plaky_items: z.number(), matched: z.number(),
  missing: z.array(z.string()), extra: z.array(z.string()), unidentified: z.array(z.string()), seed_rows: z.number(),
  coverage: z.array(z.object({ name: z.string(), monday_filled: z.number(), plaky_filled: z.number(), shortfall: z.number() })),
  dropped: z.array(z.string()), notes: z.array(z.string()), differing: z.array(z.string()), not_carried: z.array(z.string()),
  comments_or_files_short: z.boolean(), uncarried: z.array(z.string()), complete: z.boolean(),
});
export const receiptSchema = z.object({
  ok: z.boolean(), monday_items: z.number(), matched: z.number(), boards: z.array(receiptBoard), failures: z.array(z.string()), unmatched_users: z.array(z.string()),
});
export type ReceiptView = z.infer<typeof receiptSchema>;

export const estimateMinutes = (writes: number): number => Math.ceil(writes / 190);

export const manifestSummary = z.object({
  generatedAt: z.string(),
  boards: z.array(z.object({
    id: z.string(), name: z.string(), items: z.number(), subitemsOf: z.string().nullable(), nested: z.boolean(), plakyBoardId: z.number().nullable(), fields: z.number(),
    carried: z.number(), notCarried: z.array(z.object({ title: z.string(), type: z.string(), reason: z.string() })), warnings: z.array(z.string()), byHand: z.array(z.string()),
    archivedItems: z.number().default(0), deletedItems: z.number().default(0),
    archivedGroups: z.array(z.string()).optional(),
    asText: z.array(z.string()).default([]),
  })),
  skipped: z.array(z.object({ id: z.string(), name: z.string(), kind: z.string(), reason: z.string() })),
  warnings: z.array(z.string()),
  people: z.number(),
});
export type ManifestSummary = z.infer<typeof manifestSummary>;
