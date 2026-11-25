import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { MAX_BATCH } from "@/lib/trpc-limits";
import { Explanation } from "@/server/explain-error";
import { logger } from "@/server/redact";
import { refuseRequest } from "@/server/request-guard";
import type { Context } from "@/server/trpc/context";
import { appRouter } from "@/server/trpc/router";

const REFUSALS = new Set(["PRECONDITION_FAILED", "CONFLICT", "BAD_REQUEST"]);

const MAX_BODY_BYTES = 1_000_000;

export function handleTrpc(req: Request, createContext: () => Promise<Context>): Promise<Response> | Response {
  const refusal = refuseRequest(req.headers);
  if (refusal) return Response.json({ error: refusal }, { status: 403 });
  if (Number(req.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) return Response.json({ error: "refused: request body too large" }, { status: 413 });
  return fetchRequestHandler({
    endpoint: "/api/trpc",
    req,
    router: appRouter,
    createContext,
    maxBatchSize: MAX_BATCH,
    onError: ({ path, error }) => {
      const technical = error.cause instanceof Explanation ? error.cause.technical : null;
      const refused = REFUSALS.has(error.code) && !technical;
      (refused ? logger.info : logger.error)(`tRPC ${refused ? "refused" : "failed on"} ${path ?? "<no-path>"}: ${error.message}${technical ? ` [${technical}]` : ""}`);
    },
  });
}
