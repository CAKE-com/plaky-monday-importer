export type ResultOfferInput = {
  runStatus: string;
  since: string | null;
  receipt: "ok" | "short" | "none";
  current: boolean;
  changes: { full: string[]; unsynced?: string[] } | null;
  problems: number;
  undoneAfter: boolean;
  allGone: boolean;
};

type MoveLabel = "Move again" | "Send them again";
type ResultOffer = {
  move: MoveLabel | null;
  bring: boolean;
  refusedNote: string | null;
};

export function resultOffer(i: ResultOfferInput): ResultOffer {
  const inStep = i.changes !== null && (i.changes.unsynced ?? i.changes.full).length === 0;
  const checked = i.receipt === "ok" && i.current;
  const settled = i.problems === 0 && !i.undoneAfter && i.runStatus === "succeeded" && inStep && (checked || i.since !== null);
  const move: MoveLabel | null = settled ? null : i.problems > 0 && i.runStatus !== "rate_limited" && !i.undoneAfter ? "Send them again" : "Move again";
  return {
    move,
    bring: i.changes !== null && !i.allGone,
    refusedNote: i.changes === null ? `Needs a run that left a board fully in step: use ${move ?? "Move again"}.` : null,
  };
}
