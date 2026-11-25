import { ASSIGNABLE_STATUS } from "./transform/people";
import { eq } from "drizzle-orm";
import { parse, type PeopleChoice, type PeopleTarget } from "@/lib/people-entry";
import type { Db } from "@/db/client";
import { migrations } from "@/db/schema";
import { PreconditionError } from "../errors";
import { TEAM_KEY, type PeopleMap } from "./config";
import { manifestPeople, peopleWithStandIns } from "./link";
import type { Manifest } from "./manifest";
import { withNameFields } from "./name-fields";
import { getMigration, loadLinkConfig, loadManifest, saveLinkConfig, saveManifest } from "./store";
import type { DirectoryUser, UserDirectory } from "./transform/people";

type PeopleRow = {
  kind: "person" | "team";
  mondayUserId: string;
  name: string;
  email: string | null;
  state: string;
  plakyUserId: number | null;
  standIn: string | null;
  placeholder: string | null;
  teamExists: boolean;
  members: string[];
  problem: string | null;
  other: string | null;
  choice: PeopleChoice;
};

export const assignableUsers = (directory: UserDirectory): DirectoryUser[] =>
  [...directory.byId.values()].filter((u) => ASSIGNABLE_STATUS.has(u.status) && u.type !== "VIEWER").sort((a, b) => a.name.localeCompare(b.name) || a.id - b.id);

export function unmatchedPeople(manifest: Manifest, directory: UserDirectory, people: PeopleMap): PeopleRow[] {
  const all = manifestPeople(manifest, directory, people);
  const resolved = all.users;
  const assignable = new Set(assignableUsers(directory).map((u) => u.id));
  const rows: PeopleRow[] = [];
  for (const person of manifest.people) {
    if (person.kind !== "person") continue;
    const { byHand: handWritten, userId, skipped, header, choice } = parse(Object.hasOwn(people, person.id) ? people[person.id]! : null);
    if (!handWritten && directory.assignable(person.email)) continue;
    const r = resolved.get(person.id);
    const gone = userId !== null && !assignable.has(userId);
    rows.push({
      kind: "person", mondayUserId: person.id, name: person.name, email: person.email, state: person.state, members: [],
      plakyUserId: userId !== null && Number.isFinite(userId) ? userId : null,
      standIn: r?.teamId != null ? r.placeholder : null,
      placeholder: person.placeholder,
      teamExists: person.placeholder !== null && directory.teamsTitled(person.placeholder).length > 0,
      problem: gone ? `Plaky user ${userId} can no longer be assigned (inactive or a viewer): pick another, or no match` : skipped || header ? null : (r?.problem ?? null),
      other: handWritten && userId === null && !skipped && !header ? JSON.stringify(handWritten) : null,
      choice,
    });
  }
  const byRule = manifestPeople(manifest, directory, null).teams;
  for (const team of manifest.people) {
    if (team.kind !== "team") continue;
    const key = `${TEAM_KEY}${team.id}`;
    const { byHand: handWritten, userId, skipped, header, choice } = parse(Object.hasOwn(people, key) ? people[key]! : null);
    const matched = byRule.get(team.id)?.teamId != null;
    if (!handWritten && matched) continue;
    const gone = userId !== null && !assignable.has(userId);
    rows.push({
      kind: "team", mondayUserId: key, name: team.name, email: null, state: "team", members: [...team.members],
      plakyUserId: userId !== null && Number.isFinite(userId) ? userId : null,
      standIn: null, placeholder: team.name, teamExists: matched,
      problem: gone ? `Plaky user ${userId} can no longer be assigned (inactive or a viewer): pick another, or no match` : skipped || header ? null : (all.teams.get(team.id)?.problem ?? null),
      other: handWritten && userId === null && !skipped && !header ? JSON.stringify(handWritten) : null,
      choice,
    });
  }
  return rows;
}

export async function currentPeople(db: Db, migrationId: number): Promise<{ people: PeopleMap; linked: boolean }> {
  const loaded = await loadLinkConfig(db, migrationId);
  if (loaded) return { people: { ...loaded.config.people }, linked: true };
  return { people: { ...((await getMigration(db, migrationId)).people as PeopleMap) }, linked: false };
}

const entryFor = (target: Exclude<PeopleTarget, "team">): PeopleMap[string] => (target === "unassigned" ? { skip: true } : target === "header" ? { header: true } : { user_id: target });

async function savePeople(db: Db, migrationId: number, manifest: Manifest, directory: UserDirectory, people: PeopleMap): Promise<PeopleMap> {
  const next = peopleWithStandIns(manifest, directory, people);
  const loaded = await loadLinkConfig(db, migrationId);
  if (loaded) {
    const config: Record<string, unknown> = { ...loaded.legacy, people: next };
    if (!Object.keys(next).length) delete config.people;
    await saveLinkConfig(db, migrationId, config);
  } else {
    await db.update(migrations).set({ people: next as Record<string, Record<string, unknown>>, updatedAt: new Date() }).where(eq(migrations.id, migrationId));
  }
  return next;
}

export async function savePeopleMatch(db: Db, migrationId: number, manifest: Manifest, directory: UserDirectory, mondayUserId: string, target: PeopleTarget): Promise<PeopleMap> {
  const teamId = mondayUserId.startsWith(TEAM_KEY) ? mondayUserId.slice(TEAM_KEY.length) : null;
  if (!manifest.people.some((p) => (teamId === null ? p.kind === "person" && p.id === mondayUserId : p.kind === "team" && p.id === teamId))) {
    throw new PreconditionError(teamId === null ? `monday user ${mondayUserId} is not assigned on the discovered boards` : `monday team ${teamId} is not assigned on the discovered boards`);
  }
  if (typeof target === "number" && !assignableUsers(directory).some((u) => u.id === target)) {
    throw new PreconditionError(`Plaky user ${target} cannot be assigned: not an active member of this workspace (or a viewer)`);
  }
  const { people } = await currentPeople(db, migrationId);
  if (target === "team") delete people[mondayUserId];
  else people[mondayUserId] = entryFor(target);
  return savePeople(db, migrationId, manifest, directory, people);
}

export async function saveEveryoneUnmatched(db: Db, migrationId: number, manifest: Manifest, directory: UserDirectory, target: "header" | "team" | "unassigned"): Promise<number> {
  const { people } = await currentPeople(db, migrationId);
  const rows = unmatchedPeople(manifest, directory, people).filter((r) => r.choice !== "user" && r.choice !== target);
  if (!rows.length) return 0;
  for (const r of rows) {
    if (target === "team") delete people[r.mondayUserId];
    else people[r.mondayUserId] = entryFor(target);
  }
  await savePeople(db, migrationId, manifest, directory, people);
  return rows.length;
}

export async function syncNameFields(db: Db, migrationId: number): Promise<void> {
  const manifest = await loadManifest(db, migrationId);
  if (!manifest) return;
  const next = withNameFields(manifest);
  if (JSON.stringify(next) !== JSON.stringify(manifest)) await saveManifest(db, migrationId, next);
}

export async function defaultChoices(db: Db, migrationId: number, manifest: Manifest, directory: UserDirectory, o: { seen?: ReadonlySet<string> } = {}): Promise<number> {
  const { people, linked } = await currentPeople(db, migrationId);
  const left = linked ? [] : unmatchedPeople(manifest, directory, people).filter((r) => r.choice === "team" && !o.seen?.has(r.mondayUserId));
  if (left.length) {
    for (const r of left) people[r.mondayUserId] = { header: true };
    await db.update(migrations).set({ people: people as Record<string, Record<string, unknown>>, updatedAt: new Date() }).where(eq(migrations.id, migrationId));
  }
  return left.length;
}
