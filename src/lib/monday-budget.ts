type DailyLimit = { calls: number; plan: string; reason: string | null };

const LIMITS: Readonly<Record<string, [calls: number, plan: string]>> = {
  free: [200, "Free"], basic: [1_000, "Basic"], standard: [1_000, "Standard"], pro: [10_000, "Pro"], trial: [10_000, "Trial"], enterprise: [25_000, "Enterprise"],
};

export function dailyLimit(tier: string | null | undefined): DailyLimit {
  const known = tier ? LIMITS[tier.trim().toLowerCase()] : undefined;
  if (known) return { calls: known[0], plan: known[1], reason: null };
  return {
    calls: 200, plan: "Free",
    reason: tier
      ? `monday answered the plan "${tier}", which this app does not know, so the Free plan's 200 is assumed.`
      : "monday's plan has not been read for this connection, so the Free plan's 200 is assumed: press Check again under Connect to read it.",
  };
}

const pages = (items: number): number => Math.ceil(Math.max(0, items) / 100);

export const planCalls = (boardItems: readonly number[]): number => boardItems.reduce((n, items) => n + 2 + pages(items), 0);

export const discoverCalls = (boardItems: readonly number[]): number =>
  boardItems.length ? boardItems.reduce((n, items) => n + 5 + 2 * pages(items), 0) + 1 : 0;

export const passesToday = (calls: number, usedToday: number, limit: DailyLimit): boolean => usedToday + calls > limit.calls;

export function costSentence(calls: number, usedToday: number | null, limit: DailyLimit): string {
  return usedToday !== null && passesToday(calls, usedToday, limit)
    ? "monday’s daily limit may pause this read until 00:00 UTC."
    : "";
}
