type ArchiveReadiness = "loading" | "read_error" | "unread" | "operating" | "running" | "waiting" | "scheduled" | "ready";
export function archiveReadiness(facts: {
  boards: number; active: boolean; waiting: boolean; scheduled: boolean;
  loading?: boolean; error?: boolean; operating?: boolean;
}): ArchiveReadiness {
  if (facts.loading) return "loading";
  if (facts.error) return "read_error";
  if (!facts.boards) return "unread";
  if (facts.operating) return "operating";
  if (facts.active) return "running";
  if (facts.waiting) return "waiting";
  if (facts.scheduled) return "scheduled";
  return "ready";
}

class ArchiveCancelled extends Error {
  override readonly name = "ArchiveCancelled";
  constructor() { super("Archive cancelled."); }
}
export const isArchiveCancelled = (error: unknown): boolean => error instanceof Error && error.name === "ArchiveCancelled";

type ArchiveRequestState = { state: "idle" } | { state: "building" | "cancelling"; controller: AbortController };

export class ArchiveRequest {
  private current: ArchiveRequestState = { state: "idle" };
  constructor(readonly migrationId: number) {}
  get state(): ArchiveRequestState["state"] { return this.current.state; }

  async run<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.current.state !== "idle") throw new Error("An archive is already being created.");
    const controller = new AbortController();
    this.current = { state: "building", controller };
    try {
      const result = await work(controller.signal);
      if (controller.signal.aborted) throw new ArchiveCancelled();
      return result;
    } catch (error) {
      throw controller.signal.aborted ? new ArchiveCancelled() : error;
    } finally { this.current = { state: "idle" }; }
  }

  cancel(): void {
    if (this.current.state !== "building") return;
    const { controller } = this.current;
    this.current = { state: "cancelling", controller };
    controller.abort();
  }
}
