type SetupActivity = "idle" | "scanning" | "linking";
export type ScanCause = "open" | "manual" | "timer" | "focus";
export const AWAKE_MS = 5 * 60_000;
const FOCUS_SCAN_GAP_MS = 5_000;

export class SetupWatch {
  private current: SetupActivity = "idle";
  private cadence: "fast" | "slow" = "fast";
  private demand: "none" | "queued" = "none";
  get activity(): SetupActivity { return this.current; }
  get pace(): "fast" | "slow" { return this.cadence; }
  get pendingScan(): boolean { return this.demand === "queued"; }
  private opened = false;
  private awakeUntil = 0;
  private lastScanAt = 0;
  private timedScans = 0;
  private revision = 0;
  private linkedRevision = -1;
  private fresh = false;
  private keptAsTag = false;
  get tagsKept(): boolean { return this.keptAsTag; }
  keepTags(): void { this.keptAsTag = true; }

  wake(now: number): void { this.awakeUntil = now + AWAKE_MS; }

  scan(cause: ScanCause, now: number, hidden = false): boolean {
    if (this.current !== "idle") {
      if (cause === "manual") this.demand = "queued";
      return false;
    }
    if (cause === "open" && this.opened) return false;
    if (cause === "timer" && hidden && now >= this.awakeUntil) return false;
    if (cause === "focus" && (hidden || now - this.lastScanAt < FOCUS_SCAN_GAP_MS)) return false;
    this.opened = true;
    this.current = "scanning";
    this.demand = "none";
    this.fresh = false;
    this.lastScanAt = now;
    if (cause === "timer" && ++this.timedScans >= 20) this.cadence = "slow";
    return true;
  }

  scanned(success: boolean): void {
    if (this.activity !== "scanning") return;
    this.current = "idle";
    this.fresh = success;
    if (success) this.revision++;
  }

  link(automatic: boolean): boolean {
    if (this.activity !== "idle") return false;
    if (automatic && (this.pendingScan || !this.fresh || this.linkedRevision === this.revision)) return false;
    this.linkedRevision = this.revision;
    this.current = "linking";
    return true;
  }

  linked(): void { if (this.current === "linking") this.current = "idle"; }
}

type SetupReadiness = "unread" | "missing" | "blocked" | "confirm" | "tags" | "ready";
export function setupReadiness(preview: {
  missing: readonly unknown[]; links: readonly { ready: boolean }[]; blocking: readonly unknown[]; needsConfirm: boolean;
} | undefined, keepTags: boolean, tags: number): SetupReadiness {
  if (!preview) return "unread";
  if (preview.missing.length || !preview.links.length) return "missing";
  if (preview.blocking.length || preview.links.some((link) => !link.ready)) return "blocked";
  if (preview.needsConfirm) return "confirm";
  if (!keepTags && tags) return "tags";
  return "ready";
}
