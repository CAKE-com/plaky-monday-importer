import { isMondayDailyLimit } from "../clients/monday";

type ArchiveReadState = { state: "reading" | "reading_with_gaps" | "rate_limited" } | { state: "storage_failed"; error: unknown };

export class ArchiveReads {
  private current: ArchiveReadState = { state: "reading" };
  get state(): ArchiveReadState["state"] { return this.current.state; }
  get limited(): boolean { return this.current.state === "rate_limited"; }
  get outcome(): "review_required" | "incomplete" { return this.current.state === "reading" ? "review_required" : "incomplete"; }

  storageFailed(error: unknown): never {
    this.current = { state: "storage_failed", error };
    throw error;
  }
  failedRead(error: unknown, signal: AbortSignal): "limit" | "failed" {
    if (this.current.state === "storage_failed") throw this.current.error;
    signal.throwIfAborted();
    this.current = { state: this.limited || isMondayDailyLimit(error) ? "rate_limited" : "reading_with_gaps" };
    return this.limited ? "limit" : "failed";
  }
}
