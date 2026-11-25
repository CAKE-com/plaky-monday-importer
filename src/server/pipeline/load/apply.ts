import { ItemTargets, CreationStacks } from "./item-state";
import { RebuildRecovery } from "./rebuild-state";
import { isDeletedComment, isFeatureLimit, isOutcomeUnknown, isPlakyHttp, isRateLimited, type BeforeSend, type CreateItemBody, type PlakyItem } from "../../clients/plaky";
import { isMondayDailyLimit } from "../../clients/monday";
import { FileTooLarge, type AssetSource } from "../assets";
import { MAX_TITLE, SyncSetupError, existingByMondayId, groupTargets, inMondayOrder, itemMoves, nameSlots, placedRows, plannedMoves, readPlakyRows, refusalNotes, refusedParts, replacesSubscribers, spareCopies, withoutClears, withoutRefused, type BoardPlan, type KeptNames, type Placement, type PlacedRow, type PlannedWrite } from "../plan";
import { MAX_COMMENTS_PER_ITEM, commentHeader, headerOf, markerKey, markerOf, type PlannedComment } from "../transform/comments";
import { contentType, type MondayFile } from "../transform/files";
import { asId, plakyField, spellingKey, titleByKey } from "../transform/mapping";
import { groupAction } from "../transform/order";
import { isDict, pyStrip, truthy } from "../transform/pystr";
import { checkBeforeDelete } from "../made-in-plaky";
import { heldFile, matchFiles, type HeldFile } from "./file-match";
import { emptyListing, fileKey, newApplyResult, textOf, type ApplyDeps, type ApplyOptions, type ApplyResult, type FilesOutcome } from "./results";
import { PERMANENT_UPLOAD, REFUSED_FOR_GOOD, type BoardKey, type Commit, type EntityRef, type FileMapping } from "./store";

const GROUP_COLOR = /^#[0-9a-fA-F]{6}$/;
const needColor = (color: unknown): void => {
  if (typeof color !== "string" || !GROUP_COLOR.test(color)) throw new SyncSetupError("body.color must be a #RRGGBB colour");
};

export const RATE_LIMITED = "Plaky kept answering 429 (rate limit), so that request was not applied. Re-run to continue.";

export async function applyPlan(deps: ApplyDeps, plan: BoardPlan, options: ApplyOptions = {}): Promise<ApplyResult> {
  const { plaky, store, fetcher } = deps;
  const config = plan.config;
  const result = newApplyResult();
  const space = config.plakySpaceId;
  const board = config.plakyBoardId;
  const itemType = config.subitemsOf ? "subitem" : "item";
  const commentCap = options.maxCommentsPerItem ?? MAX_COMMENTS_PER_ITEM;

  const emit = (level: "info" | "warn" | "error" | "ambiguous", code: string, message: string, data?: Record<string, unknown>): void => {
    try {
      deps.log?.({ level, code, message, board: config.name, ...(data ? { data } : {}) });
    } catch {
    }
  };
  const tick = (): void => {
    try {
      deps.progress?.();
    } catch {
    }
  };
  let current: string | null = null;
  const about = (): Record<string, unknown> | undefined => (current === null ? undefined : { mondayItemId: current });
  const fail = (message: string): void => {
    result.failures.push(message);
    emit("error", "write.failed", message, about());
  };
  const failForGood = (message: string): void => {
    result.permanentFailures++;
    fail(message);
  };
  const failBoard = (message: string): void => {
    result.failures.push(message);
    emit("error", "write.failed", message);
  };
  const unknownOutcome = (message: string): void => {
    result.ambiguous.push(message);
    emit("ambiguous", "write.ambiguous", message, about());
  };
  const note = (message: string): void => {
    result.notes.push(message);
    emit("info", "note", message);
  };
  const stopRateLimited = (label: string): void => {
    result.failures.push(`${label}: ${RATE_LIMITED}`);
    result.rateLimited = true;
    emit("error", "rate_limited", `${label}: ${RATE_LIMITED}`, about());
  };

  for (const message of plan.uncarried) failForGood(`not carried: ${message}`);

  const cache = async (write: () => Promise<void>): Promise<void> => {
    try {
      await write();
    } catch (error) {
      note(`entity_mappings not updated (${textOf(error)})`);
    }
  };

  const send = async <T>(ref: EntityRef | null, request: () => Promise<T>, onOk?: (answer: T) => Commit, afterDelete = false): Promise<T> => {
    if (ref) {
      if (afterDelete) await cache(() => store.markDispatched(ref));
      else await store.markDispatched(ref);
    }
    result.writes++;
    let answer: T;
    try {
      answer = await request();
    } catch (error) {
      if (ref) await cache(() => (isOutcomeUnknown(error) ? store.markAmbiguous(ref, textOf(error)) : store.markFailed(ref, textOf(error))));
      if (isPlakyHttp(error) && (error.status === 401 || error.status === 403) && !isFeatureLimit(error)) result.stopped = true;
      throw error;
    }
    tick();
    if (ref && onOk) await cache(() => store.markCommitted(ref, onOk(answer)));
    return answer;
  };

  const boardKey: BoardKey = { space, board };
  const answered = async (mondayItemId: string): Promise<void> => {
    try {
      await store.rowWriteAnswered(boardKey, mondayItemId);
    } catch (error) {
      note(`the sent write for monday item ${mondayItemId} is still on record (${textOf(error)}); the next run waits out its landing window first`);
    }
  };
  const rowWrite = async <T>(mondayItemId: string, request: (beforeSend: BeforeSend) => Promise<T>): Promise<T> => {
    let answer: T;
    try {
      answer = await request(() => store.rowWriteSent(boardKey, mondayItemId));
    } catch (error) {
      if (!isOutcomeUnknown(error)) await answered(mondayItemId);
      throw error;
    }
    await answered(mondayItemId);
    return answer;
  };

  const itemRef = (mondayItemId: string): EntityRef => ({ type: itemType, mondayId: mondayItemId, scope: "", occurrence: 0 });
  const groupRef = (title: string): EntityRef => ({ type: "group", mondayId: spellingKey(title), scope: config.mondayBoardId, occurrence: 0 });
  const itemCommit = (plakyId: number): Commit => ({ plakyId, plakyParentId: board });

  const proceed = async (): Promise<boolean> => {
    if (result.stopped) return false;
    if (options.signal?.aborted) {
      result.stopped = true;
      note("stopped on request, after the write in flight; re-run to continue");
      return false;
    }
    let held = false;
    let why = "its lease was taken over";
    try {
      held = await store.heartbeat();
    } catch (error) {
      why = `the lease could not be extended: ${textOf(error)}`;
    }
    if (!held) {
      result.stopped = true;
      failBoard(`stopped: another run may hold Plaky board ${space}/${board} now (${why}); re-run to continue`);
    }
    return held;
  };

  const groupTroubleBefore = result.failures.length + result.ambiguous.length;
  for (const planned of plan.groupWrites) {
    if (planned.groupId === null) continue;
    if (!(await proceed())) return result;
    const label = `group '${planned.title}'`;
    const change = groupAction(planned);
    const groupId = planned.groupId;
    try {
      if (!planned.ranking) throw new SyncSetupError("body.ranking must be a non-empty string");
      needColor(planned.color);
      const ranking = planned.ranking;
      await send(groupRef(planned.title), () => plaky.updateItemGroup(space, board, groupId, { title: planned.title, ranking, color: planned.color }), () => itemCommit(groupId));
      if (change === "rename") result.groupsRenamed++;
      else result.groupsReordered++;
      emit("info", `group.${change === "rename" ? "renamed" : "reordered"}`, `${label} ${change === "rename" ? "renamed" : "re-ranked"}`, { plakyGroupId: groupId });
    } catch (error) {
      if (isRateLimited(error)) {
        stopRateLimited(label);
        return result;
      }
      if (isOutcomeUnknown(error)) unknownOutcome(`${label}: ${change} dispatched, outcome unknown (${textOf(error)})`);
      else fail(`${label}: ${change} failed (${textOf(error)})`);
    }
  }

  for (const planned of plan.groupWrites.filter((g) => g.groupId === null).reverse()) {
    if (!(await proceed())) return result;
    const title = planned.title;
    const ref = groupRef(title);
    const body: { title: string; color: string; ranking?: string } = { title: [...title].slice(0, MAX_TITLE).join(""), color: planned.color };
    if (planned.ranking) body.ranking = planned.ranking;
    try {
      needColor(planned.color);
      const group = await send(ref, () => plaky.createItemGroup(space, board, body), (g) => itemCommit(g.id));
      plan.groupIds.set(spellingKey(title), group.id);
      result.groupsCreated++;
      emit("info", "group.created", `group '${title}' created`, { plakyGroupId: group.id });
    } catch (error) {
      if (isRateLimited(error)) {
        stopRateLimited(`group '${title}'`);
        return result;
      }
      if (!(isOutcomeUnknown(error))) {
        fail(`group '${title}': ${textOf(error)}`);
        continue;
      }
      let recovered: number | null = null;
      try {
        const matches = (await plaky.allItemGroups(space, board)).filter((g) => spellingKey(g.title) === spellingKey(title));
        recovered = matches.length === 1 ? matches[0]!.id : null;
      } catch {
        recovered = null;
      }
      if (recovered !== null) {
        plan.groupIds.set(spellingKey(title), recovered);
        result.groupsCreated++;
        const groupId = recovered;
        await cache(() => store.markCommitted(ref, itemCommit(groupId)));
        emit("info", "group.created", `group '${title}' created (found again after its answer was lost)`, { plakyGroupId: groupId });
      } else {
        unknownOutcome(`group '${title}': dispatched, outcome unknown (${textOf(error)})`);
      }
    }
  }

  if (plan.seedGroupId !== null) {
    const groupTrouble = result.failures.length + result.ambiguous.length > groupTroubleBefore;
    const seed = plan.seedGroupId;
    const label = `seed group ${seed}`;
    const others = [...plan.groupIds.values()].filter((id) => id !== seed);
    if (groupTrouble || others.length === 0) {
      note(`${label} kept: the monday groups are not all in place yet`);
    } else {
      try {
        if (!(await proceed())) return result;
        const rows = await plaky.allItems(space, board, "INCLUDE");
        if (rows.some((row) => asId(row.group) === seed)) {
          note(`${label} kept: it still holds items`);
        } else {
          await send(null, () => plaky.deleteItemGroup(space, board, seed));
          result.seedGroupDeleted = true;
          emit("info", "group.seed_deleted", `${label} deleted`, { plakyGroupId: seed });
        }
      } catch (error) {
        if (isRateLimited(error)) {
          stopRateLimited(label);
          return result;
        }
        note(`${label} kept: could not delete it (${textOf(error)})`);
      }
    }
  }

  const targets = new ItemTargets();
  const remember = (mondayItemId: string, plakyItemId: number): void => {
    targets.remember(mondayItemId, plakyItemId);
    result.plakyItemIds[mondayItemId] = plakyItemId;
  };
  const targetByKey = new Map(plan.fieldMap.pairs.map((pair) => [pair.target.key, pair.target]));

  const kept: KeptNames = { targets: targetByKey, slots: nameSlots(plan.fieldMap), names: (kind, id) => plan.assigneeNames?.get(`${kind}:${id}`), idKey: plan.mondayIdKey };
  const withFallback = async <T>(write: PlannedWrite, fields: Record<string, unknown>, request: (fields: Record<string, unknown>) => Promise<T>): Promise<T> => {
    try {
      return await request(fields);
    } catch (error) {
      const parts = refusedParts(error);
      const retry = parts === null ? null : withoutRefused(fields, parts, kept);
      if (parts === null || retry === null) throw error;
      const answer = await request(retry.fields);
      for (const line of refusalNotes(write.title, retry.withheld, parts, kept)) note(line);
      return answer;
    }
  };

  const parentRowOf = (write: PlannedWrite): number | null => (config.nested && write.parentMondayItemId ? (options.parentIds?.(write.parentMondayItemId) ?? null) : null);

  const settled = plan.writes.filter((w) => w.unchanged && w.existingItemId !== null).map((w) => ({ ref: itemRef(w.mondayItemId), commit: itemCommit(w.existingItemId!) }));
  if (settled.length) await cache(() => store.reconcile(settled));

  const create = async (write: PlannedWrite, afterDelete = false): Promise<number> => {
    const body: CreateItemBody = { title: write.title, fields: {} };
    const parentId = parentRowOf(write);
    if (parentId !== null) body.parentId = parentId;
    if (config.syncSubscribers && write.subscriberIds.length > 0) body.subscribedUserIds = [...write.subscriberIds];
    if (write.groupTitle) {
      const groupId = plan.groupIds.get(spellingKey(write.groupTitle));
      if (groupId === undefined) throw new SyncSetupError(`item group '${write.groupTitle}' could not be created`);
      body.groupId = groupId;
    }
    const created = await withFallback(write, write.fields, (fields) =>
      send(itemRef(write.mondayItemId), () => rowWrite(write.mondayItemId, (sent) => plaky.createItem(space, board, { ...body, fields: withoutClears(fields, targetByKey) }, undefined, sent)), (item) => itemCommit(item.id), afterDelete),
    );
    remember(write.mondayItemId, created.id);
    emit("info", "item.created", "item created", { mondayItemId: write.mondayItemId, plakyItemId: created.id });
    return created.id;
  };

  const restoreDeleted = async (write: PlannedWrite, why: string): Promise<number | null> => {
    if (write.existingFields === null) {
      fail("rollback unavailable: the old item snapshot was not retained");
      return null;
    }
    const oldFields: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(write.existingFields)) {
      const target = targetByKey.get(key);
      if (emptyListing(value)) continue;
      if (target?.type === "LINK" && isDict(value) && !truthy(value["url"])) continue;
      if (target?.type === "STATUS") {
        oldFields[key] = titleByKey(target).get(String(value)) ?? value;
      } else if (target?.type === "TAG" && Array.isArray(value)) {
        const titles = titleByKey(target);
        oldFields[key] = value.map((entry) => titles.get(String(entry)) ?? entry);
      } else if (target?.type === "PERSON" && isDict(value)) {
        const ids = (entries: unknown) => (Array.isArray(entries) ? entries : []).flatMap((entry) => asId(entry) ?? []).map((id) => ({ id }));
        oldFields[key] = { users: ids(value["assignedUsers"]), teams: ids(value["assignedTeams"]) };
      } else {
        oldFields[key] = value;
      }
    }
    const body: CreateItemBody = { title: write.existingTitle || write.title, fields: oldFields };
    if (write.existingGroupId !== null) body.groupId = write.existingGroupId;
    let restoredId: number;
    try {
      restoredId = (await send(itemRef(write.mondayItemId), () => rowWrite(write.mondayItemId, (sent) => plaky.createItem(space, board, body, undefined, sent)), (item) => itemCommit(item.id), true)).id;
    } catch (error) {
      if (isOutcomeUnknown(error)) {
        unknownOutcome(`rollback for item '${write.title}': outcome unknown (${textOf(error)})`);
        return null;
      }
      fail(
        `item '${write.title}' is not in Plaky now: its rebuild failed (${why}) and so did the rollback (${textOf(error)}); the next run creates it again, without its Plaky comments and files`,
      );
      if (isRateLimited(error)) throw error;
      return null;
    }
    if (write.existingSubscriberIds.length > 0) {
      try {
        await send(itemRef(write.mondayItemId), () => plaky.overrideSubscriptions(space, board, restoredId, { userIds: [...write.existingSubscriberIds] }), () => itemCommit(restoredId), true);
      } catch (error) {
        if (isRateLimited(error)) throw error;
        if (isOutcomeUnknown(error)) {
          unknownOutcome(`rollback for item '${write.title}': the old row is back; replacing its subscribers had an unknown outcome (${textOf(error)})`);
        } else {
          fail(`rollback for item '${write.title}': the old row is back, but not its subscribers (${textOf(error)})`);
        }
      }
    }
    return restoredId;
  };

  const rowCarrying = async (mondayItemId: string): Promise<number | null> => {
    if (!plan.mondayIdKey) throw new SyncSetupError("no Monday ID field to find the item by");
    const index = existingByMondayId(spareCopies(await readPlakyRows(plaky, config), plan.mondayIdKey).rows, config, plakyField({ key: plan.mondayIdKey, name: "Monday ID", type: "STRING" }));
    return index.get(mondayItemId)?.itemId ?? null;
  };

  const addedTo = async (itemId: number): Promise<string[]> => {
    const comments = await plaky.listItemComments(space, board, itemId);
    const files = await plaky.listItemFiles(space, board, itemId);
    const subitems = await plaky.listItems(space, board, { parentId: itemId, subitemsBehaviour: "INCLUDE", pageSize: 1 });
    return [...(comments.length ? ["comments"] : []), ...(files.length ? ["files"] : []), ...(subitems.data.length ? ["subitems"] : [])];
  };
  for (const spare of plan.copies) {
    if (!(await proceed())) return result;
    current = spare.mondayItemId;
    const label = `item '${spare.title}' (monday ${spare.mondayItemId})`;
    try {
      const added = await addedTo(spare.copy);
      if (added.length) {
        fail(`${label}: Plaky rows #${spare.keep} and #${spare.copy} both carry its Monday ID, and #${spare.copy} now holds ${added.join(" and ")}, so neither is deleted. Move what you need from #${spare.copy} to #${spare.keep}, delete #${spare.copy} in Plaky, then Move again.`);
        continue;
      }
      await send(null, () => plaky.deleteItem(space, board, spare.copy));
      note(`${label}: deleted Plaky row #${spare.copy}, a second copy of #${spare.keep} that held nothing of its own`);
      emit("info", "item.copy_deleted", "second copy deleted", { mondayItemId: spare.mondayItemId, plakyItemId: spare.copy });
    } catch (error) {
      if (isRateLimited(error)) {
        stopRateLimited(label);
        return result;
      }
      if (isOutcomeUnknown(error)) unknownOutcome(`${label}: deleting its second copy #${spare.copy} dispatched, outcome unknown (${textOf(error)})`);
      else fail(`${label}: its second copy #${spare.copy} was not deleted (${textOf(error)})`);
    }
  }
  current = null;

  const stacks = new CreationStacks();
  for (const write of inMondayOrder(plan.writes, plan.placement?.order).reverse()) {
    const label = `item '${write.title}' (monday ${write.mondayItemId})`;
    current = write.mondayItemId;
    const stack = config.nested ? write.parentMondayItemId : write.groupTitle;
    const isCreate = !write.existingItemId;
    if (isCreate && stacks.skip(stack)) continue;
    const existing = write.existingItemId;
    const rebuild = !!existing && write.drifted && options.recreateDrifted === true;
    if ((isCreate || rebuild) && config.nested && !write.parentMondayItemId) {
      fail(`${label}: no parent in monday, so it cannot be nested; not carried`);
      continue;
    }
    if ((isCreate || rebuild) && config.nested && write.parentMondayItemId && parentRowOf(write) === null) {
      fail(`${label}: its parent (monday ${write.parentMondayItemId}) is not in Plaky yet, so it waits for the next run`);
      continue;
    }
    if ((rebuild || !write.unchanged) && !(await proceed())) return result;
    try {
      if (existing && rebuild) {
        const recovery = new RebuildRecovery();
        if (write.groupTitle && !plan.groupIds.has(spellingKey(write.groupTitle))) throw new SyncSetupError(`item group '${write.groupTitle}' could not be created`);
        recovery.deleting();
        try {
          await send(itemRef(write.mondayItemId), () => rowWrite(write.mondayItemId, (sent) => plaky.deleteItem(space, board, existing, { beforeSend: sent })));
        } catch (error) {
          if (!(isOutcomeUnknown(error))) throw error;
          recovery.deleteUnknown();
          unknownOutcome(`${label}: delete outcome unknown (${textOf(error)})`);
          let gone: boolean;
          try {
            gone = (await rowCarrying(write.mondayItemId)) === null;
          } catch {
            recovery.observeDelete({ state: "unread" });
            targets.unsettle(write.mondayItemId);
            continue;
          }
          recovery.observeDelete({ state: "observed", id: gone ? null : existing });
          const restored = recovery.state.state === "rollback_pending" ? await restoreDeleted(write, textOf(error)) : null;
          if (recovery.state.state === "rollback_pending") recovery.restored(restored);
          if (restored === null) targets.unsettle(write.mondayItemId);
          else remember(write.mondayItemId, restored);
          continue;
        }
        recovery.deleted();
        targets.unsettle(write.mondayItemId);
        recovery.replacing();
        try {
          recovery.replaced(await create(write, true));
          result.recreated++;
        } catch (error) {
          recovery.replacementFailed(isRateLimited(error) ? "rate_limited" : isOutcomeUnknown(error) ? "unknown" : "refused");
          if (isRateLimited(error)) {
            recovery.restored(await restoreDeleted(write, textOf(error)));
            throw error;
          }
          let replacement: number | null;
          try {
            replacement = await rowCarrying(write.mondayItemId);
          } catch (unread) {
            recovery.observeReplacement({ state: "unread" });
            unknownOutcome(`${label}: replacement outcome unknown (${textOf(error)}) and the board could not be re-read (${textOf(unread)}); the next run settles it`);
            continue;
          }
          recovery.observeReplacement({ state: "observed", id: replacement });
          if (recovery.state.state === "settled") {
            const replacement = recovery.state.id;
            await answered(write.mondayItemId);
            remember(write.mondayItemId, replacement);
            const replacementId = replacement;
            await cache(() => store.markCommitted(itemRef(write.mondayItemId), itemCommit(replacementId)));
            emit("info", "item.created", "item created (a rebuild's replacement, found again after its answer was lost)", { mondayItemId: write.mondayItemId, plakyItemId: replacementId });
            result.recreated++;
            continue;
          }
          const why = textOf(error);
          if (recovery.state.state === "deferred") {
            unknownOutcome(`${label}: replacement outcome unknown (${why}) and no row carries its Monday ID yet; the old row is not put back, the next run settles it`);
            continue;
          }
          const restored = await restoreDeleted(write, why);
          recovery.restored(restored);
          if (restored !== null) {
            remember(write.mondayItemId, restored);
            fail(`${label}: replacement failed (${why}); the old row is back`);
          }
        }
      } else if (write.unchanged) {
        result.unchanged++;
      } else if (existing) {
        if (!write.sameFields) {
          await withFallback(write, write.fields, (fields) => send(itemRef(write.mondayItemId), () => plaky.updateItemFields(space, board, existing, { ...fields }), () => itemCommit(existing)));
          result.fieldUpdates++;
        }
        if (replacesSubscribers(config, write)) {
          await send(itemRef(write.mondayItemId), () => plaky.overrideSubscriptions(space, board, existing, { userIds: [...write.subscriberIds] }), () => itemCommit(existing));
          result.subscribersReplaced++;
        }
        result.updated++;
        emit("info", "item.updated", "item updated", { mondayItemId: write.mondayItemId, plakyItemId: existing });
      } else {
        await create(write);
        result.created++;
      }
    } catch (error) {
      if (isRateLimited(error)) {
        stopRateLimited(label);
        return result;
      }
      if (isOutcomeUnknown(error)) {
        unknownOutcome(`${label}: dispatched, outcome unknown (${textOf(error)})`);
        if (isCreate) stacks.hold(stack);
      } else {
        fail(`${label}: ${textOf(error)}`);
      }
    }
  }

  current = null;
  for (const [groupTitle, heldBack] of stacks.held()) {
    if (!heldBack) continue;
    const where = groupTitle ? (config.nested ? `under monday item ${groupTitle}` : `in group '${groupTitle}'`) : "on the board";
    fail(`${heldBack} new item(s) ${where} held back after an unknown outcome, so the next run still lands them in monday order. Re-run to continue.`);
  }

  const placeItems = async (placement: Placement, idKey: string, landed: ReadonlySet<number>): Promise<boolean> => {
    let rows: PlacedRow[];
    try {
      const carriers = spareCopies(await readPlakyRows(plaky, config), idKey).rows;
      rows = placedRows(carriers, existingByMondayId(carriers, config, plakyField({ key: idKey, name: "Monday ID", type: "STRING" })));
    } catch (error) {
      if (isRateLimited(error)) {
        stopRateLimited("item order");
        return false;
      }
      note(`item order not checked: the board could not be read again (${textOf(error)}); the next Move checks it`);
      return true;
    }
    const groups = placement.scope === "landed" ? new Set(rows.flatMap((row) => (landed.has(row.itemId) && row.groupId !== null ? [row.groupId] : []))) : null;
    const groupTitles = new Map(plan.writes.flatMap((write) => (write.groupTitle ? [[write.mondayItemId, write.groupTitle] as const] : [])));
    const halted = new Set<number>();
    for (const move of itemMoves(placement.order, rows, groups, groupTargets(plan.writes, plan.groupIds))) {
      if (halted.has(move.groupId)) continue;
      if (!(await proceed())) return false;
      current = move.mondayItemId;
      const regroup = move.fromGroupId !== move.groupId;
      const target = `group '${groupTitles.get(move.mondayItemId) ?? move.groupId}'`;
      const label = `item ${regroup ? "group" : "order"}: monday ${move.mondayItemId} (Plaky row #${move.itemId})`;
      try {
        await send(null, () => plaky.moveItem(space, board, move.itemId, move.groupId));
        result.moved++;
        if (regroup) emit("info", "item.regrouped", `item moved to its monday ${target}, near its end`, { mondayItemId: move.mondayItemId, plakyItemId: move.itemId, plakyGroupId: move.groupId });
        else emit("info", "item.placed", "item put last in its group, its monday place", { mondayItemId: move.mondayItemId, plakyItemId: move.itemId });
      } catch (error) {
        halted.add(move.groupId);
        if (isRateLimited(error)) {
          stopRateLimited(label);
          return false;
        }
        if (regroup && isOutcomeUnknown(error)) unknownOutcome(`${label}: the move to ${target} dispatched, outcome unknown (${textOf(error)}); the next run checks its group again`);
        else if (regroup) note(`${label}: Plaky refused the move to ${target} (${textOf(error)}), so the row stays in its old group until the next full Move`);
        else if (isOutcomeUnknown(error)) unknownOutcome(`${label}: the move to the end of its group dispatched, outcome unknown (${textOf(error)}); the next run checks the order again`);
        else note(`${label}: Plaky refused the move to the end of its group (${textOf(error)}), so the group is not in monday's order; the next full Move tries again`);
      }
    }
    current = null;
    return true;
  };
  if (plan.placement && plan.mondayIdKey) {
    const rebuilt = new Set(options.recreateDrifted ? plan.writes.filter((write) => write.drifted && write.existingItemId).map((write) => write.mondayItemId) : []);
    const ungrouped = plan.writes.some((write) => !write.groupTitle && result.plakyItemIds[write.mondayItemId] !== undefined);
    if ((ungrouped || plannedMoves(plan, rebuilt) > 0) && !(await placeItems(plan.placement, plan.mondayIdKey, new Set(Object.values(result.plakyItemIds))))) return result;
  }

  const rowFor = (mondayId: string, planned: number | null): number | null => targets.rowFor(mondayId, planned);

  const syncItemComments = async (mondayItemId: string, itemId: number, planned: readonly PlannedComment[], count: number): Promise<boolean> => {
    const found = new Map<string, [id: number, header: string]>();
    let total = 0;
    if (count > 0) {
      try {
        for (const top of await plaky.listItemComments(space, board, itemId)) {
          const orphaned = isDeletedComment(top);
          for (const entry of [top, ...(top.replies ?? [])]) {
            if (entry.id === null || entry.deleted) continue;
            total++;
            if (orphaned) continue;
            const content = String(entry.content ?? "");
            const marker = markerOf(content);
            if (marker !== null && !found.has(markerKey(marker))) found.set(markerKey(marker), [entry.id, headerOf(content)]);
          }
        }
      } catch (error) {
        if (isRateLimited(error)) {
          stopRateLimited(`comments on Plaky item ${itemId}`);
          return false;
        }
        fail(`could not read the comments already on Plaky item ${itemId} (${textOf(error)}); the next run carries them`);
        return true;
      }
    }
    const waiting = new Set<string>();
    let overCap = 0;
    for (const comment of planned) {
      const label = `comment for monday ${comment.kind} ${comment.mondayId}`;
      if (comment.replyTo !== null && waiting.has(comment.replyTo)) {
        waiting.add(comment.mondayId);
        continue;
      }
      const header = commentHeader(comment);
      const known = found.get(comment.mondayId);
      if (known !== undefined && known[1] === header) continue;
      if (known === undefined && total >= commentCap) {
        overCap++;
        continue;
      }
      let repliesToId: number | undefined;
      if (known === undefined && comment.kind === "reply") {
        const parent = found.get(comment.replyTo ?? "");
        if (parent === undefined) {
          waiting.add(comment.mondayId);
          continue;
        }
        repliesToId = parent[0];
      }
      if (!(await proceed())) return false;
      const ref: EntityRef = { type: "comment", mondayId: comment.mondayId, scope: mondayItemId, occurrence: 0 };
      try {
        if (known !== undefined) {
          await send(ref, () => plaky.updateItemComment(space, board, itemId, known[0], comment.text), () => ({ plakyId: known[0], plakyParentId: itemId, matchKey: header }));
          result.commentsUpdated++;
        } else {
          const created = await send(
            ref,
            () => plaky.createItemComment(space, board, itemId, { text: comment.text, ...(repliesToId === undefined ? {} : { repliesToId }) }),
            (c) => ({ plakyId: c.id, plakyParentId: itemId, matchKey: header }),
          );
          total++;
          result.commentsCreated++;
          found.set(comment.mondayId, [created.id, header]);
        }
        emit("info", known === undefined ? "comment.created" : "comment.updated", label, { mondayItemId, plakyItemId: itemId });
      } catch (error) {
        if (isRateLimited(error)) {
          stopRateLimited(label);
          return false;
        }
        if (isOutcomeUnknown(error)) unknownOutcome(`${label}: dispatched, outcome unknown (${textOf(error)})`);
        else fail(`${label}: ${textOf(error)}`);
        waiting.add(comment.mondayId);
      }
    }
    if (overCap) failForGood(`Plaky item ${itemId}: ${overCap} comment(s) not carried; Plaky allows ${commentCap} per item`);
    return true;
  };

  const asLeft = (mondayId: string, entry: { settled?: boolean | undefined }, count: number, planned: number): boolean => entry.settled === true && !targets.created(mondayId) && count === planned;
  for (const [mondayId, wanted] of plan.comments) {
    const itemId = rowFor(mondayId, wanted.plakyItemId);
    if (itemId === null) continue;
    const count = targets.created(mondayId) ? 0 : wanted.commentCount;
    if (asLeft(mondayId, wanted, count, wanted.planned.filter((c) => c.kind !== "reply").length)) continue;
    current = mondayId;
    if (!(await syncItemComments(mondayId, itemId, wanted.planned, count))) return result;
  }
  current = null;

  const syncItemFiles = async (source: AssetSource, mondayItemId: string, itemId: number, assets: readonly MondayFile[], count: number): Promise<FilesOutcome> => {
    const present: HeldFile[] = [];
    if (count > 0) {
      try {
        for (const entry of await plaky.listItemFiles(space, board, itemId)) present.push(heldFile(entry));
      } catch (error) {
        if (isRateLimited(error)) {
          stopRateLimited(`files on Plaky item ${itemId}`);
          return "rate_limited";
        }
        fail(`could not read the files already on Plaky item ${itemId} (${textOf(error)}); the next run carries them`);
        return "ok";
      }
    }
    let mapped: FileMapping[] = [];
    if (store.filesMapped) {
      try {
        mapped = await store.filesMapped(mondayItemId);
      } catch (error) {
        note(`file map not read for monday item ${mondayItemId} (${textOf(error)}); its files are matched by name and size`);
      }
    }
    const remember = async (mapping: FileMapping): Promise<void> => {
      try {
        await store.mapFile?.(mondayItemId, mapping);
      } catch (error) {
        note(`file map not updated (${textOf(error)})`);
      }
    };
    const copies = new Map<string, number>();
    const todo: { wanted: MondayFile; assetId: string; occurrence: number; meta: [string, number | null] | { error: unknown } }[] = [];
    for (const wanted of assets) {
      const assetId = wanted.assetId ?? "";
      const occurrence = copies.get(assetId) ?? 0;
      copies.set(assetId, occurrence + 1);
      todo.push({ wanted, assetId, occurrence, meta: await source.meta(assetId).catch((error: unknown) => ({ error })) });
    }
    const { places, lookAlikes } = matchFiles(itemId, present, todo.map((t) => ({ assetId: t.assetId, occurrence: t.occurrence, meta: Array.isArray(t.meta) ? t.meta : null })), mapped);
    for (const c of lookAlikes) {
      note(`Plaky item ${itemId}: ${c.wanted} monday files match '${c.name}' by name and size but only ${c.held} Plaky file(s) do, so none is taken for one and each is uploaded; remove a duplicate by hand if there is one`);
    }
    for (const [i, { wanted, assetId, occurrence, meta }] of todo.entries()) {
      const label = `file '${wanted.name}' on Plaky item ${itemId}`;
      const ref: EntityRef = { type: "file", mondayId: assetId, scope: mondayItemId, occurrence };
      const place = places[i]!;
      try {
        if (!Array.isArray(meta)) throw meta.error;
        if (place.state === "carried") continue;
        if (place.state === "adopt") {
          await remember({ assetId, occurrence, plakyItemId: itemId, plakyFileId: place.fileId });
          continue;
        }
        const key = fileKey(meta[0], meta[1]);
        if (!(await proceed())) return "stopped";
        const before = store.refusedBefore ? await store.refusedBefore(ref) : null;
        if (before !== null) {
          failForGood(`${label}: Plaky refused it on an earlier run (${before}); keep a copy outside Plaky (Plaky's plan sets the largest file it takes)`);
          continue;
        }
        const [name, data] = await source.fetch(assetId);
        const file = await send(ref, () => plaky.uploadItemFile(space, board, itemId, { name, data, type: contentType(name) }), (f) => ({ plakyId: f.id, plakyParentId: itemId, matchKey: key }));
        result.filesUploaded++;
        await remember({ assetId, occurrence, plakyItemId: itemId, plakyFileId: file.id });
        emit("info", "file.uploaded", label, { mondayItemId, plakyItemId: itemId });
      } catch (error) {
        if (error instanceof FileTooLarge) failForGood(`${label}: ${textOf(error)}; keep a copy outside Plaky (Plaky's plan sets the largest file it takes)`);
        else if (isPlakyHttp(error) && (PERMANENT_UPLOAD.has(error.status) || isFeatureLimit(error))) {
          failForGood(`${label}: ${textOf(error)}; keep a copy outside Plaky (Plaky's plan sets the largest file it takes)`);
          await cache(() => store.markFailed(ref, `${REFUSED_FOR_GOOD}${textOf(error)}`));
        } else if (isMondayDailyLimit(error)) {
          failBoard(`files: ${textOf(error)}`);
          return "monday_limit";
        } else if (isRateLimited(error)) {
          stopRateLimited(label);
          return "rate_limited";
        } else if (isOutcomeUnknown(error)) unknownOutcome(`${label}: dispatched, outcome unknown (${textOf(error)})`);
        else fail(`${label}: ${textOf(error)}`);
      }
    }
    return "ok";
  };

  if (plan.files.size > 0 && fetcher === undefined) {
    fail("files: no downloader was given to applyPlan; none were copied");
  } else if (fetcher !== undefined) {
    fetcher.prefetch([...plan.files.values()].flatMap((held) => held.assets.flatMap((asset) => (asset.assetId === null ? [] : [asset.assetId]))));
    for (const [mondayId, held] of plan.files) {
      const itemId = rowFor(mondayId, held.plakyItemId);
      if (itemId === null) continue;
      const count = targets.created(mondayId) ? 0 : held.fileCount;
      current = mondayId;
      const outcome = await syncItemFiles(fetcher, mondayId, itemId, held.assets, count);
      if (outcome === "rate_limited" || outcome === "stopped") return result;
      if (outcome === "monday_limit") break;
    }
    current = null;
  }

  if (options.prune) {
    const idKey = plan.mondayIdKey;
    const carriesMondayId = (row: PlakyItem): boolean => {
      const value = idKey === null ? undefined : (row.fields ?? []).find((f) => f.key === idKey)?.value;
      return typeof value === "string" && pyStrip(value) !== "";
    };
    const ourFiles = async (plakyItemId: number): Promise<ReadonlySet<number>> => (store.fileIdsOn ? store.fileIdsOn(plakyItemId) : new Set<number>());
    for (const [itemId, title] of plan.orphans) {
      if (!(await proceed())) return result;
      try {
        const check = await checkBeforeDelete(plaky, { space, board }, itemId, { ourFiles, ourNested: carriesMondayId });
        if (check.why.length) {
          note(`orphan '${title}' (${itemId}) kept: ${check.why.join("; ")}; delete it by hand if it should go`);
          continue;
        }
        await send(null, () => plaky.deleteItem(space, board, itemId, { subitemsBehaviour: check.subitemsBehaviour }));
        result.pruned++;
        emit("info", "item.pruned", "orphan deleted", { plakyItemId: itemId });
      } catch (error) {
        if (isRateLimited(error)) {
          stopRateLimited(`orphan '${title}' (${itemId})`);
          return result;
        }
        if (isOutcomeUnknown(error)) unknownOutcome(`orphan '${title}' (${itemId}): delete dispatched, outcome unknown (${textOf(error)})`);
        else fail(`orphan '${title}' (${itemId}): ${textOf(error)}`);
      }
    }
  }
  return result;
}
