import type { ManifestSummary, PlanSummary, ReceiptView } from "./reports";

export type OutsideTheMove = {
  boards: { name: string; reason: string }[];
  columns: { board: string; column: string; reason: string }[];
  warnings: string[];
  archivedGroups: { board: string; group: string }[];
  inactiveItems: { board: string; archived: number; deleted: number }[];
  asText: { board: string; text: string }[];
  byChoice: { board: string; column: string }[];
  deeper: { board: string; item: string }[];
  filtered: { board: string; items: number }[];
  planNotes: { board: string; text: string }[];
  authorship: boolean;
};

export const AUTHORSHIP_NOTE = "Plaky uses the API user and migration date. Original details stay in comment headers and enabled Created fields.";

export const AUTOMATIONS_NOTE = "Rebuild automations, dashboards and views in Plaky.";

const CARRIED_OTHERWISE = new Set(["name", "subtasks", "file"]);

const SKIPPED_BY_CONFIG = ": skipped by config";
export function skippedByChoice(skipped: readonly string[], notCarried: ReadonlySet<string>): string[] {
  return skipped.filter((s) => s.endsWith(SKIPPED_BY_CONFIG)).map((s) => s.slice(0, -SKIPPED_BY_CONFIG.length)).filter((s) => !notCarried.has(/\(([^()]*)\)$/.exec(s)?.[1] ?? ""));
}

export function outsideTheMove(manifest: ManifestSummary | null | undefined, plan: PlanSummary | null | undefined): OutsideTheMove {
  return {
    boards: (manifest?.skipped ?? []).map((s) => ({ name: s.name, reason: s.reason })),
    columns: (manifest?.boards ?? []).flatMap((b) => b.notCarried.filter((c) => !CARRIED_OTHERWISE.has(c.type)).map((c) => ({ board: b.name, column: `${c.title} (${c.type})`, reason: c.reason }))),
    warnings: manifest ? [...manifest.warnings, AUTOMATIONS_NOTE] : [],
    archivedGroups: [...new Map([...(manifest?.boards ?? []), ...(plan?.boards ?? [])].flatMap((b) => (b.archivedGroups ?? []).map((group) => [`${b.name}\u0000${group}`, { board: b.name, group }] as const))).values()],
    inactiveItems: (manifest?.boards ?? []).map((b) => ({ board: b.name, archived: Math.max(0, b.archivedItems - (plan?.boards.find((p) => p.mondayBoardId === b.id)?.archivedCarried ?? 0)), deleted: b.deletedItems })).filter((i) => i.archived || i.deleted),
    asText: (manifest?.boards ?? []).flatMap((b) => (b.asText ?? []).map((text) => ({ board: b.name, text }))),
    byChoice: (plan?.boards ?? []).flatMap((b) => (b.skippedByChoice ?? []).map((column) => ({ board: b.name, column }))),
    deeper: (plan?.boards ?? []).flatMap((b) => (b.deeper ?? []).map((item) => ({ board: b.name, item }))),
    filtered: (plan?.boards ?? []).flatMap((b) => (b.outOfScope ? [{ board: b.name, items: b.outOfScope }] : [])),
    planNotes: (plan?.boards ?? []).flatMap((b) => (b.notes ?? []).map((text) => ({ board: b.name, text }))),
    authorship: Boolean(manifest),
  };
}

export const isNothingOutside = (o: OutsideTheMove): boolean => !o.boards.length && !o.columns.length && !o.warnings.length && !o.archivedGroups.length && !o.inactiveItems.length && !o.asText.length && !o.byChoice.length && !o.filtered.length && !o.deeper.length && !o.planNotes.length && !o.authorship;

export const inactiveLine = (i: OutsideTheMove["inactiveItems"][number]): string =>
  `${i.board}: ${[i.archived ? `${i.archived} archived` : "", i.deleted ? `${i.deleted} deleted` : ""].filter(Boolean).join(" and ")} item(s) in monday are not carried. Turn on Carry archived items for archived items; restore deleted items in monday first. Counts come from monday’s activity log and may be incomplete.`;

export function outsideLines(o: OutsideTheMove): string[] {
  return [
    ...o.boards.map((b) => `${b.name}: ${b.reason}`),
    ...o.columns.map((c) => `${c.board}: field ${c.column}: ${c.reason}`),
    ...o.archivedGroups.map((g) => `${g.board}: group ${g.group} is archived in monday; its items are not carried`),
    ...o.inactiveItems.map(inactiveLine),
    ...o.asText.map((c) => `${c.board}: field ${c.text}`),
    ...o.byChoice.map((c) => `${c.board}: field ${c.column} is not carried, by choice (Tools → Field pairing)`),
    ...o.deeper.map((d) => `${d.board}: ${d.item} is too deep for Plaky's one level of subitems; it stays in monday with its comments and files`),
    ...o.filtered.map((f) => `${f.board}: ${f.items} item(s) left out by the board's filter (Tools → Which items move)`),
    ...o.planNotes.map((n) => `${n.board}: ${n.text}`),
    ...o.warnings,
    ...(o.authorship ? [AUTHORSHIP_NOTE] : []),
  ];
}

export function receiptDownload(receipt: ReceiptView, o: OutsideTheMove): ReceiptView & { outside_the_move: Record<string, unknown> } {
  return { ...receipt, outside_the_move: { skipped_boards: o.boards, columns_not_carried: o.columns, archived_groups: o.archivedGroups, inactive_items: o.inactiveItems, carried_as_text: o.asText, skipped_by_choice: o.byChoice, plan_notes: o.planNotes, warnings: o.warnings, ...(o.authorship ? { authorship: AUTHORSHIP_NOTE } : {}) } };
}
