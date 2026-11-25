import { eq } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "@/db/client";
import { migrations } from "@/db/schema";
import { getMigration, loadManifest } from "@/server/pipeline/store";
import { readiness, type GoneBoard, type PlakyBoardShape, type Unread } from "@/server/pipeline/readiness";
import { explainError } from "@/server/explain-error";
import { currentPeople } from "@/server/pipeline/people-match";
import { isPlakyNotFound, type PlakyClient } from "@/server/clients/plaky";
import { seedCsv, slug, writeBlueprint, GUIDE_FILE } from "@/server/pipeline/provision";
import { seedHeaders, seedRowsNeeded, seededColumns } from "@/server/pipeline/manifest";
import { previewLink } from "@/server/pipeline/migration";
import { loadDirectory } from "@/server/pipeline/plan";
import { scanHomes, scanItemIds } from "@/server/jobs/runner";
import { importLabel, lossyColumns } from "@/server/pipeline/transform/compat";
import { PreconditionError } from "@/server/errors";
import { router } from "../init";
import { collect, depsFor, migrationProcedure } from "./shared";

export const linkPreview = z.object({
  links: z.array(z.object({ mondayBoardId: z.string(), name: z.string(), plakyBoardId: z.number(), plakyTitle: z.string().nullable(), paired: z.number(), unmatched: z.array(z.string()), warnings: z.array(z.string()), seedRows: z.number(), ready: z.boolean(), subitemsOf: z.string().nullable() })),
  missing: z.array(z.object({ id: z.string(), name: z.string() })),
  gone: z.array(z.object({ id: z.string(), name: z.string(), plakyBoardId: z.number() })),
  hints: z.array(z.object({ id: z.string(), name: z.string(), plakyBoardId: z.number(), kind: z.enum(["loose-marker", "cleared-marker", "moved-before"]), text: z.string() })),
  blocking: z.array(z.string()),
  peopleWarnings: z.array(z.string()),
  wanted: z.number(),
  needsConfirm: z.boolean(),
  changes: z.array(z.string()).nullable(),
});

const readinessItem = z.object({
  key: z.string(), board: z.string().nullable(), text: z.string(), kind: z.enum(["checked", "manual"]), done: z.boolean(),
  boardName: z.string().optional(),
});

async function readinessNow(db: Db, migrationId: number, plaky: PlakyClient, found: ReadonlyMap<string, number>): Promise<z.infer<typeof readinessItem>[]> {
  const [migration, manifest] = await Promise.all([getMigration(db, migrationId), loadManifest(db, migrationId)]);
  if (!manifest || migration.plakySpaceId === null) return [];
  const boards = new Map<string, PlakyBoardShape | GoneBoard | Unread>();
  for (const b of manifest.boards) {
    const plakyId = found.get(b.id) ?? b.plakyBoardId;
    if (plakyId === null || plakyId === undefined) continue;
    try {
      boards.set(b.id, await plaky.getBoard(migration.plakySpaceId, plakyId));
    } catch (error) {
      boards.set(b.id, isPlakyNotFound(error) ? { gone: plakyId } : { unread: explainError(error).text });
    }
  }
  const teams = manifest.people.some((p) => p.placeholder)
    ? await loadDirectory(plaky).then((d) => [...d.teamsById.values()], (error: unknown): Unread => ({ unread: explainError(error).text }))
    : [];
  const names = new Map(manifest.boards.map((b) => [b.id, b.name]));
  return readiness(manifest, boards, teams, new Set(migration.readinessTicks), (await currentPeople(db, migrationId)).people)
    .map((item) => (item.board !== null && names.has(item.board) ? { ...item, boardName: names.get(item.board)! } : item));
}

const MAX_TICK_KEY = 20_000;
const MAX_TICKS = 500;

export const provisionRouter = router({
  guide: migrationProcedure.output(z.object({
    boards: z.array(z.object({
      id: z.string(), name: z.string(), linked: z.boolean(), fileName: z.string().nullable(), csv: z.string().nullable(), rows: z.number(), headers: z.array(z.string()),
      checklist: z.array(z.object({ field: z.string(), plakyType: z.string(), typeLabel: z.string(), labels: z.number(), reason: z.string().nullable() })), byHand: z.array(z.string()),
      lossy: z.array(z.string()),
    })),
    standInTeams: z.array(z.object({ title: z.string(), for: z.string(), state: z.string() })),
    buildGuide: z.string(),
  })).query(async ({ ctx, input }) => {
    const manifest = await loadManifest(ctx.db, input.migrationId);
    if (!manifest) throw new PreconditionError("discover the boards first");
    const blueprint = writeBlueprint(manifest, (await currentPeople(ctx.db, input.migrationId)).people);
    return {
      boards: manifest.boards.map((b) => {
        const fileName = blueprint.seedFiles.get(b.id) ?? (b.plakyBoardId !== null && !b.nested ? `${slug(b.name, b.id)}.seed.csv` : null);
        return {
          id: b.id, name: b.name, linked: b.plakyBoardId !== null, fileName, csv: fileName ? seedCsv(b) : null, rows: seedRowsNeeded(b), headers: seedHeaders(b),
          checklist: [
            ...seedHeaders(b).slice(1, seedHeaders(b).length - seededColumns(b).length).map((field) => ({ field, plakyType: "STRING", typeLabel: "Text", labels: 0, reason: null })),
            ...seededColumns(b).map((c) => ({ field: c.fieldName, plakyType: c.plakyType ?? "", typeLabel: importLabel(c.plakyType, c.importAs), labels: c.labels.length, reason: c.reason })),
          ],
          byHand: [...b.byHand],
          lossy: lossyColumns(b.columns),
        };
      }),
      standInTeams: manifest.people.filter((p) => p.placeholder).map((p) => ({ title: p.placeholder!, for: p.name, state: p.state })),
      buildGuide: blueprint.files[GUIDE_FILE] ?? "",
    };
  }),

  detect: migrationProcedure.input(z.object({ background: z.boolean().optional() })).output(z.object({ preview: linkPreview, readiness: z.array(readinessItem), messages: z.array(z.object({ level: z.string(), code: z.string(), message: z.string() })) })).mutation(async ({ ctx, input }) => {
    const events = collect();
    const deps = await depsFor(ctx, input.migrationId, events.log);
    const homes = scanHomes(input.migrationId);
    const preview = await previewLink(deps, input.background ? { noMonday: true, homes } : { itemIds: scanItemIds(input.migrationId, deps.monday), homes });
    const found = new Map(preview.links.map((l) => [l.mondayBoardId, l.plakyBoardId]));
    return { preview, readiness: await readinessNow(ctx.db, input.migrationId, deps.plaky, found), messages: events.messages() };
  }),

  readiness: migrationProcedure.output(z.array(readinessItem)).mutation(async ({ ctx, input }) =>
    readinessNow(ctx.db, input.migrationId, (await depsFor(ctx, input.migrationId, () => undefined)).plaky, new Map())),

  tick: migrationProcedure.input(z.object({ key: z.string().min(1).max(MAX_TICK_KEY), done: z.boolean() })).output(z.object({ ticks: z.array(z.string()) })).mutation(async ({ ctx, input }) => {
    const migration = await getMigration(ctx.db, input.migrationId);
    const ticks = new Set(migration.readinessTicks);
    if (input.done && !ticks.has(input.key) && ticks.size >= MAX_TICKS) throw new PreconditionError(`at most ${MAX_TICKS} items can be ticked`);
    if (input.done) ticks.add(input.key);
    else ticks.delete(input.key);
    const next = [...ticks];
    await ctx.db.update(migrations).set({ readinessTicks: next }).where(eq(migrations.id, input.migrationId));
    return { ticks: next };
  }),
});
