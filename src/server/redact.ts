const MASK = "[redacted]";

const SENSITIVE_KEYS = new Set([
  "authorization",
  "proxy-authorization",
  "x-api-key",
  "public_url",
  "download_url",
  "token",
  "cookie",
  "set-cookie",
  "monday_token",
  "plaky_key",
  "mondaytoken",
  "plakykey",
  "typedkey",
  "api_key",
  "apikey",
  "api-key",
  "monday_api_token",
  "plaky_api_key",
  "password",
  "secret",
  "client_secret",
  "access_token",
  "refresh_token",
  "id_token",
  "auth_token",
]);
const KEY_NAMES = "monday_token|plaky_key|mondayToken|plakyKey|typedKey|api_key|apiKey|api-key|MONDAY_API_TOKEN|PLAKY_API_KEY|access_token|refresh_token|id_token|auth_token|password|client_secret|secret";

const PATTERNS: Array<[RegExp, string]> = [
  [/(authorization(?:[\\"']*\s*[:=]\s*[\\"']*|[\\"']+\s*,\s*[\\"']+))(?:(?:bearer|basic|token|digest)\s+)?[^\s\\"',}\]]+/gi, `$1${MASK}`],
  [/(x-api-key(?:[\\"']*\s*[:=]\s*[\\"']*|[\\"']+\s*,\s*[\\"']+))[^\s\\"',}\]]+/gi, `$1${MASK}`],
  [/((?:public_url|download_url)[\\"']*\s*[:=]\s*[\\"']*)[^\s\\"',}]+/gi, `$1${MASK}`],
  [/((?:set-)?cookie["']?\s*[:=]\s*["']?)[^\r\n"']+/gi, `$1${MASK}`],
  [/(?<![a-z_])(token=)(?!\[redacted\])[^&\s"']+/gi, `$1${MASK}`],
  [new RegExp(`(\\b(?:${KEY_NAMES})[\\\\"']*\\s*[:=]\\s*[\\\\"']*)(?!\\[redacted\\])[^\\s\\\\"',}\\]&]+`, "gi"), `$1${MASK}`],
  [/([\\"']+token[\\"']+\s*(?:[:,])\s*[\\"']+)[^\\"']*/gi, `$1${MASK}`],
];

const FAILED_QUERY = /(?:Failed query:|(?:^|\n)params:)[\s\S]*$/;

const MIN_SECRET = 8;
const secrets = ((globalThis as { __mmwSecrets?: { values: Set<string>; sorted: string[] | null } }).__mmwSecrets ??= { values: new Set(), sorted: null });

export function registerSecret(value: string | null | undefined): void {
  if (typeof value !== "string") return;
  for (const raw of new Set([value, value.trim()])) {
    if (raw.length < MIN_SECRET) continue;
    for (const form of [raw, JSON.stringify(raw).slice(1, -1), encodeURIComponent(raw)]) {
      if (secrets.values.has(form)) continue;
      secrets.values.add(form);
      secrets.sorted = null;
    }
  }
}

export function forgetSecretsForTests(): void {
  secrets.values.clear();
  secrets.sorted = null;
}

function maskSecrets(text: string): string {
  if (!secrets.values.size) return text;
  secrets.sorted ??= [...secrets.values].sort((a, b) => b.length - a.length);
  let out = text;
  for (const value of secrets.sorted) if (out.includes(value)) out = out.split(value).join(MASK);
  return out;
}

export function redactString(text: string): string {
  return PATTERNS.reduce((acc, [pattern, replacement]) => acc.replace(pattern, replacement), maskSecrets(text).replace(FAILED_QUERY, "[database query withheld]"));
}

export function redact(value: unknown, ancestors: WeakSet<object> = new WeakSet()): unknown {
  if (typeof value === "string") return redactString(value);
  if (value instanceof Error) return redactString(`${value.name}: ${value.message}`);
  if (value === null || typeof value !== "object") return value;
  if (ancestors.has(value)) return "[circular]";
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (value.length === 2 && typeof value[0] === "string" && SENSITIVE_KEYS.has(value[0].toLowerCase())) return [value[0], MASK];
      return value.map((inner) => redact(inner, ancestors));
    }
    const entries = value instanceof Headers ? [...value.entries()] : Object.entries(value);
    return Object.fromEntries(
      entries.map(([key, inner]) => [
        key,
        SENSITIVE_KEYS.has(key.toLowerCase()) ? MASK : redact(inner, ancestors),
      ]),
    );
  } finally {
    ancestors.delete(value);
  }
}

type Level = "debug" | "info" | "warn" | "error";

function emit(level: Level, message: string, data?: unknown): void {
  const line = redactString(message);
  const sink = console[level];
  if (data === undefined) sink(line);
  else sink(line, redact(data));
}

export const logger = {
  debug: (message: string, data?: unknown) => emit("debug", message, data),
  info: (message: string, data?: unknown) => emit("info", message, data),
  warn: (message: string, data?: unknown) => emit("warn", message, data),
  error: (message: string, data?: unknown) => emit("error", message, data),
};
