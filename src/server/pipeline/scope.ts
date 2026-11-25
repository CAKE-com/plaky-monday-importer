import { z } from "zod";
import type { ExtractedItem } from "./extract";

export const CREATED = "__created_at";

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const itemFilter = z.object({
  groups: z.array(z.string().max(200)).max(500).optional(),
  status: z.object({ columnId: z.string().max(200), labels: z.array(z.string().max(500)).min(1).max(500) }).optional(),
  date: z.object({ columnId: z.string().max(200), from: day.optional(), to: day.optional() }).optional(),
});
export type ItemFilter = z.infer<typeof itemFilter>;
export type ItemFilters = Record<string, ItemFilter>;

export function inScope(item: Pick<ExtractedItem, "groupId" | "columnValues">, filter: ItemFilter): boolean {
  if (filter.groups && !(item.groupId !== null && filter.groups.includes(item.groupId))) return false;
  if (filter.status && !filter.status.labels.includes(item.columnValues[filter.status.columnId]?.text ?? "")) return false;
  if (filter.date) {
    const at = (item.columnValues[filter.date.columnId]?.text ?? "").slice(0, 10);
    if (!at || (filter.date.from && at < filter.date.from) || (filter.date.to && at > filter.date.to)) return false;
  }
  return true;
}

export const narrows = (filter: ItemFilter | undefined): filter is ItemFilter =>
  Boolean(filter && (filter.groups || filter.status || (filter.date && (filter.date.from || filter.date.to))));

export type ExtractScope = { filter?: ItemFilter; parentsOut?: ReadonlySet<string> };
export const keeps = (scope: ExtractScope, item: ExtractedItem): boolean =>
  (!scope.filter || inScope(item, scope.filter)) && !(item.parentId !== null && scope.parentsOut?.has(item.parentId));

type ScopeChoices = {
  groups: readonly { id: string }[];
  columns: readonly { id: string; type: string; labels: readonly string[] }[];
};
export function filterProblem(filter: ItemFilter, board: ScopeChoices): string | null {
  const unknown = filter.groups?.find((id) => !board.groups.some((g) => g.id === id));
  if (unknown !== undefined) return `the board has no group ${unknown}`;
  if (filter.groups && !filter.groups.length) return "pick at least one group";
  if (filter.status) {
    const column = board.columns.find((c) => c.id === filter.status?.columnId && c.type === "status");
    if (!column) return `the board has no status column ${filter.status.columnId}`;
    const label = filter.status.labels.find((l) => !column.labels.includes(l));
    if (label !== undefined) return `the status column has no label "${label}"`;
  }
  if (filter.date) {
    if (filter.date.columnId !== CREATED && !board.columns.some((c) => c.id === filter.date?.columnId && c.type === "date")) return `the board has no date column ${filter.date.columnId}`;
    if (filter.date.from && filter.date.to && filter.date.from > filter.date.to) return "the date range ends before it starts";
  }
  return null;
}
