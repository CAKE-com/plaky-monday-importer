import { createHash } from "node:crypto";
import type { irItems } from "../../../db/schema";
import { isDict } from "../transform/pystr";
import { cmpCodePoints } from "../transform/pyvalue";
import type { BoardPlan, PlannedWrite } from "./writes";

export type IrRow = Omit<typeof irItems.$inferInsert, "id" | "migrationBoardId">;

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isDict(value)) {
    return `{${Object.keys(value)
      .sort(cmpCodePoints)
      .filter((key) => value[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

const contentHash = (write: Pick<PlannedWrite, "fields" | "title" | "groupTitle">): string =>
  createHash("sha256").update(canonicalJson({ plakyFields: write.fields, title: write.title, groupTitle: write.groupTitle })).digest("hex");

export function irRows(plan: BoardPlan): IrRow[] {
  return plan.writes.map((write, index) => ({
    mondayItemId: write.mondayItemId,
    parentMondayItemId: write.parentMondayItemId,
    title: write.title,
    groupTitle: write.groupTitle,
    state: "active",
    position: index,
    plakyFields: write.fields,
    subscriberIds: write.subscriberIds,
    warnings: write.warnings,
    notCarried: write.notCarried,
    uncleared: write.uncleared,
    contentHash: contentHash(write),
  }));
}
