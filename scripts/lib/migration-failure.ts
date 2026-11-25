import { redactString } from "../../src/server/redact";

const HINTS: Record<string, string> = {
  SQLITE_READONLY: "the database file or its folder is not writable by this user: check the permissions of data/ and the files in it",
  SQLITE_CANTOPEN: "the database file cannot be opened: check that DATABASE_URL names a folder that exists and that this user may write",
  SQLITE_BUSY: "another process holds the database: stop the other copy of the app, then start again",
  SQLITE_LOCKED: "another process holds the database: stop the other copy of the app, then start again",
  SQLITE_NOTADB: "the file is not a SQLite database: restore a copy of the database file you saved, or point DATABASE_URL at the right file",
  SQLITE_CORRUPT: "the database file is damaged: restore a copy of the database file you saved",
};

export function migrationFailure(error: unknown): string {
  const cause = (error as { cause?: unknown } | null)?.cause;
  const code = [(cause as { code?: unknown } | null)?.code, (error as { code?: unknown } | null)?.code].find((c): c is string => typeof c === "string") ?? null;
  const said = cause instanceof Error ? cause.message : error instanceof Error ? error.message : String(error);
  const hint = code === null ? null : (HINTS[code] ?? (Object.entries(HINTS).find(([k]) => code.startsWith(`${k}_`))?.[1] ?? null));
  const line = redactString(said).replace(/\s+/g, " ").trim();
  return `Cannot start: the database migrations failed: ${line}${code !== null && !line.includes(code) ? ` (${code})` : ""}${hint ? `. ${hint.charAt(0).toUpperCase()}${hint.slice(1)}.` : ""}`;
}
