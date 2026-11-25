export type Schedule = { at: number; everyHours: number | null };
export const RESUME_RETRY_MS = 60_000;
type TimerDecision = { state: "absent" } | { state: "waiting" | "deferred"; at: number } | { state: "due" };

export function timerState(intent: { at: number } | null, now: number, busy: boolean, resumeAt: number | null = null): TimerDecision {
  if (!intent) return { state: "absent" };
  if (intent.at > now) return { state: "waiting", at: intent.at };
  if (busy || resumeAt !== null) return { state: "deferred", at: Math.max(now, resumeAt ?? 0) + RESUME_RETRY_MS };
  return { state: "due" };
}

export function nextOccurrence(schedule: Schedule, now: number): Schedule | null {
  if (!schedule.everyHours) return null;
  const step = schedule.everyHours * 3_600_000;
  return { ...schedule, at: schedule.at + (Math.floor((now - schedule.at) / step) + 1) * step };
}
