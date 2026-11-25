import type { migrationRuns } from "@/db/schema";

export type RunStatus = (typeof migrationRuns.$inferSelect)["status"];
export type RunOutcome = Exclude<RunStatus, "running">;

export const RUN_REACHED_FROM: Readonly<Record<RunStatus, readonly RunStatus[]>> = {
  running: [], succeeded: ["running"], failed: ["running"], interrupted: ["running"],
  rate_limited: ["running"], plaky_rate_limited: ["running"],
};

export function appliedOutcome(input: {
  applied: boolean; aborted: boolean; mondayLimited: boolean; planFailures: number; counts: Readonly<Record<string, number>>;
}): RunOutcome {
  const { applied, aborted, mondayLimited, planFailures, counts } = input;
  let outcome: RunOutcome = "succeeded";
  if (!applied) outcome = aborted ? "interrupted" : "failed";
  else if (counts.rateLimited) outcome = "plaky_rate_limited";
  else if (counts.stopped || counts.notStarted || aborted) outcome = "interrupted";
  else if (counts.failures || counts.ambiguous || planFailures) outcome = "failed";
  return mondayLimited && outcome !== "interrupted" ? "rate_limited" : outcome;
}

type VerificationEvent = "stopped" | "monday_limited" | "matched" | "short";
export function verifiedOutcome(outcome: RunOutcome, event: VerificationEvent): RunOutcome {
  switch (event) {
    case "stopped": return "interrupted";
    case "monday_limited": return "rate_limited";
    case "short": return outcome === "succeeded" ? "failed" : outcome;
    case "matched": return outcome;
  }
}

type ExecutionState = { state: "applying" }
  | { state: "applied"; counts: Record<string, number> }
  | { state: "draining"; counts: Record<string, number>; done: Promise<void> }
  | { state: "released"; counts: Record<string, number> | null };

export class RunExecution {
  private current: ExecutionState = { state: "applying" };
  get state(): ExecutionState["state"] { return this.current.state; }
  get counts(): Record<string, number> | null { return this.current.state === "applying" ? null : this.current.counts; }
  get hasApplied(): boolean { return this.current.state !== "applying" && this.counts !== null; }

  applied(counts: Record<string, number>): void {
    if (this.current.state !== "applying") throw new Error("Apply has already settled");
    this.current = { state: "applied", counts };
  }
  drain(reads: Promise<unknown>): void {
    if (this.current.state !== "applied") throw new Error("Only an applied run can drain verification");
    this.current = { state: "draining", counts: this.current.counts, done: reads.then(() => undefined, () => undefined) };
  }
  async release(): Promise<void> {
    if (this.current.state === "draining") await this.current.done;
    this.current = { state: "released", counts: this.counts };
  }
}
