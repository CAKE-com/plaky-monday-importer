export type PeopleEntry = Readonly<Record<string, unknown>>;
export type PeopleChoice = "user" | "unassigned" | "header" | "team" | "other";
export type PeopleTarget = number | "unassigned" | "header" | "team";

type ParsedEntry = {
  choice: PeopleChoice;
  byHand: PeopleEntry | null;
  userId: number | null;
  skipped: boolean;
  header: boolean;
  standIn: unknown;
};

export const isByHand = (entry: PeopleEntry | null | undefined): boolean => entry != null && !Object.hasOwn(entry, "stand_in");

export const isSkipped = (entry: PeopleEntry | null | undefined): boolean => entry != null && entry.skip === true;

export const isHeader = (entry: PeopleEntry | null | undefined): boolean => entry != null && entry.header === true && !isSkipped(entry);

export function parse(entry: PeopleEntry | null | undefined): ParsedEntry {
  const byHand = isByHand(entry) ? entry! : null;
  const skipped = isSkipped(byHand);
  const header = isHeader(byHand);
  const userId = !skipped && !header && byHand && Object.hasOwn(byHand, "user_id") ? Number(byHand.user_id) : null;
  return {
    choice: skipped ? "unassigned" : header ? "header" : userId !== null ? "user" : byHand ? "other" : "team",
    byHand, userId, skipped, header,
    standIn: entry?.stand_in ?? null,
  };
}

export function label(choice: PeopleChoice, o: { placeholder?: string | null; mustExist?: boolean; other?: string | null; team?: boolean } = {}): string {
  switch (choice) {
    case "unassigned": return "Leave unassigned";
    case "header": return "Keep name as text (unassigned)";
    case "team":
      if (o.team) return o.mustExist ? `The Plaky team “${o.placeholder ?? "of its name"}” (make it in Plaky first)` : "Plaky team with the same name";
      return o.mustExist ? `A placeholder team (make “${o.placeholder ?? "their placeholder team"}” in Plaky first)` : "Placeholder team";
    case "other": return `As set in the config: ${o.other ?? ""}`;
    case "user": return "A Plaky user";
  }
}
