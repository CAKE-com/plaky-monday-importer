import type { ReceiptView } from "./reports";

const count = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

export function shortReasons(board: ReceiptView["boards"][number], o: { coverage?: boolean } = {}): string[] {
  if (board.complete) return [];
  const out: string[] = [];
  const unidentified = board.unidentified ?? [];
  const extra = board.extra ?? [];
  if (unidentified.length) {
    out.push(`${count(unidentified.length, "row in Plaky has", "rows in Plaky have")} no Monday ID, so the check cannot match ${unidentified.length === 1 ? "it" : "them"} to a monday item: ${unidentified.join(", ")}. ` +
      "A row made by hand in Plaky is never changed or deleted; the board reads as a match once it is moved to another board or deleted.");
  }
  if (extra.length) {
    out.push(`${count(extra.length, "row in Plaky carries", "rows in Plaky carry")} the Monday ID of an item monday no longer has on this board: ${extra.join(", ")}. ` +
      `${extra.length === 1 ? "It stays" : "They stay"} unless “Delete items removed from monday” is on.`);
  }
  if (board.seed_rows) out.push(`${count(board.seed_rows, "imported example row is", "imported example rows are")} still on the board. Delete ${board.seed_rows === 1 ? "it" : "them"} in Plaky.`);
  if (board.comments_or_files_short) out.push(...(board.notes ?? []).filter((note) => /^(comments|files): /.test(note) && !note.endsWith(", all carried")));
  if (o.coverage !== false) for (const c of board.coverage ?? []) if (c.shortfall > 0) out.push(`'${c.name}' is filled on ${c.plaky_filled} of the ${count(c.monday_filled, "item that has", "items that have")} it in monday.`);
  return out;
}
