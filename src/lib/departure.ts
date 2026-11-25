import { currentManualTasks } from "./manual-work";
import type { ManifestSummary, PlanSummary, ReceiptView } from "./reports";
import { outsideTheMove, AUTHORSHIP_NOTE } from "./outside";

export type DepartureCategory = "preserved" | "converted" | "manual" | "unavailable";
export type DepartureEntry = { category: DepartureCategory; subject: string; detail: string };
export const DEPARTURE_LABELS: Record<DepartureCategory, string> = {
  preserved: "Preserved", converted: "Converted", manual: "Needs manual work", unavailable: "Can't be carried",
};
type DepartureOptions = { syncComments?: boolean; syncFiles?: boolean; syncSubscribers?: boolean; withCreated?: boolean };
export type DeparturePreflight = {
  scope: string;
  verification: "not_checked" | "needs_attention" | "out_of_date" | "matched";
  entries: DepartureEntry[];
};

type VerificationFacts = {
  receiptRunId: number | null; run: { id: number } | null; undoneAfter?: boolean | undefined;
  freshness?: { whole: boolean; boards: readonly string[] } | undefined;
};

export function receiptStaleness(v: VerificationFacts | null | undefined, active = false): { stale: boolean; staleBoards: readonly string[] } {
  return {
    stale: active || v?.undoneAfter === true || v?.freshness?.whole === true || (v?.receiptRunId != null && v.run != null && v.run.id !== v.receiptRunId),
    staleBoards: v?.freshness?.boards ?? [],
  };
}

export function departurePreflight(input: {
  manifest: ManifestSummary | null; plan: PlanSummary | null; options: DepartureOptions;
  receipt?: ReceiptView | null; stale?: boolean;
  staleBoards?: readonly string[] | undefined;
}): DeparturePreflight {
  const { manifest, plan, options, receipt } = input;
  const changed = new Set(input.staleBoards ?? []);
  const outside = outsideTheMove(manifest, plan);
  const entries: DepartureEntry[] = [];
  const add = (category: DepartureCategory, subject: string, detail: string) => entries.push({ category, subject, detail });
  for (const b of manifest?.boards ?? []) {
    const checked = !input.stale && !changed.has(b.id) && receipt?.ok && receipt.boards.some((r) => r.monday_board_id === b.id && r.plaky_board_id === b.plakyBoardId && r.complete && r.missing.length === 0 && r.differing.length === 0 && !r.comments_or_files_short);
    add(checked ? "preserved" : "manual", b.name,
      b.plakyBoardId === null ? "Import its setup file and link the board first."
        : checked ? `${b.carried} fields. Selected items and values matched; exclusions and file contents need separate review.`
          : `${b.carried} fields mapped. Run Check now to verify this board.`);
    for (const task of currentManualTasks(b.byHand)) add("manual", b.name, task);
  }
  for (const b of outside.boards) add("unavailable", b.name, b.reason);
  for (const b of manifest?.boards ?? []) for (const c of b.notCarried) {
    if (c.type === "name" || c.type === "subtasks") continue;
    if (c.type === "file") {
      add(options.syncFiles ? "converted" : "unavailable", `${b.name}: ${c.title}`, options.syncFiles
        ? "Files become attachments. Copy external links separately."
        : "Files is off. Files are still requested for the archive.");
    } else add("unavailable", `${b.name}: ${c.title} (${c.type})`, `${c.reason}. Check the archive for source values.`);
  }
  for (const c of outside.asText) add("converted", c.board, c.text);
  for (const c of outside.byChoice) add("unavailable", `${c.board}: ${c.column}`, "Excluded by your mapping. Source values are requested for the archive.");
  for (const g of outside.archivedGroups) add("manual", `${g.board}: ${g.group}`, "Unarchive in monday before exporting; these items may be omitted.");
  for (const i of outside.inactiveItems) add("manual", i.board, `${i.archived} archived, ${i.deleted} deleted items excluded. Review monday’s archive and trash; discovery may be incomplete.`);
  for (const f of outside.filtered) add("unavailable", f.board, `${f.items} items filtered out. The archive ignores filters.`);
  for (const d of outside.deeper) add("unavailable", d.board, `${d.item}: hierarchy not supported. Requested for the archive.`);
  for (const n of outside.planNotes) add("manual", n.board, n.text);
  for (const w of outside.warnings) add("manual", "Review", w);
  for (const f of plan?.failures ?? []) add("manual", "Plan failed", f);
  for (const f of receipt?.failures ?? []) add("manual", "Verification failed", f);
  for (const b of receipt?.boards ?? []) {
    for (const message of [...b.missing, ...b.differing, ...b.not_carried, ...b.uncarried]) add("manual", `${b.name}: last verification`, message);
    if (b.comments_or_files_short) add("manual", b.name, "Comments or files are missing. Review the receipt.");
  }
  for (const b of plan?.boards ?? []) {
    if (b.notCarriedValues) add("unavailable", b.name, `${b.notCarriedValues} values not moved. Review Plan and options.`);
    for (const c of b.uncarried) add("manual", b.name, c);
    if (b.drifted) add("manual", b.name, `${b.drifted} titles differ. Rebuilding loses content added in Plaky.`);
  }
  if (manifest) {
    add("converted", "Original authors and dates", AUTHORSHIP_NOTE);
    add(options.withCreated ? "converted" : "unavailable", "Created fields", options.withCreated ? "Original creator and date are stored in fields." : "Off for Plaky; requested for the archive.");
    add(options.syncComments ? "converted" : "unavailable", "Updates and replies", options.syncComments ? "Formatting may change. Board posts stay in the archive. Plaky allows 2,000 comments per item." : "Off for Plaky; requested for the archive.");
    add(options.syncFiles ? "manual" : "unavailable", "Attachments", options.syncFiles ? "Checks compare counts, not file contents. Open sample files. Archive limit: 100 MB per file; copy larger files separately." : "Off for Plaky. Archive limit: 100 MB per file; copy larger files separately.");
    add("converted", "Titles, people and hierarchy", "Titles: 255 characters. Unmatched names: text. Deeper subitems: separate boards. Archive keeps originals.");
    add("manual", "Subscribers", options.syncSubscribers ? "Only matched Plaky users become followers." : "Off for Plaky; source IDs stay in the archive.");
  }
  add("manual", "Workspace setup", "Recreate automations, integrations, views and access settings in Plaky after moving.");
  add("manual", "External links and documents", "Copy external content separately. Doc comments, reactions and read receipts are not exported. Check Markdown links offline.");
  add("unavailable", "Account-wide completeness", "Selected boards only. Standalone docs, history, deleted and inaccessible content may be missing. Review archive gaps.");
  return {
    scope: manifest ? `${manifest.boards.length} selected board entries. Archive includes readable subitems and ignores migration filters and switches. Review download failures.` : "Select and read boards first.",
    verification: input.stale || changed.size ? "out_of_date" : !receipt ? "not_checked" : receipt.ok ? "matched" : "needs_attention",
    entries,
  };
}
