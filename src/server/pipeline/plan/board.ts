import type { PlakyClient } from "../../clients/plaky";
import { SINCE_MARGIN_MS } from "../names";
import { appliedState } from "../board-state";
import { FIELD_KEY, type BoardSync, type PeopleMap } from "../config";
import { fromArchive, type BoardExtract } from "../extract";
import { namesWithoutField, withNameKeys, withNameValues } from "../name-fields";
import { linksCommentId, planItemComments, renderLinks, type LinkEntry, type PlannedComment } from "../transform/comments";
import { docsInValue, filesInValue, type MondayFile } from "../transform/files";
import { buildFieldMap, buildItemFields, collectPeople, plakyFieldsFromBoard, spellingKey, usableZone } from "../transform/mapping";
import { planGroupWrites } from "../transform/order";
import { People, isCarried, resolvePeople, type PeopleOverrides } from "../transform/people";
import { PY_SPACE, isDict, pyStrip } from "../transform/pystr";
import { cmpCodePoints, pyRepr } from "../transform/pyvalue";
import { UserDirectory } from "../transform/people";
import { findField, holdsValue, own, sameValues, uncarriedLine, withoutClears, type PlakyRow } from "./compare";
import { spareCopies } from "./copies";
import { changesGroup, placedRows, type Placement } from "./placement";
import { existingByMondayId, loadDirectory, readPlakyRows } from "./existing";
import { keptAsText, nameSlots, personIds, type KeptNames } from "./refused";
import { followRenamedGroups, groupStates, groupTitleFor, groupTitles, wantedGroups, withRenames, type GroupInput } from "./groups";
import { MAX_TITLE, SyncSetupError, plannedWrite, type BoardPlan, type ItemComments, type ItemFiles, type PlannedWrite } from "./writes";

const codePoints = (text: string): string[] => [...text];
const TRAILING_SPACE = new RegExp(`[${PY_SPACE}]+$`);

type PlanBoardOptions = {
  allowDuplicateImport?: boolean;
  docs?: boolean;
  rich?: boolean;
  links?: boolean;
  isDelta?: boolean;
  directory?: UserDirectory;
  peopleMap?: PeopleOverrides | PeopleMap | null;
  zone?: string | null;
  parentTitles?: ReadonlyMap<string, string>;
  plakyRows?: readonly PlakyRow[];
  plakyGroups?: readonly GroupInput[];
  syncPoint?: string | null;
  mondayOrder?: () => Promise<readonly string[]>;
};

function peopleSummary(people: People): string {
  const users = [...people.users.values()];
  const teams = [...people.teams.values()];
  const standIns = users.filter((r) => r.teamId !== null && r.placeholder).length;
  const matched = users.filter((r) => r.userId !== null).length;
  const lost = [...users, ...teams].filter((r) => !isCarried(r)).length;
  const parts = [`${matched} person(s) matched to Plaky users`];
  if (standIns) parts.push(`${standIns} without a Plaky user to assign, on empty stand-in teams`);
  if (teams.length) parts.push(`${teams.filter(isCarried).length} of ${teams.length} team(s) matched`);
  if (lost) parts.push(`${lost} not carried (below)`);
  return parts.join(", ");
}

export function nestedParentProblem(item: { parentId: string | null }, parentIds?: ReadonlySet<string>): string | null {
  if (item.parentId === null) return "no parent in monday; a nested subitem needs its parent item";
  if (parentIds !== undefined && !parentIds.has(item.parentId)) return `its parent (monday ${item.parentId}) is not an active item on the parent board`;
  return null;
}

type AssetOptions = { docs?: boolean | undefined; rich?: boolean | undefined };

export function fileEntries(extract: BoardExtract, config: Pick<BoardSync, "syncFiles">, options: AssetOptions = {}): (item: BoardExtract["items"][number]) => MondayFile[] {
  const fileColumns = extract.board.columns.filter((c) => c.type === "file").map((c) => c.id);
  const docColumns = extract.board.columns.filter((c) => c.type === "doc").map((c) => c.id);
  const attached = new Map<string, MondayFile[]>();
  for (const update of config.syncFiles ? extract.updates : []) {
    for (const [assetId, name] of update.assets) attached.set(update.itemId, [...(attached.get(update.itemId) ?? []), { name, assetId, url: null }]);
  }
  return (item) => {
    const listed: MondayFile[] = config.syncFiles ? (item.assets ?? []).map(([assetId, name]) => ({ assetId, name, url: null })) : [];
    const typed = (type: string, known: readonly string[]): string[] => [...known, ...Object.entries(item.columnValues).filter(([id, cv]) => cv["type"] === type && !known.includes(id)).map(([id]) => id)];
    for (const columnId of typed("file", fileColumns)) listed.push(...filesInValue(item.columnValues[columnId]?.value));
    for (const columnId of config.syncFiles && options.docs ? typed("doc", docColumns) : []) listed.push(...docsInValue(item.columnValues[columnId]?.value));
    const images = item.columnValues["__description"]?.["images"];
    if (config.syncFiles && options.rich && Array.isArray(images)) listed.push(...(images as MondayFile[]));
    listed.push(...(attached.get(item.id) ?? []));
    return listed;
  };
}

export function expectedAssets(entries: readonly MondayFile[], config: Pick<BoardSync, "syncFiles">): Map<string, MondayFile> {
  const assets = new Map<string, MondayFile>();
  if (config.syncFiles) for (const entry of entries) if (entry.assetId !== null && !assets.has(entry.assetId)) assets.set(entry.assetId, entry);
  return assets;
}

export function commentChecks(plan: Pick<BoardPlan, "comments">): number {
  return [...plan.comments.values()].filter((entry) => entry.planned.some((c) => c.kind !== "links")).length;
}

const sameIds = (a: readonly number[], b: readonly number[]): boolean => a.length === b.length && a.every((v, i) => v === b[i]);
const staleEmpty = (v: unknown): boolean => v === null || v === undefined || v === "" || (Array.isArray(v) && v.length === 0) || (isDict(v) && Object.keys(v).length === 0);

export async function planBoard(read: BoardExtract, plaky: PlakyClient, config: BoardSync, options: PlanBoardOptions = {}): Promise<BoardPlan> {
  const plakyBoard = await plaky.getBoard(config.plakySpaceId, config.plakyBoardId);
  const plakyFieldList = plakyFieldsFromBoard(plakyBoard);
  const pairedFields = withNameKeys(read, config, plakyFieldList);
  const extract = withNameValues(read, pairedFields, (options.peopleMap ?? {}) as PeopleMap);
  const mondayBoard = extract.board;
  const allowDuplicateImport = options.allowDuplicateImport ?? false;
  const zone = options.zone === undefined ? extract.timeZone : options.zone;
  const notes: string[] = [];

  const idField = findField(plakyFieldList, config.mondayIdField);
  if (idField === null) {
    if (!allowDuplicateImport && FIELD_KEY.test(config.mondayIdField ?? "")) {
      throw new SyncSetupError(
        `'${config.name}': the Monday ID field recorded for board ${config.plakyBoardId}, key '${config.mondayIdField}', is gone: deleted, or its type changed in Plaky, which gives a field a new key. If its type was changed, run link again to pair it. If it was deleted, its values went with it: a field added in its place starts empty, and on a board this tool has written to, planning stops while no row carries a Monday ID. Nothing is written until then: every run would create duplicates.`,
      );
    }
    if (!allowDuplicateImport) {
      throw new SyncSetupError(
        `'${config.name}': no Plaky field '${config.mondayIdField ?? "None"}' on board ${config.plakyBoardId}, so existing items cannot be matched and every run would create duplicates. Add a STRING field with that name, or pass --allow-duplicate-import for a deliberate one-shot import.`,
      );
    }
    notes.push("No monday-id field: this run will create items unconditionally and a second run will duplicate them.");
  } else if (idField.type !== "STRING") {
    throw new SyncSetupError(
      `'${config.name}': Plaky field '${idField.name}' (${idField.key}) is ${idField.type}, not STRING. monday ids cannot be stored there and every item write would fail.`,
    );
  }

  const flat = Boolean(config.subitemsOf) && !config.nested;
  const parentTitleField = flat ? findField(plakyFieldList, config.parentTitleField) : null;
  const parentIdField = flat ? findField(plakyFieldList, config.parentIdField) : null;
  if (flat) {
    for (const [label, wanted, found] of [
      ["parent title", config.parentTitleField, parentTitleField],
      ["parent monday id", config.parentIdField, parentIdField],
    ] as const) {
      if (wanted && found === null) notes.push(`No Plaky field '${wanted}' for the ${label}; imported subitems will not carry it.`);
    }
  }

  let items = [...extract.items];
  const reserved = new Set([idField, parentTitleField, parentIdField].flatMap((f) => (f ? [f.key] : [])));
  const fieldMap = buildFieldMap(mondayBoard.columns, plakyFieldList, { overrides: pairedFields, skipColumns: new Set(config.skipColumns), reservedFieldKeys: reserved });

  const inactive = items.filter((i) => i.state !== "active");
  if (inactive.length) {
    notes.push(`${inactive.length} monday item(s) are archived or deleted and will not be imported`);
    items = items.filter((i) => i.state === "active");
  }
  const taken = new Set(fieldMap.pairs.map((pair) => pair.target.key));
  const uncarried: string[] = namesWithoutField(extract, pairedFields, (options.peopleMap ?? {}) as PeopleMap, config.skipColumns);
  for (const [column, why] of fieldMap.uncarried) {
    const held = items.filter((item) => holdsValue(item.columnValues[column.id])).length;
    if (held) uncarried.push(uncarriedLine(column, why, held, plakyFieldList, taken));
  }
  const [userIds, teamIds] = collectPeople(items, fieldMap.pairs);
  if (config.syncSubscribers) {
    const known = [...userIds];
    userIds.push(...items.flatMap((item) => item.subscriberIds.filter((uid) => !known.includes(uid))));
  }
  const directory = options.directory ?? (await loadDirectory(plaky));
  const people = resolvePeople({ userIds, teamIds, mondayUsers: extract.users, mondayTeams: extract.teams, directory, overrides: options.peopleMap ?? null });
  if (userIds.length || teamIds.length) {
    notes.push(`People: ${peopleSummary(people)}`);
    notes.push(...people.problems().map((problem) => `   ! ${problem}`));
  }

  const parentTitles = options.parentTitles ?? new Map<string, string>();

  const blankTitles: string[] = [];
  const listing = options.plakyRows ?? (await readPlakyRows(plaky, config));
  const { rows: carriers, copies } = idField === null ? { rows: listing, copies: [] } : spareCopies(listing, idField.key);
  for (const c of copies) {
    notes.push(`monday ${c.mondayItemId}: Plaky rows #${c.keep} and #${c.copy} are one item created twice (a create whose answer was lost landed later); #${c.copy} holds nothing of its own and is deleted, #${c.keep} is kept`);
  }
  const existing = existingByMondayId(carriers, config, idField, blankTitles);
  if (appliedState(config) === "written" && existing.size === 0 && blankTitles.length && items.length && !allowDuplicateImport) {
    throw new SyncSetupError(
      `'${config.name}': this tool has written items to Plaky board ${config.plakyBoardId} before, and none of its ${blankTitles.length} rows carries a Monday ID now: the ids were lost, as when the Monday ID field is deleted and added again, and a plan now would create every item a second time beside them. Nothing is written. Bring the old values back in Plaky if you can; if not, delete those rows and run again: the items are created afresh, without the rows' Plaky comments and files.`,
    );
  }
  const groupCandidates = new Map<string, number[]>();
  const plakyGroups = groupStates(options.plakyGroups ?? (await plaky.allItemGroups(config.plakySpaceId, config.plakyBoardId)));
  for (const group of plakyGroups) {
    const key = spellingKey(group.title);
    groupCandidates.set(key, [...(groupCandidates.get(key) ?? []), group.id]);
  }
  const ambiguousGroups = [...groupCandidates].filter(([key, ids]) => key && ids.length > 1);
  if (ambiguousGroups.length) {
    const detail = ambiguousGroups
      .sort(([a], [b]) => cmpCodePoints(a, b))
      .map(([key, ids]) => `${key}: [${ids.join(", ")}]`)
      .join(", ");
    throw new SyncSetupError(`'${config.name}': Plaky has groups whose names collide after normalization (${detail}); rename one before syncing`);
  }
  const groupIds = new Map([...groupCandidates].flatMap(([key, ids]) => (ids[0] === undefined ? [] : [[key, ids[0]] as [string, number]])));
  const titlesOfGroups = groupTitles(mondayBoard);
  const renamedGroups = config.syncGroups ? followRenamedGroups(items, existing, titlesOfGroups, plakyGroups, groupIds, config.seedGroupId) : new Map<number, string>();
  const plakyGroupById = new Map(plakyGroups.map((group) => [group.id, group]));
  for (const [groupId, oldTitle] of renamedGroups) {
    notes.push(
      `Plaky group '${oldTitle}' holds the items of monday group '${plakyGroupById.get(groupId)?.title}', so it takes monday's title (the group was renamed in monday or in Plaky)`,
    );
  }

  const comparators = new Map(fieldMap.pairs.map((pair) => [pair.target.key, pair.target]));
  for (const support of [idField, parentTitleField, parentIdField]) if (support !== null) comparators.set(support.key, support);
  const kept: KeptNames = {
    targets: comparators,
    slots: nameSlots(fieldMap),
    names: (kind, id) => (kind === "team" ? directory.teamsById.get(id)?.title : directory.byId.get(id)?.name) || undefined,
    idKey: idField?.key ?? null,
  };

  const writes: PlannedWrite[] = [];
  const referencedGroups: string[] = [];
  const parentIds = config.nested && options.parentTitles ? new Set(options.parentTitles.keys()) : undefined;
  const unparented: string[] = [];
  for (const item of items) {
    if (config.nested) {
      const problem = nestedParentProblem(item, parentIds);
      if (problem !== null) {
        unparented.push(`${item.name} (${item.id}): ${problem}`);
        continue;
      }
    }
    const built = buildItemFields(item, fieldMap, { labelMaps: config.labelMap, people, zone, ...(options.rich ? { rich: true } : {}) });
    const fields: Record<string, unknown> = built.payload;
    const warnings = built.warnings;
    const notCarried = [...warnings];
    if (config.nested && fromArchive(item)) warnings.push("archived in monday: imported as an active subitem under its parent");
    const match = existing.get(item.id);
    for (const target of built.uncleared) {
      const stale = match ? own(match.fields, target.key) : undefined;
      if (staleEmpty(stale)) continue;
      const reason = target.type === "STATUS" ? "the Plaky field has no empty label" : `Plaky rejects an empty ${target.type}`;
      const staleNote = `'${target.name}' (${target.key}) was cleared in monday, but ${reason}, so ${pyRepr(stale)} remains until it is cleared by hand in Plaky`;
      warnings.push(staleNote);
      notCarried.push(staleNote);
    }
    if (idField) fields[idField.key] = item.id;

    if (parentTitleField && item.parentId) fields[parentTitleField.key] = parentTitles.get(item.parentId) ?? item.parentId;
    if (parentIdField && item.parentId) fields[parentIdField.key] = item.parentId;
    if (config.subitemsOf && !item.parentId) {
      warnings.push("no parent in monday: carried without one");
    }

    const groupTitle = config.syncGroups ? (titlesOfGroups.get(item.groupId ?? "") ?? (item.groupTitle === null ? null : groupTitleFor(item.groupTitle))) : null;
    if (groupTitle && !referencedGroups.includes(groupTitle)) referencedGroups.push(groupTitle);

    let title = pyStrip(item.name) ? item.name : "New Item";
    const length = codePoints(title).length;
    if (length > MAX_TITLE) {
      title = `${codePoints(title).slice(0, MAX_TITLE - 1).join("").replace(TRAILING_SPACE, "")}…`;
      warnings.push(`title is ${codePoints(item.name).length} characters; Plaky accepts ${MAX_TITLE}, so it was truncated`);
    }

    let drifted = false;
    if (match && match.title !== title) {
      drifted = true;
      warnings.push(`title drift: monday '${title}' vs Plaky '${match.title}' (Plaky has no item-title update endpoint)`);
    }
    const subscribers = config.syncSubscribers ? people.subscriberIds(item.subscriberIds) : [];
    const sameFields = match !== undefined && (sameValues(fields, match.fields, comparators, directory) || keptAsText(fields, match.fields, kept, directory));
    const sameSubscribers = match !== undefined && sameIds(match.subscriberIds, subscribers);

    writes.push(
      plannedWrite({
        mondayItemId: item.id,
        subscriberIds: subscribers,
        title,
        groupTitle,
        fields: match ? fields : withoutClears(fields, comparators),
        existingItemId: match?.itemId ?? null,
        existingTitle: match?.title ?? null,
        existingFields: match ? { ...match.fields } : null,
        existingGroupId: match?.groupId ?? null,
        existingSubscriberIds: match ? [...match.subscriberIds] : [],
        unchanged: sameFields && (!config.syncSubscribers || subscribers.length === 0 || sameSubscribers),
        sameFields,
        sameSubscribers,
        drifted,
        warnings,
        notCarried,
        parentMondayItemId: item.parentId,
        uncleared: built.uncleared.map((target) => target.key),
      }),
    );
  }

  const utcTimes = !usableZone(zone) && writes.some((w) => Object.values(w.fields).some((v) => typeof v === "string" && /T\d{2}:\d{2}(:\d{2})?Z$/.test(v)));
  if (utcTimes) notes.push(`monday gave no usable time zone for its user (${zone ? `"${zone}"` : "none"}): times are written in UTC, so one near midnight can show on another day in Plaky`);
  if (unparented.length) notes.push(`${unparented.length} subitem(s) have no parent row to nest under and are not carried: ${unparented.join("; ")}`);

  const wanted = config.syncGroups ? wantedGroups(mondayBoard, titlesOfGroups, referencedGroups) : [];
  let groupWrites = wanted.length ? planGroupWrites(wanted, plakyGroups) : [];
  if (renamedGroups.size) groupWrites = withRenames(groupWrites, renamedGroups, plakyGroupById, wanted);
  let seedGroupId: number | null = null;
  if (config.seedGroupId && wanted.length) {
    const seed = plakyGroups.find((g) => g.id === config.seedGroupId);
    const mondayTitles = new Set(wanted.map(([title]) => spellingKey(title)));
    if (seed !== undefined && !mondayTitles.has(spellingKey(seed.title))) seedGroupId = seed.id;
  }

  const byItem = new Map<string, BoardExtract["updates"]>();
  for (const update of extract.updates) byItem.set(update.itemId, [...(byItem.get(update.itemId) ?? []), update]);
  const byId = new Map(items.map((item) => [item.id, item]));
  const syncPoint = options.syncPoint ? Date.parse(options.syncPoint) - SINCE_MARGIN_MS : NaN;
  const before = (iso: string | null | undefined): boolean => iso != null && Date.parse(iso) <= syncPoint;
  const settled = (itemId: string): boolean =>
    !Number.isNaN(syncPoint) && before(byId.get(itemId)?.columnValues["__updated_at"]?.text)
    && (byItem.get(itemId) ?? []).every((u) => before(u.createdAt) && (u.editedAt === null || before(u.editedAt)));

  const comments = new Map<string, ItemComments>();
  if (config.syncComments) {
    if (idField === null) {
      throw new SyncSetupError(`'${config.name}': sync_comments needs the monday-id field, so a re-run can tell which comments are already there`);
    }
    const boardPosts = (byItem.get("") ?? []).filter((u) => !u.parentId).length;
    if (boardPosts) notes.push(`${boardPosts} board-level update(s) belong to no item; Plaky has no board comments, so they are not carried`);
    for (const write of writes) {
      const planned = planItemComments(byItem.get(write.mondayItemId) ?? [], config.syncFiles, options.rich === true);
      if (planned.length) {
        const match = existing.get(write.mondayItemId);
        comments.set(write.mondayItemId, { planned, plakyItemId: match?.itemId ?? null, commentCount: match?.commentCount ?? 0, settled: settled(write.mondayItemId) });
      }
    }
  }

  const files = new Map<string, ItemFiles>();
  if (config.syncFiles || options.links) {
    if (config.syncFiles && idField === null) {
      throw new SyncSetupError(`'${config.name}': sync_files needs the monday-id field, so a re-run can tell which files are already there`);
    }
    const entriesOf = fileEntries(extract, config, options);
    for (const write of writes) {
      const item = byId.get(write.mondayItemId);
      if (item === undefined) throw new Error(`KeyError: ${write.mondayItemId}`);
      const listed = entriesOf(item);
      const assets = expectedAssets(listed, config);
      const links: LinkEntry[] = [];
      for (const entry of listed.filter((e) => e.assetId === null)) {
        if (!options.links) {
          write.warnings.push(`file '${entry.name}' is a link in monday, not a stored file, so there is nothing to copy; add the link to the Plaky item by hand`);
        } else if (entry.url && config.syncComments) {
          if (!links.some((l) => l.url === entry.url && l.name === entry.name)) links.push({ name: entry.name, url: entry.url });
        } else {
          const note = entry.url
            ? `file '${entry.name}' is a link in monday (${entry.url}), not a stored file; it is carried as a comment only with Comments on: add the link to the Plaky item by hand`
            : `file '${entry.name}' is a link in monday with no address, not a stored file, so there is nothing to copy`;
          write.warnings.push(note);
          write.notCarried.push(note);
        }
      }
      if (assets.size) {
        const match = existing.get(item.id);
        files.set(item.id, { assets: [...assets.values()], plakyItemId: match?.itemId ?? null, fileCount: match?.fileCount ?? 0 });
      }
      if (links.length) {
        const planned: PlannedComment = { kind: "links", mondayId: linksCommentId(item.id), text: renderLinks(item.id, links, options.rich === true), replyTo: null };
        const held = comments.get(item.id);
        if (held) held.planned.push(planned);
        else {
          const match = existing.get(item.id);
          comments.set(item.id, { planned: [planned], plakyItemId: match?.itemId ?? null, commentCount: match?.commentCount ?? 0, settled: settled(item.id) });
        }
      }
    }
  }

  const delta = Boolean(options.isDelta || extract.isDelta);
  let placement: Placement | null = null;
  if (!config.nested && idField !== null) {
    if (!delta) placement = { order: writes.map((write) => write.mondayItemId), rows: placedRows(carriers, existing), scope: "board" };
    else if (options.mondayOrder && writes.some((write) => !write.existingItemId || changesGroup(write, groupIds))) placement = { order: [...(await options.mondayOrder())], rows: placedRows(carriers, existing), scope: "landed" };
  }

  const seen = new Set([...items.map((item) => item.id), ...(extract.outOfScope ?? [])]);
  const orphans: [number, string][] = delta
    ? []
    : [...existing]
        .sort(([a], [b]) => cmpCodePoints(a, b))
        .filter(([mondayId]) => !seen.has(mondayId))
        .map(([, existingItem]) => [existingItem.itemId, existingItem.title]);

  const assigneeNames = new Map<string, string>();
  for (const write of writes) {
    for (const [key, value] of Object.entries(write.fields)) {
      if (comparators.get(key)?.type !== "PERSON") continue;
      const held = personIds(value);
      for (const [kind, list] of [["team", held.teams], ["user", held.users]] as const) {
        for (const id of list) {
          const name = kept.names(kind, id);
          if (name !== undefined) assigneeNames.set(`${kind}:${id}`, name);
        }
      }
    }
  }

  return {
    config,
    mondayBoardName: mondayBoard.name,
    plakyBoardName: String(plakyBoard.title || plakyBoard["name"] || config.plakyBoardId),
    fieldMap,
    writes,
    groupWrites,
    orphans,
    ...(extract.outOfScope?.length ? { outOfScope: extract.outOfScope.length } : {}),
    ...(extract.archivedCarried ? { archivedCarried: extract.archivedCarried } : {}),
    ...(extract.deeper?.length ? { deeper: extract.deeper } : {}),
    groupIds,
    notes,
    mondayIdKey: idField?.key ?? null,
    seedGroupId,
    comments,
    files,
    uncarried,
    archivedGroups: mondayBoard.groups.filter((g) => g.archived).map((g) => g.title),
    existingIds: new Map([...existing].map(([mondayId, row]) => [mondayId, row.itemId])),
    copies,
    ...(placement ? { placement } : {}),
    ...(assigneeNames.size ? { assigneeNames } : {}),
  };
}
