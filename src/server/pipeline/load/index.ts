import { AssetFetcher, type AssetFetcherOptions, type AssetSource } from "../assets";
import { SyncSetupError, writeAction, type BoardPlan } from "../plan";

import { applyPlan } from "./apply";
import { newApplyResult, textOf, type ApplyDeps, type ApplyOptions, type ApplyResult } from "./results";
import { withBoardLocks } from "./store";

export * from "./store";
export * from "./results";
export * from "./apply";

function shouldMarkApplied(plan: BoardPlan): boolean {
  return plan.writes.some((write) => writeAction(write) !== "unchanged" || write.existingItemId !== null);
}

function nothingLanded(plan: BoardPlan, result: ApplyResult): boolean {
  const landed = result.created + result.updated + result.recreated + result.moved + result.pruned + result.groupsCreated + result.groupsReordered + result.groupsRenamed
    + result.commentsCreated + result.commentsUpdated + result.filesUploaded + result.subscribersReplaced;
  const carried = Array.isArray(plan.writes) && plan.writes.some((w) => w.existingItemId !== null);
  return landed === 0 && result.ambiguous.length === 0 && !result.seedGroupDeleted && !carried;
}

function parentsFirst(plans: readonly BoardPlan[]): BoardPlan[] {
  const byMondayId = new Map(plans.map((p) => [p.config.mondayBoardId, p]));
  const ordered: BoardPlan[] = [];
  const seen = new Set<BoardPlan>();
  const visit = (plan: BoardPlan): void => {
    if (seen.has(plan)) return;
    seen.add(plan);
    const parent = plan.config.subitemsOf ? byMondayId.get(plan.config.subitemsOf) : undefined;
    if (parent) visit(parent);
    ordered.push(plan);
  };
  for (const plan of plans) visit(plan);
  return ordered;
}

type ApplyPlansDeps = Omit<ApplyDeps, "fetcher"> & {
  files?: AssetFetcherOptions;
  fetcher?: AssetSource | undefined;
};
export type ApplyPlansResult = { results: { plan: BoardPlan; result: ApplyResult }[]; notStarted: string[] };

export async function applyPlans(plans: readonly BoardPlan[], deps: ApplyPlansDeps, options: ApplyOptions = {}): Promise<ApplyPlansResult> {
  const ordered = parentsFirst(plans);
  if (options.recreateDrifted) {
    const nestedParents = ordered.filter((p) => ordered.some((n) => n.config.nested && n.config.subitemsOf === p.config.mondayBoardId)).map((p) => p.config.name);
    if (nestedParents.length) {
      throw new SyncSetupError(`rebuilding drifted items is refused for ${nestedParents.map((n) => `'${n}'`).join(", ")}: its subitems are nested under its items and Plaky deletes them with the row. Undo the board instead, or leave the drift reported.`);
    }
  }
  const knownRows = new Map<string, Map<string, number>>();
  const fetcher = deps.fetcher ?? (deps.files ? new AssetFetcher(deps.files) : undefined);
  const boardDeps: ApplyDeps = { plaky: deps.plaky, store: deps.store, fetcher, ...(deps.log ? { log: deps.log } : {}), ...(deps.progress ? { progress: deps.progress } : {}) };
  return withBoardLocks(deps.store, ordered.map((p) => ({ space: p.config.plakySpaceId, board: p.config.plakyBoardId })), async () => {
    const results: ApplyPlansResult["results"] = [];
    const notStarted: string[] = [];
    for (const plan of ordered) {
      if (results.some((r) => r.result.rateLimited || r.result.stopped) || options.signal?.aborted) {
        notStarted.push(plan.config.name);
        continue;
      }
      let result: ApplyResult;
      const parentRows = plan.config.nested && plan.config.subitemsOf ? knownRows.get(plan.config.subitemsOf) : undefined;
      const parentIds = plan.config.nested ? (mondayItemId: string): number | null => parentRows?.get(mondayItemId) ?? null : undefined;
      try {
        const marked = shouldMarkApplied(plan);
        if (marked) await deps.store.markApplied(plan.config);
        result = await applyPlan(boardDeps, plan, { ...options, ...(parentIds ? { parentIds } : {}) });
        if (marked && nothingLanded(plan, result)) await deps.store.markUnapplied(plan.config);
      } catch (error) {
        result = newApplyResult();
        result.failures.push(`${plan.config.name}: ${textOf(error)}`);
        deps.log?.({ level: "error", code: "board.failed", message: `${plan.config.name}: ${textOf(error)}`, board: plan.config.name });
      }
      const rows = new Map<string, number>(plan.existingIds ?? []);
      for (const w of Array.isArray(plan.writes) ? plan.writes : []) if (w.existingItemId !== null) rows.set(w.mondayItemId, w.existingItemId);
      for (const [mondayItemId, plakyItemId] of Object.entries(result.plakyItemIds)) rows.set(mondayItemId, plakyItemId);
      knownRows.set(plan.config.mondayBoardId, rows);
      results.push({ plan, result });
    }
    return { results, notStarted };
  });
}
