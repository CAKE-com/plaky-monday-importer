import { shortReasons } from "./short-reasons";
import { explainMessage } from "./explain";
import { isNothingOutside, outsideLines, type OutsideTheMove } from "./outside";
import type { ReceiptView } from "./reports";

type HandoffReadiness = { board: string | null; text: string; done: boolean };

export type HandoffInput = {
  migrationName: string;
  generatedAt: Date;
  receipt: ReceiptView;
  boardLinks: readonly { name: string; url: string }[];
  readiness: readonly HandoffReadiness[] | null;
  boardNames: ReadonlyMap<string, string>;
  verifiedAt?: Date | null;
  unverifiedLaterRun?: { status: string; startedAt: Date } | null;
  undoneAfter?: boolean;
  outside?: OutsideTheMove | null;
};

const utc = (d: Date): string => `${d.toISOString().replace("T", " ").slice(0, 16)} UTC`;

const cell = (text: string | number): string => line(String(text)).replaceAll("|", "\\|");
const line = (text: string): string => text.replace(/\r?\n/g, " ").replace(/([[\]<>])/g, "\\$1");

export function handoffReport(input: HandoffInput): string {
  const { receipt } = input;
  const links = new Map(input.boardLinks.map((l) => [l.name, l.url]));
  const out: string[] = [];
  out.push(`# Migration report: ${input.migrationName}`, "");
  out.push(`Generated ${utc(input.generatedAt)}.${input.verifiedAt ? ` Verified ${utc(input.verifiedAt)}.` : ""}`, "");
  if (input.unverifiedLaterRun) {
    out.push(
      `> A later run (${input.unverifiedLaterRun.status}, started ${utc(input.unverifiedLaterRun.startedAt)}) was not verified: this report shows the earlier verification. Run "Verify now" for a current one.`,
      "",
    );
  }
  if (input.undoneAfter) out.push(`> A board was undone after this verification: this report shows Plaky as it was before that. Move again, then make the report again.`, "");
  out.push(
    input.undoneAfter
      ? `**Result: out of date.** ${receipt.matched} of ${receipt.monday_items} monday item(s) were in Plaky at this verification, before the undo.`
      : receipt.ok
      ? `**Result: complete.** ${receipt.matched} of ${receipt.monday_items} monday item(s) are in Plaky, with every value checked.`
      : `**Result: not complete.** ${receipt.matched} of ${receipt.monday_items} monday item(s) are in Plaky; the sections below list what is short.`,
    "",
  );

  out.push("## Boards", "", "| Board | monday items | In Plaky | Missing | Status |", "|---|---:|---:|---:|---|");
  for (const b of receipt.boards) {
    const name = links.has(b.name) ? `[${cell(b.name)}](${links.get(b.name)})` : cell(b.name);
    out.push(`| ${name} | ${b.monday_items} | ${b.matched} | ${b.missing.length} | ${b.complete ? "complete" : "needs attention"} |`);
  }
  out.push("");

  const notCarriedColumns = receipt.boards.flatMap((b) => b.dropped.map((d) => [b.name, d] as const));
  if (notCarriedColumns.length) {
    out.push("## monday fields Plaky does not carry", "", "These fields have no Plaky equivalent; their data stays in monday.", "");
    for (const [board, dropped] of notCarriedColumns) out.push(`- ${line(board)}: ${line(dropped)}`);
    out.push("");
  }

  if (input.outside && !isNothingOutside(input.outside)) {
    out.push("## Not part of the move", "", "Left out by design, or needing a check: these stay in monday or need a person.", "");
    for (const said of outsideLines(input.outside)) out.push(`- ${line(said)}`);
    out.push("");
  }

  const short = receipt.boards.flatMap((b) => [
    ...b.missing.map((m) => `${b.name}: missing ${m}`),
    ...b.differing.map((d) => `${b.name}: differs ${d}`),
    ...b.not_carried.map((n) => `${b.name}: value not carried ${n}`),
    ...b.uncarried.map((u) => `${b.name}: ${u}`),
    ...b.coverage.filter((c) => c.shortfall > 0).map((c) => `${b.name}: '${c.name}' filled on ${c.plaky_filled} of ${c.monday_filled} item(s)`),
    ...shortReasons(b, { coverage: false }).map((reason) => `${b.name}: ${reason}`),
  ]);
  if (short.length || receipt.failures.length || receipt.unmatched_users.length) {
    out.push("## Needs attention", "");
    for (const said of [...short, ...receipt.failures.map((f) => explainMessage(`could not verify ${f}`).text), ...receipt.unmatched_users.map((u) => `assignment not carried: ${u}`)]) out.push(`- ${line(said)}`);
    out.push("");
  }

  out.push("## Still to do in Plaky", "");
  if (input.readiness === null) out.push("The checklist could not be read from Plaky when this report was made.");
  else {
    const open = input.readiness.filter((r) => !r.done);
    if (!open.length) out.push("Nothing: every setup step is done.");
    for (const r of open) out.push(`- [ ] ${line(r.board === null ? "Workspace" : (input.boardNames.get(r.board) ?? r.board))}: ${line(explainMessage(r.text).text)}`);
  }
  out.push("");
  return out.join("\n");
}
