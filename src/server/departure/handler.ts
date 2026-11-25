import { rm } from "node:fs/promises";
import { z } from "zod";
import { departurePreflight, receiptStaleness } from "@/lib/departure";
import { departureDownload } from "@/lib/departure-download";
import { archiveReadiness } from "@/lib/departure-state";
import { refuseRequest } from "../request-guard";
import { withSetup } from "../jobs/runner";
import { ConflictError, PreconditionError } from "../errors";
import { explainError } from "../explain-error";
import { redactString } from "../redact";
import { AssetFetcher, DocAwareSource, mondayAssetUrls } from "../pipeline/assets";
import type { Context } from "../trpc/context";
import { clientsOf } from "../trpc/routers/shared";
import { appRouter } from "../trpc/router";
import { archiveTemp, downloadArchive, offerDownload } from "./downloads";
import { departureSource, writeDepartureArchive } from "./archive";
import { DepartureZip } from "./zip";

const headers = { "cache-control": "no-store" };
export async function buildDeparture(req: Request, rawId: string, context: () => Promise<Context>): Promise<Response> {
  const refusal = refuseRequest(req.headers);
  if (refusal) return Response.json({ error: refusal }, { status: 403, headers });
  const id = z.coerce.number().int().positive().safeParse(rawId);
  if (!id.success) return Response.json({ error: "Invalid migration ID" }, { status: 400, headers });
  try {
    return await withSetup(id.data, "the departure archive", async () => {
      const ctx = await context();
      const caller = appRouter.createCaller(ctx);
      const [discovered, planned, verification, status] = await Promise.all([
        caller.discovery.manifest({ migrationId: id.data }), caller.plan.latest({ migrationId: id.data }),
        caller.verify.summary({ migrationId: id.data }), caller.run.status({ migrationId: id.data }),
      ]);
      const boards = discovered.manifest?.boards ?? [];
      const readiness = archiveReadiness({ boards: boards.length, active: status.active, waiting: !!status.waiting, scheduled: !!status.schedule });
      if (readiness === "unread") throw new PreconditionError("Read the boards before creating a departure archive");
      if (readiness !== "ready") throw new ConflictError("Finish the current run and cancel scheduled changes or a pending resume before creating the departure archive");
      const preflight = departurePreflight({
        manifest: discovered.manifest, plan: planned.summary, options: discovered.options, receipt: verification.receipt,
        ...receiptStaleness(verification),
      });
      const monday = (await clientsOf(ctx, id.data)).monday();
      monday.stopOn(req.signal);
      const assets = new DocAwareSource(new AssetFetcher({ fetchAssetUrls: mondayAssetUrls(monday) }), monday);
      const file = await archiveTemp();
      try {
        const zip = await DepartureZip.create(file.path);
        let result;
        try {
          result = await writeDepartureArchive({
            name: verification.migrationName, boardIds: boards.map((b) => b.id), preflight,
            evidence: { discovery: discovered, plan: planned.summary, verification },
            source: departureSource(monday), assets, add: (path, data) => zip.add(path, data), signal: req.signal,
          });
          req.signal.throwIfAborted();
          await zip.finish();
        } finally { await zip.close(); }
        const response = departureDownload.parse({ ...offerDownload(file, id.data), status: result.status,
          boards: result.boards.filter((b) => b.state === "read").length, attachments: result.attachments.length,
          failures: result.gaps.filter((g) => g.kind === "failed").length });
        return Response.json(response, { headers });
      } catch (e) { await rm(file.dir, { recursive: true, force: true }); throw e; }
    });
  } catch (e) {
    const explained = explainError(e);
    return Response.json({ error: redactString(explained.text) }, { status: explained.code === "CONFLICT" ? 409 : explained.code === "PRECONDITION_FAILED" ? 412 : explained.code === "NOT_FOUND" ? 404 : 500, headers });
  }
}

export async function serveDeparture(req: Request, ticket: string): Promise<Response> {
  const refusal = refuseRequest(req.headers);
  if (refusal) return Response.json({ error: refusal }, { status: 403, headers });
  try { return await downloadArchive(ticket); }
  catch { return Response.json({ error: "The archive is unavailable. Create a fresh departure archive." }, { status: 410, headers }); }
}
