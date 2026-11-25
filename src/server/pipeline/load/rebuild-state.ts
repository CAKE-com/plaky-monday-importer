export type RowObservation = { state: "unread" } | { state: "observed"; id: number | null };
type RebuildState = { state: "original" | "delete_pending" | "delete_unknown" | "deleted" | "replacement_pending" | "rollback_pending" | "deferred" }
  | { state: "replacement_unknown"; failure: "unknown" | "refused" }
  | { state: "settled"; kind: "replacement" | "rollback"; id: number };

export class RebuildRecovery {
  private current: RebuildState = { state: "original" };
  get state(): RebuildState { return this.current; }
  private require(state: RebuildState["state"]): void {
    if (this.current.state !== state) throw new Error(`Cannot rebuild from ${this.current.state}; expected ${state}`);
  }
  deleting(): void { this.require("original"); this.current = { state: "delete_pending" }; }
  deleted(): void { this.require("delete_pending"); this.current = { state: "deleted" }; }
  deleteUnknown(): void { this.require("delete_pending"); this.current = { state: "delete_unknown" }; }
  observeDelete(row: RowObservation): void {
    this.require("delete_unknown");
    this.current = { state: row.state === "observed" && row.id === null ? "rollback_pending" : "deferred" };
  }
  replacing(): void { this.require("deleted"); this.current = { state: "replacement_pending" }; }
  replaced(id: number): void {
    this.require("replacement_pending");
    this.current = { state: "settled", kind: "replacement", id };
  }
  replacementFailed(failure: "unknown" | "refused" | "rate_limited"): void {
    this.require("replacement_pending");
    this.current = failure === "rate_limited" ? { state: "rollback_pending" } : { state: "replacement_unknown", failure };
  }
  observeReplacement(row: RowObservation): void {
    if (this.current.state !== "replacement_unknown") throw new Error(`Cannot observe a replacement from ${this.current.state}`);
    this.current = row.state === "unread" ? { state: "deferred" }
      : row.id !== null ? { state: "settled", kind: "replacement", id: row.id }
        : { state: this.current.failure === "refused" ? "rollback_pending" : "deferred" };
  }
  restored(id: number | null): void {
    this.require("rollback_pending");
    this.current = id === null ? { state: "deferred" } : { state: "settled", kind: "rollback", id };
  }
}
