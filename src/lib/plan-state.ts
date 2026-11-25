export const PLAN_MAX_AGE_MS = 10 * 60_000;
type PlanReuse<P> = { state: "absent" | "expired" | "changes_only" } | { state: "reusable"; plan: P };

export function planReuse<P extends { at: number }>(held: P | undefined, now: number, changesOnly = false): PlanReuse<P> {
  if (!held) return { state: "absent" };
  if (now - held.at > PLAN_MAX_AGE_MS) return { state: "expired" };
  if (changesOnly) return { state: "changes_only" };
  return { state: "reusable", plan: held };
}

type AutoPlanFacts = {
  loaded: boolean; fetching: boolean; hasSummary: boolean; overBudget: boolean;
  latestRun: { at: number; status: string } | null; now: number;
};
type AutoPlanState = "unread" | "reading" | "has_summary" | "over_budget" | "recent_run" | "ready" | "attempted";

export function shouldAutoPlan(latestRun: { at: number; status: string } | null, now: number, windowMs: number): boolean {
  return latestRun === null || now - latestRun.at >= windowMs;
}

export class AutomaticPlan {
  private attempt: "unattempted" | "attempted" = "unattempted";
  state(facts: AutoPlanFacts): AutoPlanState {
    if (this.attempt === "attempted") return "attempted";
    if (!facts.loaded) return "unread";
    if (facts.fetching) return "reading";
    if (facts.hasSummary) return "has_summary";
    if (facts.overBudget) return "over_budget";
    if (!shouldAutoPlan(facts.latestRun, facts.now, PLAN_MAX_AGE_MS)) return "recent_run";
    return "ready";
  }
  admit(facts: Omit<AutoPlanFacts, "now"> & { now?: number }): boolean {
    if (this.state({ ...facts, now: facts.now ?? Date.now() }) !== "ready") return false;
    this.attempt = "attempted";
    return true;
  }
}
