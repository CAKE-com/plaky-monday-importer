import { TRPCError, type TRPC_ERROR_CODE_KEY } from "@trpc/server";
import { DrizzleQueryError } from "drizzle-orm/errors";
import { ConflictError, PreconditionError } from "./errors";
import { MONDAY_TOKEN_REFUSED, explainMessage, type Explained } from "@/lib/explain";
import { MondayDailyLimitError, MondayError } from "./clients/monday";
import { PlakyError, PlakyHttpError, RateLimitedError } from "./clients/plaky";
import { LinkError } from "./pipeline/link";
import { BoardLockedError } from "./pipeline/load";
import { ManifestError } from "./pipeline/manifest";
import { SyncSetupError } from "./pipeline/plan";
import { redactString } from "./redact";

type ServerExplained = Explained & { code: TRPC_ERROR_CODE_KEY };

export class Explanation extends Error {
  override name = "Explanation";
  constructor(readonly technical: string | null, override readonly cause: unknown) {
    super(technical ?? "explained");
  }
}

export const UNKNOWN = "Something went wrong that this app does not recognise. Try again; if it keeps happening, report it on the project's GitHub issues with the technical details.";
const SAVED_DATA = "This migration's saved data could not be read. Start it again from Connect; if it keeps happening, report it on the project's GitHub issues with the technical details.";

const is = (error: unknown, cls: abstract new (...args: never[]) => Error, ...names: string[]): boolean =>
  error instanceof cls || (error instanceof Error && names.includes(error.name));
const PLAKY_ERRORS = ["PlakyError", "PlakyHttpError", "OutcomeUnknownError", "RateLimitedError", "PlakyDecodeError"];
const MONDAY_ERRORS = ["MondayError", "MondayGraphQLError", "MondayDailyLimitError", "MondayGatewayRefusedError"];

const isQueryError = (error: unknown): error is Error & { cause?: unknown } =>
  error instanceof DrizzleQueryError || (error instanceof Error && typeof (error as { query?: unknown }).query === "string" && Array.isArray((error as { params?: unknown }).params));
const libsqlCode = (error: unknown): string | null => {
  const code = (error as { code?: unknown } | null)?.code;
  return error instanceof Error && error.name === "LibsqlError" && typeof code === "string" ? code : null;
};
function databaseFailure(driver: unknown): ServerExplained {
  const busy = typeof driver === "string" && /BUSY|LOCKED/.test(driver);
  return {
    code: "INTERNAL_SERVER_ERROR",
    text: busy ? "This computer's database was busy. Try again in a moment." : "This computer's database could not be read or written. Try again; if it keeps happening, restart the app.",
    technical: typeof driver === "string" ? driver : "database query failed",
  };
}

const technicalOf = (error: unknown): string => redactString(error instanceof Error ? `${error.name}: ${error.message}` : String(error));

function issuesOf(error: unknown): string | null {
  const issues = (error as { issues?: unknown })?.issues;
  if (!Array.isArray(issues) || !issues.length) return null;
  const said = [...new Set(issues.map((i) => (typeof (i as { message?: unknown })?.message === "string" ? (i as { message: string }).message : "this value is not valid")))].join("; ");
  return said.charAt(0).toUpperCase() + said.slice(1) + (/[.!?]$/.test(said) ? "" : ".");
}

function rewritten(error: Error, fallback: string): Explained {
  const out = explainMessage(error.message);
  return out.technical ? out : { text: fallback, technical: technicalOf(error) };
}

export function explainError(error: unknown): ServerExplained {
  const cause = error instanceof TRPCError && error.cause !== undefined ? error.cause : error;
  if (cause instanceof Explanation) return { code: error instanceof TRPCError ? error.code : "INTERNAL_SERVER_ERROR", text: (error as Error).message, technical: cause.technical };

  const issues = issuesOf(cause);
  if (issues && error instanceof TRPCError && error.message === "Output validation failed") return { code: "INTERNAL_SERVER_ERROR", text: SAVED_DATA, technical: issues };
  if (issues) return { code: "BAD_REQUEST", text: issues, technical: null };
  if (cause instanceof Error && cause.name === "SyntaxError" && /JSON/i.test(cause.message)) return { code: "INTERNAL_SERVER_ERROR", text: SAVED_DATA, technical: technicalOf(cause) };
  if (is(cause, BoardLockedError, "BoardLockedError")) return { code: "CONFLICT", text: "Another run is writing to this board right now. Wait for it to finish, then try again.", technical: technicalOf(cause) };
  if (is(cause, ConflictError, "ConflictError")) return { code: "CONFLICT", text: (cause as Error).message, technical: null };
  if (cause instanceof ManifestError || (cause instanceof Error && /^migration \d+ (?:config|manifest)\b/.test(cause.message))) {
    return { code: "PRECONDITION_FAILED", text: SAVED_DATA, technical: technicalOf(cause) };
  }
  if (is(cause, PreconditionError, "PreconditionError") || is(cause, LinkError, "LinkError") || is(cause, SyncSetupError, "SyncSetupError")) {
    return { code: "PRECONDITION_FAILED", ...explainMessage((cause as Error).message) };
  }
  if (is(cause, MondayDailyLimitError, "MondayDailyLimitError")) return { code: "TOO_MANY_REQUESTS", text: (cause as Error).message, technical: null };
  if (is(cause, RateLimitedError, "RateLimitedError")) return { code: "TOO_MANY_REQUESTS", ...rewritten(cause as Error, "Plaky kept asking to slow down (its rate limit). Try again in a few minutes.") };
  if (is(cause, PlakyHttpError, "PlakyHttpError")) {
    const { status } = cause as PlakyHttpError;
    const code: TRPC_ERROR_CODE_KEY = status === 401 || status === 403 ? "PRECONDITION_FAILED" : status === 404 ? "NOT_FOUND" : "BAD_GATEWAY";
    return { code, ...rewritten(cause as Error, `Plaky refused the request (HTTP ${status}).`) };
  }
  if (is(cause, PlakyError, ...PLAKY_ERRORS)) return { code: "BAD_GATEWAY", ...rewritten(cause as Error, "Plaky answered in a way this app does not recognise. Try again in a minute.") };
  if (is(cause, MondayError, ...MONDAY_ERRORS)) {
    const out = rewritten(cause as Error, "monday answered in a way this app does not recognise. Try again in a minute.");
    return { code: out.text === MONDAY_TOKEN_REFUSED ? "PRECONDITION_FAILED" : "BAD_GATEWAY", ...out };
  }
  if (isQueryError(cause)) return databaseFailure((cause.cause as { code?: unknown } | undefined)?.code);
  if (libsqlCode(cause) !== null) return databaseFailure(libsqlCode(cause));
  if (error instanceof TRPCError && error.cause === undefined) return { code: error.code, ...explainMessage(error.message) };
  if (error instanceof TRPCError && error.code !== "INTERNAL_SERVER_ERROR") return { code: error.code, ...rewritten(error, UNKNOWN) };
  return { code: "INTERNAL_SERVER_ERROR", text: UNKNOWN, technical: technicalOf(cause) };
}
