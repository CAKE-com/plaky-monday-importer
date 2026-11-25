export const MONDAY_API_URL = "https://api.monday.com/v2";
export const MONDAY_API_VERSION = "2026-10";
export const MONDAY_DEFAULT_PAGE_SIZE = 100;
export const MONDAY_MIN_PAGE_SIZE = 5;
export const MONDAY_MAX_PAGE_SIZE = 500;
export const TAG_BATCH = 100;
export const ASSET_BATCH = 50;
export const TEAM_BATCH = 50;
export const USER_BATCH = 100;
export const BOARD_BATCH = 20;
export const DESCRIPTION_PAGE = 25;
export const DESCRIPTION_FETCH_PAGE = 100;
export const DESCRIPTION_PAGE_CAP = 1000;
export const UPDATES_PAGE = 100;
export const RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);
export const RETRY_CODES = new Set(["COMPLEXITY_BUDGET_EXHAUSTED", "RATE_LIMIT_EXCEEDED", "MAXCONCURRENCYEXCEEDED", "IP_RATE_LIMIT_EXCEEDED"]);
export const MAX_RETRY_WAIT_S = 60;
export const GATEWAY_REFUSAL_WAIT_MS = 60_000;
export const GATEWAY_FLOOR_RETRIES = 5;
export const REQUEST_TIMEOUT_MS = 60_000;

export class MondayError extends Error {
  override name = "MondayError";
}
export class MondayGraphQLError extends MondayError {
  override name = "MondayGraphQLError";
}
export class MondayDailyLimitError extends MondayError {
  override name = "MondayDailyLimitError";
}
export class MondayStoppedError extends MondayError {
  override name = "MondayStoppedError";
}
export class MondayGatewayRefusedError extends MondayError {
  override name = "MondayGatewayRefusedError";
}
export const isMondayDailyLimit = (error: unknown): error is MondayDailyLimitError =>
  error instanceof MondayDailyLimitError || (error instanceof Error && error.name === "MondayDailyLimitError");
