type MoveSnapshot<R, W> = { active: boolean; waiting: W | null; run: R | null };
type MoveState<R, W> =
  | { state: "locked" | "loading" | "ready" }
  | { state: "moving" }
  | { state: "paused"; waiting: W }
  | { state: "result"; run: R };

export function moveState<R, W>(linked: boolean, snapshot: MoveSnapshot<R, W> | undefined): MoveState<R, W> {
  if (!linked) return { state: "locked" };
  if (!snapshot) return { state: "loading" };
  if (snapshot.active) return { state: "moving" };
  if (snapshot.waiting) return { state: "paused", waiting: snapshot.waiting };
  if (snapshot.run) return { state: "result", run: snapshot.run };
  return { state: "ready" };
}

export function statusRefetchMs(status: { active: boolean; waiting: unknown; schedule?: unknown } | undefined): number | false {
  return status?.active ? 1000 : status?.waiting || status?.schedule ? 30_000 : false;
}
