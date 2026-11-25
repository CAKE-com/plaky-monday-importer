import type { PlakyClient } from "../../clients/plaky";
import type { BoardSync } from "../config";
import { isSeedMarker } from "../names";
import { asId, type PlakyField } from "../transform/mapping";
import { UserDirectory } from "../transform/people";
import { isDict, pyStr, pyStrip, truthy } from "../transform/pystr";
import { cmpCodePoints } from "../transform/pyvalue";
import { own, type PlakyRow } from "./compare";
import { MAX_PLAKY_PAGE_SIZE, SHARED_ID_FIX, SyncSetupError } from "./writes";

const rows = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

export type ExistingItem = {
  itemId: number;
  title: string;
  groupId: number | null;
  fields: Record<string, unknown>;
  subscriberIds: number[];
  commentCount: number;
  fileCount: number;
};

export function rowsByKey(found: ReadonlyMap<string, readonly (readonly [itemId: unknown, title: string])[]>): string {
  return [...found]
    .sort(([a], [b]) => cmpCodePoints(a, b))
    .map(([key, entries]) => `monday ${key}: ${entries.map(([itemId, title]) => `'${title}' (#${pyStr(itemId)})`).join(", ")}`)
    .join("; ");
}

const count = (value: unknown): number => Math.trunc(Number(truthy(value) ? value : 0));

export function existingByMondayId(
  listing: readonly PlakyRow[],
  config: BoardSync,
  idField: PlakyField | null,
  blankTitles: string[] | null = null,
): Map<string, ExistingItem> {
  const found = new Map<string, ExistingItem>();
  if (idField === null) return found;
  const collisions = new Map<string, [number, string][]>();
  for (const dumped of listing) {
    if (truthy(dumped["archived"]) || truthy(dumped["deleted"])) continue;
    const values: Record<string, unknown> = {};
    for (const raw of rows(dumped["fields"])) if (isDict(raw) && typeof raw["key"] === "string") values[raw["key"]] = raw["value"];
    const value = own(values, idField.key);
    if (typeof value !== "string" || !pyStrip(value)) {
      blankTitles?.push(String(truthy(dumped["title"]) ? dumped["title"] : ""));
      continue;
    }
    const key = pyStrip(value);
    if (isSeedMarker(key)) continue;
    const itemId = asId(dumped["id"]);
    if (itemId === null) continue;
    const title = String(truthy(dumped["title"]) ? dumped["title"] : "");
    const first = found.get(key);
    if (first !== undefined) {
      const entries = collisions.get(key) ?? [[first.itemId, first.title]];
      entries.push([itemId, title]);
      collisions.set(key, entries);
      continue;
    }
    found.set(key, {
      itemId,
      title,
      groupId: asId(dumped["group"]),
      fields: values,
      commentCount: count(dumped["commentCount"]),
      fileCount: count(dumped["fileCount"]),
      subscriberIds: rows(dumped["subscribedUsers"])
        .map(asId)
        .filter((uid): uid is number => uid !== null)
        .sort((a, b) => a - b),
    });
  }
  if (collisions.size > 0) {
    throw new SyncSetupError(
      `'${config.name}': board ${config.plakyBoardId} has more than one item with the same monday id (${rowsByKey(collisions)}), so updates would land on an arbitrary one. ${SHARED_ID_FIX}`,
    );
  }
  return found;
}

export async function readPlakyRows(plaky: PlakyClient, config: BoardSync): Promise<PlakyRow[]> {
  const rows = await plaky.collect((page) =>
    plaky.listItems(config.plakySpaceId, config.plakyBoardId, { page, pageSize: MAX_PLAKY_PAGE_SIZE, subitemsBehaviour: config.nested ? "INCLUDE" : "EXCLUDE" }),
  );
  return config.nested ? rows.filter((row) => asId(row["parent"]) !== null) : rows;
}

const DIRECTORY_TTL_MS = 30_000;
const directories = new WeakMap<PlakyClient, { at: number; directory: Promise<UserDirectory> }>();

export function loadDirectory(plaky: PlakyClient, now: number = Date.now()): Promise<UserDirectory> {
  const held = directories.get(plaky);
  if (held && now - held.at < DIRECTORY_TTL_MS) return held.directory;
  const directory = Promise.all([plaky.allUsers(), plaky.allTeams()]).then(([users, teams]) => UserDirectory.fromPlaky(users, teams));
  directories.set(plaky, { at: now, directory });
  directory.catch(() => { if (directories.get(plaky)?.directory === directory) directories.delete(plaky); });
  return directory;
}
