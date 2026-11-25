import { isPlakyHttp, type PlakyHttpError } from "../../clients/plaky";
import { nameColumnId } from "../name-fields";
import { asId, normalizeTitle, type FieldMap, type PlakyField } from "../transform/mapping";
import type { UserDirectory } from "../transform/people";
import { isDict } from "../transform/pystr";
import { sameValues } from "./compare";

export type Assignee = "team" | "user";
export type RefusedParts = { teams: ReadonlySet<number>; users: ReadonlySet<number>; fields: readonly string[]; said: string | null };
export type Withheld = { key: string; teams: number[]; users: number[]; value: boolean };
export type KeptNames = {
  targets: ReadonlyMap<string, PlakyField>;
  slots: ReadonlyMap<string, string>;
  names: (kind: Assignee, id: number) => string | undefined;
  idKey: string | null;
};

const INVALID_CONSTRAINT = 6000001;
const NAMED_ID = /\b(team|user)\s+id\s*:?\s*(\d+)/gi;

export function refusedParts(error: unknown): RefusedParts | null {
  if (!isPlakyHttp(error) || error.status !== 400) return null;
  const refusal = (error as PlakyHttpError).refusal;
  const violations = refusal?.violations ?? [];
  const texts = [refusal?.message ?? null, ...violations.map((v) => v.message)].filter((text): text is string => !!text);
  const teams = new Set<number>();
  const users = new Set<number>();
  for (const text of texts) for (const [, kind, id] of text.matchAll(NAMED_ID)) (kind!.toLowerCase() === "team" ? teams : users).add(Number(id));
  const constraint = error.errorCode === INVALID_CONSTRAINT || refusal?.label === "INVALID_CONSTRAINT";
  if (!constraint && teams.size === 0 && users.size === 0) return null;
  return { teams, users, fields: violations.flatMap((v) => (v.fieldName ? [v.fieldName] : [])), said: texts[0] ?? null };
}

export function nameSlots(fieldMap: FieldMap): Map<string, string> {
  const byColumn = new Map(fieldMap.pairs.map((pair) => [pair.column.id, pair.target.key]));
  return new Map(
    fieldMap.pairs.flatMap((pair) => {
      const slot = pair.target.type === "PERSON" ? byColumn.get(nameColumnId(pair.column.id)) : undefined;
      return slot === undefined ? [] : [[pair.target.key, slot] as const];
    }),
  );
}

const ids = (entries: unknown): number[] => (Array.isArray(entries) ? entries.flatMap((entry) => asId(entry) ?? []) : []);

export function personIds(value: unknown): { users: number[]; teams: number[] } {
  if (!isDict(value)) return { users: [], teams: [] };
  return { users: [...ids(value["users"]), ...ids(value["assignedUsers"])], teams: [...ids(value["teams"]), ...ids(value["assignedTeams"])] };
}

const names = (fieldName: string, target: PlakyField): boolean =>
  [fieldName, ...fieldName.split(/[.[\]'"]+/)].some((part) => part !== "" && (part === target.key || normalizeTitle(part) === normalizeTitle(target.name)));

const assigneeName = (kept: KeptNames, kind: Assignee, id: number): string => kept.names(kind, id) ?? `Plaky ${kind} ${id}`;

function withNames(current: unknown, added: readonly string[]): string {
  const held = typeof current === "string" && current !== "" ? [current] : [];
  const listed = new Set(held.flatMap((text) => text.split(", ")));
  return [...held, ...added.filter((name) => !listed.has(name))].join(", ");
}

export function withoutRefused(fields: Readonly<Record<string, unknown>>, parts: RefusedParts, kept: KeptNames): { fields: Record<string, unknown>; withheld: Withheld[] } | null {
  const out: Record<string, unknown> = { ...fields };
  const withheld: Withheld[] = [];
  const matched = Object.keys(fields).filter((key) => kept.targets.has(key) && parts.fields.some((field) => names(field, kept.targets.get(key)!)));
  const named = new Set(matched.filter((key) => key !== kept.idKey));
  const blind = parts.teams.size === 0 && parts.users.size === 0 && matched.length === 0;
  for (const [key, value] of Object.entries(fields)) {
    const target = kept.targets.get(key);
    if (target === undefined || key === kept.idKey) continue;
    if (target.type !== "PERSON") {
      if (!named.has(key)) continue;
      delete out[key];
      withheld.push({ key, teams: [], users: [], value: true });
      continue;
    }
    const held = personIds(value);
    let teams = held.teams.filter((id) => parts.teams.has(id));
    let users = held.users.filter((id) => parts.users.has(id));
    if (teams.length === 0 && users.length === 0) {
      if (blind) [teams, users] = [held.teams, held.users];
      else if (named.has(key)) [teams, users] = held.teams.length ? [held.teams, []] : [[], held.users];
    }
    if (teams.length === 0 && users.length === 0) continue;
    out[key] = { users: held.users.filter((id) => !users.includes(id)).map((id) => ({ id })), teams: held.teams.filter((id) => !teams.includes(id)).map((id) => ({ id })) };
    withheld.push({ key, teams, users, value: false });
    const slot = kept.slots.get(key);
    if (slot !== undefined) out[slot] = withNames(out[slot], [...users.map((id) => assigneeName(kept, "user", id)), ...teams.map((id) => assigneeName(kept, "team", id))]);
  }
  return withheld.length ? { fields: out, withheld } : null;
}

export function keptAsText(wanted: Readonly<Record<string, unknown>>, current: Readonly<Record<string, unknown>>, kept: KeptNames, directory: UserDirectory | null): boolean {
  const teams = new Set<number>();
  const users = new Set<number>();
  for (const [key, value] of Object.entries(wanted)) {
    if (kept.targets.get(key)?.type !== "PERSON" || !kept.slots.has(key)) continue;
    const want = personIds(value);
    const have = personIds(current[key]);
    for (const id of want.teams) if (!have.teams.includes(id)) teams.add(id);
    for (const id of want.users) if (!have.users.includes(id)) users.add(id);
  }
  if (teams.size === 0 && users.size === 0) return false;
  const form = withoutRefused(wanted, { teams, users, fields: [], said: null }, kept);
  return form !== null && sameValues(form.fields, current, kept.targets, directory);
}

const quoted = (names: readonly string[]): string => names.map((name) => `'${name}'`).join(" and ");

export function refusalNotes(title: string, withheld: readonly Withheld[], parts: RefusedParts, kept: KeptNames): string[] {
  return withheld.map((w) => {
    const field = kept.targets.get(w.key)?.name ?? w.key;
    if (w.value) return `Item '${title}': Plaky refused the value of '${field}'${parts.said ? ` ("${parts.said}")` : ""}; it is left empty there.`;
    const teams = w.teams.map((id) => assigneeName(kept, "team", id));
    const users = w.users.map((id) => assigneeName(kept, "user", id));
    const who = [teams.length ? `${teams.length === 1 ? "team" : "teams"} ${quoted(teams)}` : "", users.length ? `${users.length === 1 ? "user" : "users"} ${quoted(users)}` : ""].filter(Boolean).join(" and ");
    const slot = kept.slots.get(w.key);
    const one = teams.length + users.length === 1;
    const text = slot === undefined ? `the board has no '${field} (name)' field, so ${one ? "the name is" : "the names are"} not kept` : `${one ? "the name is" : "the names are"} kept as text in '${kept.targets.get(slot)?.name ?? slot}'`;
    const fix = one && teams.length ? "Add the team to the Space in Plaky, then assign it on the item there." : one ? "Add the user to the Space in Plaky, then assign them on the item there." : "Add them to the Space in Plaky, then assign them on the item there.";
    return `Item '${title}': Plaky refused ${who} on '${field}'; ${text}. ${fix}`;
  });
}
