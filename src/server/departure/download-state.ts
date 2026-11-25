type Reader = { destroy(): unknown };
type ClaimState<R> = { state: "reserved" } | { state: "streaming"; reader: R };

export class DownloadTicket<R extends Reader> {
  private phase: "available" | "expired" | "revoked" = "available";
  private readonly claims = new Map<object, ClaimState<R>>();
  constructor(readonly expiresAt: number) {}
  get state(): "available" | "expired" | "revoked" { return this.phase; }
  get disposable(): boolean { return this.phase !== "available" && this.claims.size === 0; }

  expire(now: number): void {
    if (this.phase === "available" && now >= this.expiresAt) this.phase = "expired";
  }
  acquire(now: number): object | null {
    this.expire(now);
    if (this.phase !== "available") return null;
    const claim = Object.freeze({});
    this.claims.set(claim, { state: "reserved" });
    return claim;
  }
  attach(claim: object, reader: R): boolean {
    if (this.claims.get(claim)?.state !== "reserved" || this.phase === "revoked") {
      reader.destroy();
      return false;
    }
    this.claims.set(claim, { state: "streaming", reader });
    return true;
  }
  release(claim: object): void {
    this.claims.delete(claim);
  }
  revoke(): void {
    if (this.phase === "revoked") return;
    this.phase = "revoked";
    const readers = [...this.claims.values()].flatMap((claim) => claim.state === "streaming" ? [claim.reader] : []);
    this.claims.clear();
    for (const reader of readers) reader.destroy();
  }
}
