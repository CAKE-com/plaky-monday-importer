import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { dropped, importable, isSubitemBoard, manifestWarnings, boardWarnings, seedHeaders, seedRowsNeeded, seededColumns, totalItems, type DiscoveredBoard, type Manifest } from "./manifest";
import { ITEM_TITLE_HEADER, MONDAY_ID_FIELD, PARENT_ID_FIELD, PARENT_TITLE_FIELD, seedMarker } from "./names";
import { importLabel } from "./transform/compat";
import { parse } from "@/lib/people-entry";
import { TEAM_KEY, type PeopleMap } from "./config";
import { isAlnum, pyStr, pyStrip } from "./transform/pystr";

const SEED_TITLE_PREFIX = "__MPS_SEED__";

export function seedRows(board: DiscoveredBoard): string[][] {
  const headers = seedHeaders(board);
  const byName = new Map(seededColumns(board).map((c) => [c.fieldName, c]));
  const marker = seedMarker(board.id);
  return Array.from({ length: seedRowsNeeded(board) }, (_, index) =>
    headers.map((header) => {
      if (header === ITEM_TITLE_HEADER) return `${SEED_TITLE_PREFIX} ${index + 1}`;
      if (header === MONDAY_ID_FIELD) return marker;
      return byName.get(header)?.labels[index] ?? "";
    }),
  );
}

function csvField(value: string): string {
  return /[,"\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

export const seedCsv = (board: DiscoveredBoard): string => [seedHeaders(board), ...seedRows(board)].map((row) => `${row.map(csvField).join(",")}\r\n`).join("");

export function slug(name: string, boardId: string): string {
  const kept = [...pyStrip(name)].map((c) => (isAlnum(c) || c === "-" || c === "_" ? c : "-")).join("");
  let stem = kept.replace(/^-+|-+$/g, "").toLowerCase() || "board";
  while (stem.includes("--")) stem = stem.replaceAll("--", "-");
  return `${stem}-${boardId.replaceAll(":", "-")}`;
}

type SeedFiles = ReadonlyMap<string, string>;

export function buildGuide(manifest: Manifest, files: SeedFiles, people?: PeopleMap): string {
  const real = manifest.boards.filter((b) => !isSubitemBoard(b));
  const subs = new Map(manifest.boards.filter(isSubitemBoard).map((b) => [b.parentBoardId, b] as const));

  const out: string[] = [
    "# Create these boards in Plaky",
    "",
    `${manifest.boards.length} board(s), for ${totalItems(manifest)} monday item(s).`,
    "",
    "Plaky's API cannot create a board, a field, a status label or a tag value,",
    "so each board is created once by importing the seed CSV next to this file.",
    "The CSV carries no real data — only the field names, their types, and the",
    "status/tag values that have to exist before any item can be written.",
    "",
    "For each board below:",
    "",
    "1. In the Plaky space, **+ → New Board → Create from file**.",
    "2. Upload the named CSV. Leave the delimiter on Comma and *My file has",
    "   headers* on; `Name` is the item name field.",
    "3. **Proceed**, then set each field's type using the table for that board.",
    "   A field starts as Text; change it with **Create New Field ▸ <type>**.",
    "   Leave *Destination group* on **New group** — groups are created later",
    "   through the API, which has no 20-group limit.",
    "4. **Finish import.**",
    "5. Optionally rename the board: every imported board is called",
    '   "New board" and Plaky has no API to rename it. Nothing depends on the',
    "   name — this app finds the board by a marker inside the seed rows.",
    "",
    "Then come back to the Boards section: it checks Plaky every 30 seconds (or",
    "press Check now), pairs the boards up and deletes the seed rows.",
    "",
    "Set up board automations only after Move has finished: every item it",
    "creates fires an *Item created* trigger and would spend the automation quota.",
    "",
  ];

  const built = manifest.boards.filter((b) => b.plakyBoardId !== null);
  for (const board of real) {
    const pair = subs.get(board.id);
    if (board.plakyBoardId === null) out.push(...boardSection(board, files, { subitem: pair }));
    if (pair && pair.plakyBoardId === null) out.push(...boardSection(pair, files, { parent: board }));
    for (let above = pair, next = above && subs.get(above.id); above && next; above = next, next = subs.get(above.id)) {
      if (next.plakyBoardId === null) out.push(...boardSection(next, files, { parent: above }));
    }
  }

  if (built.length) {
    out.push("## Already built", "", "Nothing to do for these — do not import them again.", "");
    out.push(...built.map((b) => `- **${b.name}** (\`${b.id}\`) -> Plaky board \`${b.plakyBoardId}\``));
    out.push("");
  }

  out.push(...peopleSection(manifest, people));

  if (manifest.skipped.length) {
    out.push("## Not migrated", "");
    out.push(...manifest.skipped.map((s) => `- **${s.name}** (\`${s.id}\`) — ${s.reason}`));
    out.push("");
  }

  const warnings = manifestWarnings(manifest);
  if (warnings.length) out.push("## Check these", "", ...warnings.map((w) => `- ${w}`), "");

  return out.join("\n");
}

function peopleSection(manifest: Pick<Manifest, "people">, people?: PeopleMap): string[] {
  const choice = (id: string) => parse(people && Object.hasOwn(people, id) ? people[id] : null).choice;
  const standIns = manifest.people.filter((p) => p.kind === "person" && p.placeholder && (people === undefined || choice(p.id) === "team"));
  const asText = people === undefined ? [] : manifest.people.filter((p) => p.kind === "person" && p.placeholder && choice(p.id) === "header");
  const teams = manifest.people.filter((p) => p.kind === "team" && (people === undefined || choice(`${TEAM_KEY}${p.id}`) === "team"));
  const teamsAsText = people === undefined ? [] : manifest.people.filter((p) => p.kind === "team" && choice(`${TEAM_KEY}${p.id}`) === "header");
  const direct = manifest.people.filter((p) => p.kind === "person" && !p.placeholder);
  if (!(standIns.length || asText.length || teamsAsText.length || teams.length || direct.length)) return [];
  const out = ["## People and teams", ""];
  if (asText.length) {
    out.push(
      `${asText.length} person(s) Plaky cannot assign keep their name as text, in the Text field beside`,
      "each people field that names them (`<field> (name)`, in the seed already): nothing to set up.",
      "",
    );
  }
  if (teamsAsText.length) {
    out.push(
      `${teamsAsText.length} monday team(s) keep their name as text the same way, so no Plaky team is needed for them:`,
      ...teamsAsText.map((t) => `- **${t.name}**`),
      "",
    );
  }
  if (direct.length) {
    out.push(
      `${direct.length} assigned person(s) have a Plaky account with the same email and`,
      "are assigned as themselves. Plaky may notify them as their assignments arrive.",
      "",
    );
  }
  if (standIns.length) {
    out.push(
      "### Create these empty teams",
      "",
      "Each stands in for someone Plaky cannot assign yet, so their items still show",
      "who they belong to, and nobody is notified. That covers anyone deactivated or",
      "never joined in monday, and anyone Plaky cannot assign: no account, or a viewer",
      "(an invitation not yet accepted is fine). Once one of them is in Plaky and not a",
      "viewer, the next apply moves their items from the team to them.",
      "",
      "For each one: workspace menu (**⋮** next to the workspace name) → **Teams** →",
      "**⊕**, rename the new team to exactly the title below, then **remove yourself**.",
      "Plaky adds whoever creates a team, and link waits until every team below",
      "exists and is empty. In a closed Space, also add each team to that Space:",
      "Plaky refuses a team that has no access to it.",
      "",
    );
    out.push(...standIns.map((p) => `- \`${p.placeholder}\``));
    out.push("");
  }
  if (teams.length) {
    out.push("### Recreate these monday teams", "", "Same name, same people. link waits until each exists:", "");
    out.push(...teams.map((t) => `- **${t.name}**: ${t.members.length ? t.members.join(", ") : "no members listed"}`));
    out.push("");
  }
  return out;
}

const OPT_IN_EXTRAS: readonly (readonly [id: string, label: string])[] = [
  ["__created_by", "who created each item and when"],
  ["__url", "a link back to each monday item"],
];

function boardSection(board: DiscoveredBoard, files: SeedFiles, links: { subitem?: DiscoveredBoard | undefined; parent?: DiscoveredBoard }): string[] {
  const { subitem, parent } = links;
  let heading = `## ${board.name}`;
  if (parent !== undefined) heading += ` — subitems of ${parent.name}`;
  const out = [heading, ""];

  if (parent !== undefined && board.nested) {
    heading = `## ${board.name} — nested under ${parent.name}`;
    out[0] = heading;
    out.push(
      `- monday board: \`${board.id}\``,
      `- ${board.itemsCount} item(s) to migrate, nested under their items on *${parent.name}*`,
      "",
      `No file to import: these nest under their parent items on *${parent.name}*'s board,`,
      "whose seed carries their fields beside its own (the rows marked",
      "*on the subitem board* in that table). Nothing to do here.",
      "",
    );
    return out;
  }
  if (parent !== undefined) {
    out.push(
      `monday keeps these as subitems of *${parent.name}*. A Plaky subitem has`,
      "exactly the parent board's fields, and these have fields of their own,",
      "so they import as ordinary items on a board of their own.",
      "`Parent Item` and `Parent Monday ID` carry the link.",
      "",
    );
  } else if (subitem !== undefined && subitem.nested) {
    out.push(`Its subitems nest under their items on this board: the fields marked *on the subitem board* come from *${subitem.name}*.`, "");
  } else if (subitem !== undefined) {
    out.push(`Its subitems become a separate board — see *${subitem.name}* below.`, "");
  }

  out.push(
    `- monday board: \`${board.id}\``,
    `- file: \`${files.get(board.id)}\``,
    `- ${board.itemsCount} item(s) to migrate`,
    "",
    "| CSV field | Plaky type to pick | Notes |",
    "| --- | --- | --- |",
    `| \`${ITEM_TITLE_HEADER}\` | *Item names* (preselected) | the monday item name |`,
    `| \`${MONDAY_ID_FIELD}\` | Text | how a re-run updates instead of duplicating |`,
  );
  if (isSubitemBoard(board) && !board.nested) {
    out.push(`| \`${PARENT_TITLE_FIELD}\` | Text | the monday parent's name |`, `| \`${PARENT_ID_FIELD}\` | Text | the monday parent's id |`);
  }
  const ownCount = importable(board).length;
  seededColumns(board).forEach((column, at) => {
    let note = `from *${column.title}* (${column.type})${at >= ownCount ? " on the subitem board" : ""}`;
    if (column.labels.length) note += `; creates ${column.labels.length} value(s): ${column.labels.join(", ")}`;
    if (column.reason) note += `; ${column.reason}`;
    out.push(`| \`${column.fieldName}\` | ${importLabel(column.plakyType, column.importAs)} | ${note} |`);
  });
  out.push("");

  out.push("Not carried:", "");
  out.push(...dropped(board).map((c) => `- **${c.title}** (${c.type}) — ${pyStr(c.reason)}`));
  const carried = new Set(importable(board).map((c) => c.id));
  const missing = OPT_IN_EXTRAS.filter(([id]) => !carried.has(id)).map(([, label]) => label);
  if (missing.length) {
    out.push(`- ${missing.join(" and ")}: tick “Who created each item, and when” and “A link back to each monday item” in Boards, then read the boards again`, "  to add them as fields.");
  }
  out.push("- monday's *last updated* time, which means nothing once monday is retired.", "");

  for (const warning of boardWarnings(board)) out.push(`> **Check:** ${warning}`, "");
  if (board.byHand.length) {
    out.push("Finish by hand in Plaky (its API cannot):", "");
    out.push(...board.byHand.map((step) => `- ${step}`));
    out.push("");
  }
  return out;
}

type Blueprint = {
  seedFiles: Map<string, string>;
  files: Record<string, string>;
};

export const GUIDE_FILE = "BUILD.md";

export function writeBlueprint(manifest: Manifest, people?: PeopleMap): Blueprint {
  const todo = manifest.boards.filter((b) => b.plakyBoardId === null && !b.nested);
  const seedFiles = new Map(todo.map((b) => [b.id, `${slug(b.name, b.id)}.seed.csv`] as const));
  const files: Record<string, string> = {};
  for (const board of todo) files[seedFiles.get(board.id) ?? ""] = seedCsv(board);
  files[GUIDE_FILE] = buildGuide(manifest, seedFiles, people);
  return { seedFiles, files };
}

export async function writeBlueprintFiles(blueprint: Pick<Blueprint, "files">, directory: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  for (const [name, text] of Object.entries(blueprint.files)) await writeFile(join(directory, name), text, "utf8");
}
