import { isByHand } from "@/lib/people-entry";
import { type PeopleMap } from "../config";
import { type Manifest } from "../manifest";
import { People, UserDirectory, resolvePeople } from "../transform/people";

export function manifestPeople(manifest: Manifest, directory: UserDirectory, overrides: PeopleMap | null): People {
  const persons = manifest.people.filter((p) => p.kind === "person");
  const teams = manifest.people.filter((p) => p.kind === "team");
  return resolvePeople({
    userIds: persons.map((p) => p.id),
    teamIds: teams.map((t) => t.id),
    mondayUsers: Object.fromEntries(persons.map((p) => [p.id, { name: p.name, email: p.email, enabled: p.state !== "inactive", isPending: p.state === "pending" }])),
    mondayTeams: Object.fromEntries(teams.map((t) => [t.id, { name: t.name, users: t.members.map((email) => ({ id: "", email })) }])),
    directory,
    overrides,
  });
}

export function peopleWithStandIns(manifest: Manifest, directory: UserDirectory, people: PeopleMap | null = null): PeopleMap {
  const out: PeopleMap = { ...people };
  for (const [uid, result] of manifestPeople(manifest, directory, out).users) {
    if (Object.hasOwn(out, uid) && isByHand(out[uid])) continue;
    if (result.userId !== null) delete out[uid];
    else if (result.placeholder !== null && result.teamId !== null) out[uid] = { stand_in: result.teamId };
  }
  return out;
}

export function checkPeople(manifest: Manifest, directory: UserDirectory, overrides: PeopleMap | null = null): [problems: string[], warnings: string[]] {
  const people = manifestPeople(manifest, directory, overrides);
  const warnings: string[] = [];
  const agents = manifest.people.filter((p) => p.kind === "agent");
  if (agents.length) warnings.push(`${agents.length} monday agent assignment(s) have no Plaky counterpart`);
  return [people.problems(), warnings];
}
