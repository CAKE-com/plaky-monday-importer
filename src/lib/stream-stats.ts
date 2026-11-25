export type StreamEvent = { id: number; runId: number; prev: number | null };
export type Stream<E extends StreamEvent = StreamEvent> = { events: E[]; received: number; duplicates: number };

export function streamStats(s: { events: readonly StreamEvent[] }): { first: number | null; last: number | null; gaps: number } {
  const lastByRun = new Map<number, number>();
  let gaps = 0;
  for (const e of s.events) {
    if ((lastByRun.get(e.runId) ?? null) !== e.prev) gaps++;
    lastByRun.set(e.runId, e.id);
  }
  return { first: s.events[0]?.id ?? null, last: s.events.at(-1)?.id ?? null, gaps };
}

export class EventBuffer<E extends { id: number }> {
  private readonly seen = new Set<number>();
  private pending: E[] = [];
  received = 0;
  duplicates = 0;

  push(event: E): void {
    this.received++;
    if (this.seen.has(event.id)) this.duplicates++;
    else {
      this.seen.add(event.id);
      this.pending.push(event);
    }
  }

  drain(): E[] {
    const batch = this.pending;
    this.pending = [];
    return batch;
  }
}
