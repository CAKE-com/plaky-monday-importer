type ItemTarget = { state: "missing" | "unsettled" } | { state: "existing" | "created"; id: number };

export class ItemTargets {
  private readonly targets = new Map<string, ItemTarget>();

  state(mondayId: string, planned: number | null): ItemTarget {
    return this.targets.get(mondayId) ?? (planned === null ? { state: "missing" } : { state: "existing", id: planned });
  }

  remember(mondayId: string, id: number): void { this.targets.set(mondayId, { state: "created", id }); }

  unsettle(mondayId: string): void {
    if (!this.created(mondayId)) this.targets.set(mondayId, { state: "unsettled" });
  }

  created(mondayId: string): boolean { return this.targets.get(mondayId)?.state === "created"; }

  rowFor(mondayId: string, planned: number | null): number | null {
    const target = this.state(mondayId, planned);
    return "id" in target ? target.id : null;
  }
}

export class CreationStacks {
  private readonly stopped = new Map<string | null, number>();

  state(stack: string | null): "open" | "held" { return this.stopped.has(stack) ? "held" : "open"; }

  hold(stack: string | null): void {
    if (this.state(stack) === "open") this.stopped.set(stack, 0);
  }

  skip(stack: string | null): boolean {
    if (this.state(stack) === "open") return false;
    this.stopped.set(stack, this.stopped.get(stack)! + 1);
    return true;
  }

  held(): IterableIterator<[string | null, number]> { return this.stopped.entries(); }
}
