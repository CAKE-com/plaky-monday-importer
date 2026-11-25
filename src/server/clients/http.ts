export type Transport = (url: URL, init: RequestInit) => Promise<Response>;

export type Clock = {
  now(): number;
  sleep(ms: number): Promise<void>;
};

export const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export const fetchTransport: Transport = (url, init) => fetch(url, { redirect: "error", ...init });

export function retryAfterSeconds(response: Response, now: number = Date.now()): number | null {
  const raw = response.headers.get("retry-after");
  if (raw === null || raw.trim() === "") return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return seconds;
  const at = Date.parse(raw);
  return Number.isFinite(at) ? Math.max(0, Math.ceil((at - now) / 1000)) : null;
}
