import { MAX_RETRY_WAIT_S } from "./errors";

export function errorCodes(errors: unknown): Set<string> {
  const codes = new Set<string>();
  if (!Array.isArray(errors)) return codes;
  for (const error of errors) {
    if (!error || typeof error !== "object") continue;
    const e = error as Record<string, unknown>;
    const extensions = e["extensions"] && typeof e["extensions"] === "object" ? (e["extensions"] as Record<string, unknown>) : {};
    for (const value of [extensions["code"], e["error_code"], e["message"]]) if (typeof value === "string" && value) codes.add(value.trim().toUpperCase());
  }
  return codes;
}

export function retryHint(errors: unknown): number | null {
  if (!Array.isArray(errors)) return null;
  const hints: number[] = [];
  for (const error of errors) {
    if (!error || typeof error !== "object") continue;
    const extensions = (error as Record<string, unknown>)["extensions"];
    if (!extensions || typeof extensions !== "object") continue;
    const { retry_in_seconds: seconds, retryAfterMs: millis } = extensions as Record<string, unknown>;
    if (typeof seconds === "number") hints.push(seconds);
    else if (typeof millis === "number") hints.push(millis / 1000);
  }
  return hints.length ? Math.max(...hints) : null;
}

export function backoffSeconds(attempt: number, retryAfter: number | null, random: () => number): number {
  if (retryAfter !== null && Number.isFinite(retryAfter)) return Math.min(Math.max(retryAfter, 0), MAX_RETRY_WAIT_S);
  const capped = Math.min(0.5 * 2 ** attempt, 30);
  return capped / 2 + random() * (capped / 2);
}

export function labelIdsIn(value: unknown): string[] {
  const parsed = looseJson(value);
  if (!parsed || typeof parsed !== "object") return [];
  const record = parsed as Record<string, unknown>;
  if (Array.isArray(record["ids"])) return (record["ids"] as unknown[]).filter((id) => id !== null && id !== undefined).map(String);
  const index = record["index"];
  return typeof index === "number" || (typeof index === "string" && index !== "") ? [String(index)] : [];
}

export function tagIdsIn(value: unknown): string[] {
  const parsed = looseJson(value);
  if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as Record<string, unknown>)["tag_ids"])) return [];
  return ((parsed as { tag_ids: unknown[] }).tag_ids).filter((t) => t !== null && t !== undefined).map(String);
}

export function peopleIn(value: unknown): [string, string][] {
  const parsed = looseJson(value);
  if (!parsed || typeof parsed !== "object") return [];
  const record = parsed as Record<string, unknown>;
  if (record["team_id"] !== null && record["team_id"] !== undefined) return [["team", String(record["team_id"])]];
  const entries = Array.isArray(record["personsAndTeams"]) ? (record["personsAndTeams"] as unknown[]) : [];
  const out: [string, string][] = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    if (e["id"] === null || e["id"] === undefined) continue;
    out.push([String(e["kind"] || "person"), String(e["id"])]);
  }
  return out;
}

function looseJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}
