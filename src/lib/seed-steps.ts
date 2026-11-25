export type SeedBoard = {
  id: string;
  name: string;
  fileName: string | null;
  csv: string | null;
  checklist: readonly { field: string; typeLabel: string; reason: string | null }[];
  lossy?: readonly string[];
};

export const INSTRUCTIONS_FILE = "START HERE.txt";

export const IMPORT_STEPS: readonly string[] = [
  "Open the Space in Plaky, then + → New Board → Create from file.",
  "Choose the downloaded file, then Proceed.",
  "Under Mapping, give each field listed for that board its type: open the field’s menu → Create New Field → the type.",
  "Finish import, then rename the board.",
];

export const ONCE = "Import each file once to avoid duplicates.";
export const ANY_ORDER = "Import in any order. Boards are detected automatically.";
const STATUS_NOTE = "Choose Status, not Tag or Dropdown.";
const ASSIGNEE_NOTE = "Choose Assignee for My Tasks.";
const DUE_DATE_NOTE = "Choose Due Date, not Date.";

function typeNote(label: string, rule: string | null): string | null {
  if (label === "Status") return STATUS_NOTE;
  if (label === "Assignee") return ASSIGNEE_NOTE;
  if (label === "Due Date") return DUE_DATE_NOTE;
  return (label === "Tag" || label === "Dropdown") && rule ? `${rule}.` : null;
}

const MASTER_FIELDS = new Set(["Assignee", "Status", "Due Date"]);
const SCROLL_NOTE = "scroll the menu";

type TypeLine = {
  field: string;
  typeLabel: string | null;
  path: string;
  master: boolean;
  note: string | null;
};

export function typeLines(checklist: SeedBoard["checklist"]): TypeLine[] {
  return [
    { field: "Name", typeLabel: null, path: "leave as Item names (preselected)", master: false, note: null },
    ...checklist.map((c): TypeLine => {
      if (c.typeLabel === "Text") return { field: c.field, typeLabel: "Text", path: "leave as Text", master: false, note: null };
      const master = MASTER_FIELDS.has(c.typeLabel);
      return { field: c.field, typeLabel: c.typeLabel, path: `Create New Field → ${c.typeLabel}${c.typeLabel === "Link" ? ` (${SCROLL_NOTE})` : ""}`, master, note: typeNote(c.typeLabel, c.reason) };
    }),
  ];
}

export function instructionsText(boards: readonly SeedBoard[]): string {
  const withFile = boards.filter((b) => b.fileName && b.csv);
  const out = [
    "Set up these boards in Plaky",
    "",
    "Items and attachments move after setup.",
    "",
    "For each file:",
    ...IMPORT_STEPS.map((s, i) => `${i + 1}. ${s}`),
    "",
    ONCE,
    ANY_ORDER,
    "",
  ];
  withFile.forEach((b, i) => {
    const textFields = b.checklist.filter((field) => field.typeLabel === "Text").length;
    out.push(`${i + 1}. ${b.name}`, `   File: ${b.fileName}`, `   Rename “New board” to: “${b.name}”`,
      `   Name stays Item names. Leave ${textFields} field(s) as Text.`, "   Create New Field for:");
    for (const l of typeLines(b.checklist).filter((line) => line.typeLabel && line.typeLabel !== "Text")) {
      out.push(`     ${l.field} → ${l.typeLabel}${l.typeLabel === "Link" ? ` (${SCROLL_NOTE})` : ""}`);
    }
    out.push("");
  });
  return out.join("\r\n");
}
