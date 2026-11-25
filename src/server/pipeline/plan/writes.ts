import type { BoardSync } from "../config";
import { redactString } from "../../redact";
import type { PlannedComment } from "../transform/comments";
import type { MondayFile } from "../transform/files";
import type { FieldMap } from "../transform/mapping";
import type { PlannedGroup } from "../transform/order";
import type { SpareCopy } from "./copies";
import { plannedMoves, type Placement } from "./placement";

export const MAX_PLAKY_PAGE_SIZE = 1000;

export const SHARED_ID_FIX =
  'Plaky\'s "Duplicate item" copies the Monday ID: in the copy (titled "... (duplicated)" unless renamed), clear the Monday ID field, or delete the copy if it is not needed. ' +
  "Then re-run.";

export class SyncSetupError extends Error {
  override readonly name = "SyncSetupError";
}

export type PlannedWrite = {
  mondayItemId: string;
  title: string;
  groupTitle: string | null;
  fields: Record<string, unknown>;
  existingItemId: number | null;
  existingTitle: string | null;
  unchanged: boolean;
  sameFields: boolean;
  sameSubscribers: boolean;
  drifted: boolean;
  subscriberIds: number[];
  existingFields: Record<string, unknown> | null;
  existingGroupId: number | null;
  existingSubscriberIds: number[];
  warnings: string[];
  notCarried: string[];
  parentMondayItemId: string | null;
  uncleared: string[];
};

export function plannedWrite(init: Pick<PlannedWrite, "mondayItemId" | "title" | "groupTitle" | "fields"> & Partial<PlannedWrite>): PlannedWrite {
  return {
    existingItemId: null,
    existingTitle: null,
    unchanged: false,
    sameFields: false,
    sameSubscribers: false,
    drifted: false,
    subscriberIds: [],
    existingFields: null,
    existingGroupId: null,
    existingSubscriberIds: [],
    warnings: [],
    notCarried: [],
    parentMondayItemId: null,
    uncleared: [],
    ...init,
  };
}

export function writeAction(write: PlannedWrite): "create" | "update" | "unchanged" {
  if (!write.existingItemId) return "create";
  return write.unchanged ? "unchanged" : "update";
}

export type ItemFiles = {
  assets: MondayFile[];
  plakyItemId: number | null;
  fileCount: number;
};

export type ItemComments = {
  planned: PlannedComment[];
  plakyItemId: number | null;
  commentCount: number;
  settled?: boolean;
};

export type BoardPlan = {
  config: BoardSync;
  mondayBoardName: string;
  plakyBoardName: string;
  fieldMap: FieldMap;
  writes: PlannedWrite[];
  groupWrites: PlannedGroup[];
  orphans: [itemId: number, title: string][];
  deeper?: { id: string; name: string; level: number }[];
  archivedCarried?: number;
  outOfScope?: number;
  groupIds: Map<string, number>;
  notes: string[];
  mondayIdKey: string | null;
  seedGroupId: number | null;
  comments: Map<string, ItemComments>;
  files: Map<string, ItemFiles>;
  uncarried: string[];
  archivedGroups: string[];
  existingIds: ReadonlyMap<string, number>;
  copies: SpareCopy[];
  placement?: Placement;
  assigneeNames?: ReadonlyMap<string, string>;
};

function commentEstimate(entry: ItemComments): number {
  const top = entry.planned.filter((c) => c.kind !== "reply").length;
  const missing = Math.max(0, top - entry.commentCount);
  return missing + (missing > 0 ? entry.planned.length - top : 0);
}

export function commentsToWrite(plan: BoardPlan): number {
  let total = 0;
  for (const entry of plan.comments.values()) total += commentEstimate(entry);
  return total;
}

export function filesToUpload(plan: BoardPlan): number {
  let total = 0;
  for (const entry of plan.files.values()) total += Math.max(0, entry.assets.length - entry.fileCount);
  return total;
}

export const GROUP_COLORS = ["#283593", "#00796B", "#C62828", "#6A1B9A", "#EF6C00", "#37474F"] as const;

export const MAX_TITLE = 255;

export function failureText(error: unknown): string {
  if (error instanceof Error) return redactString(error.message || error.name);
  return redactString(String(error) || "Error");
}

export function replacesSubscribers(config: BoardSync, write: PlannedWrite): boolean {
  return config.syncSubscribers && write.subscriberIds.length > 0 && !write.sameSubscribers;
}

export function plannedWrites(plans: readonly BoardPlan[], options: { prune?: boolean; recreateDrifted?: boolean } = {}): number {
  let total = 0;
  for (const plan of plans) {
    const rebuilt = new Set(plan.writes.filter((write) => options.recreateDrifted && write.drifted && write.existingItemId).map((write) => write.mondayItemId));
    for (const write of plan.writes) {
      if (rebuilt.has(write.mondayItemId)) total += 2;
      else if (writeAction(write) === "create") total += 1;
      else if (writeAction(write) === "update") {
        total += write.sameFields ? 0 : 1;
        total += replacesSubscribers(plan.config, write) ? 1 : 0;
      }
    }
    total += plan.groupWrites.length;
    total += options.prune ? plan.orphans.length : 0;
    total += plan.seedGroupId !== null ? 1 : 0;
    total += plan.copies.length;
    total += plannedMoves(plan, rebuilt);
    for (const [mondayId, held] of plan.comments) total += rebuilt.has(mondayId) ? held.planned.length : commentEstimate(held);
    total += filesToUpload(plan);
    for (const [mondayId, held] of plan.files) if (rebuilt.has(mondayId)) total += Math.min(held.assets.length, held.fileCount);
  }
  return total;
}
