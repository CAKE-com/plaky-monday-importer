import { z } from "zod";
import { env } from "@/server/env";
import { DEFAULT_OPTIONS, createMigration, getMigration, loadLinkConfig, loadManifest, renameMigration, saveDraft, updateSetup } from "@/server/pipeline/store";
import { discoverStep } from "@/server/pipeline/migration";
import { loadDirectory } from "@/server/pipeline/plan";
import { defaultChoices } from "@/server/pipeline/people-match";
import { TEAM_KEY } from "@/server/pipeline/config";
import { boardWarnings, fieldCount, importable, manifestWarnings, type Manifest } from "@/server/pipeline/manifest";
import { BOARD_TYPE, privacyFlag } from "@/server/pipeline/discover";
import { lossyColumns } from "@/server/pipeline/transform/compat";
import { router } from "../init";

const MAIN_WORKSPACE = "Main workspace";
import { dropPlan, withSetup } from "@/server/jobs/runner";
import { PreconditionError } from "@/server/errors";
import { collect, depsFor, migrationProcedure } from "./shared";
import { manifestSummary, type ManifestSummary } from "@/lib/reports";

const optionsInput = z.object({
  syncComments: z.boolean(), syncFiles: z.boolean(), syncSubscribers: z.boolean(), withCreated: z.boolean(), withLink: z.boolean(),
  subitems: z.enum(["board", "nested"]).default("board"),
});

function summarizeManifest(m: Manifest): ManifestSummary {
  return {
    generatedAt: m.generatedAt,
    boards: m.boards.map((b) => ({
      id: b.id, name: b.name, items: b.itemsCount, subitemsOf: b.parentBoardId, nested: b.nested, plakyBoardId: b.plakyBoardId, fields: fieldCount(b), carried: importable(b).length,
      notCarried: b.columns.filter((c) => c.plakyType === null).map((c) => ({ title: c.title, type: c.type, reason: c.reason ?? "" })),
      warnings: boardWarnings(b), byHand: [...b.byHand], archivedItems: b.archivedItems, deletedItems: b.deletedItems, ...(b.archivedGroups.length ? { archivedGroups: [...b.archivedGroups] } : {}),
      asText: lossyColumns([...b.columns, ...b.nestedColumns]),
    })),
    skipped: m.skipped.map((s) => ({ id: s.id, name: s.name, kind: s.kind, reason: s.reason })),
    warnings: manifestWarnings(m),
    people: m.people.length,
  };
}

export const discoveryRouter = router({
  catalog: migrationProcedure.output(z.object({
    boards: z.array(z.object({
      id: z.string(), name: z.string(), items: z.number(), kind: z.string(), selectable: z.boolean(), why: z.string().nullable(), privacy: z.string().nullable(),
      workspace: z.string(), workspaceId: z.string().nullable(), folder: z.string().nullable(),
    })),
    spaces: z.array(z.object({ id: z.number(), title: z.string(), defaultSpace: z.boolean(), closed: z.boolean() })),
  })).query(async ({ ctx, input }) => {
    const { monday, plaky } = await depsFor(ctx, input.migrationId, () => undefined);
    const [listed, spaces] = await Promise.all([monday.listBoardsWithPlaces(), plaky.allSpaces()]);
    return {
      boards: listed.boards.filter((b) => ["active", "archived"].includes(b.state ?? "active")).map((b) => {
        const archived = b.state === "archived";
        const folder = b.board_folder_id === null || b.board_folder_id === undefined ? null : (listed.folders.get(String(b.board_folder_id)) ?? null);
        return {
          id: String(b.id), name: b.name ?? String(b.id), items: Math.trunc(b.items_count ?? 0), kind: b.type ?? "board",
          selectable: b.type === BOARD_TYPE && !archived,
          why: archived ? "archived in monday: restore it there to move it" : b.type === BOARD_TYPE ? null : b.type === "sub_items_board" ? "follows its parent board" : "not a board",
          privacy: b.type === BOARD_TYPE && !archived ? privacyFlag(b.board_kind, b.permissions) : null,
          workspace: b.workspace?.name ?? MAIN_WORKSPACE, workspaceId: b.workspace ? String(b.workspace.id) : null, folder,
        };
      }),
      spaces: spaces.map((s) => ({ id: Number(s.id), title: s.title ?? String(s.id), defaultSpace: s.defaultSpace === true, closed: s.kind === "CLOSED" })),
    };
  }),

  split: migrationProcedure.output(z.object({ migrations: z.array(z.object({ migrationId: z.number(), workspace: z.string(), boards: z.number() })) })).mutation(async ({ ctx, input }) => {
    return withSetup(input.migrationId, "the split", async () => {
      if (await loadManifest(ctx.db, input.migrationId)) throw new PreconditionError("split before reading the boards: this migration has read them already");
      const { monday } = await depsFor(ctx, input.migrationId, () => undefined);
      const listed = await monday.listBoardsWithPlaces();
      const groups = new Map<string, { name: string; ids: string[] }>();
      for (const b of listed.boards) {
        if (b.type !== BOARD_TYPE || (b.state ?? "active") !== "active") continue;
        const name = b.workspace?.name ?? MAIN_WORKSPACE;
        const group = groups.get(name) ?? { name, ids: [] };
        group.ids.push(String(b.id));
        groups.set(name, group);
      }
      if (groups.size < 2) throw new PreconditionError("the boards are all in one workspace: there is nothing to split");
      const current = await getMigration(ctx.db, input.migrationId);
      const [first, ...rest] = [...groups.values()];
      const out = [{ migrationId: input.migrationId, workspace: first!.name, boards: first!.ids.length }];
      await updateSetup(ctx.db, input.migrationId, { options: { ...current.options, pick: first!.ids, draft: undefined } });
      await renameMigration(ctx.db, input.migrationId, `${current.name} — ${first!.name}`);
      for (const group of rest) {
        const migrationId = await createMigration(ctx.db, { connectionId: current.connectionId, name: `${current.name} — ${group.name}`, plakySpaceId: current.plakySpaceId, options: { ...current.options, pick: group.ids, draft: undefined } });
        out.push({ migrationId, workspace: group.name, boards: group.ids.length });
      }
      return { migrations: out };
    });
  }),

  draft: migrationProcedure.input(z.object({ boards: z.array(z.string().regex(/^\d{1,20}$/, "a monday board id")).max(500), spaceId: z.number().int().positive().nullable(), options: optionsInput.optional() })).output(z.object({ saved: z.boolean() })).mutation(async ({ ctx, input }) => {
    await saveDraft(ctx.db, input.migrationId, { boards: input.boards, spaceId: input.spaceId, ...(input.options ? { options: input.options } : {}) });
    return { saved: true };
  }),

  run: migrationProcedure.input(z.object({ boardIds: z.array(z.string().regex(/^\d{1,20}$/, "a monday board id")).min(1).max(500), spaceId: z.number().int().positive(), options: optionsInput })).output(z.object({ manifest: manifestSummary, messages: z.array(z.object({ level: z.string(), code: z.string(), message: z.string() })) })).mutation(async ({ ctx, input }) => {
    return withSetup(input.migrationId, "discovery", async () => {
      const events = collect();
      const deps = await depsFor(ctx, input.migrationId, events.log);
      const known = (await deps.plaky.allSpaces()).some((s) => Number(s.id) === input.spaceId);
      if (!known) throw new PreconditionError(`Plaky space ${input.spaceId} does not exist in this workspace`);
      const current = await getMigration(ctx.db, input.migrationId);
      if ((await loadLinkConfig(ctx.db, input.migrationId)) && (current.options.subitems ?? "board") !== input.options.subitems) {
        throw new PreconditionError("the boards are linked with subitems going " + ((current.options.subitems ?? "board") === "board" ? "to a board of their own" : "nested under their items") + ": that choice is fixed once the boards are linked. To move them the other way, make a new migration.");
      }
      const draft = { boards: input.boardIds, spaceId: input.spaceId, options: input.options };
      await saveDraft(ctx.db, input.migrationId, draft);
      const extras = [...(input.options.withCreated ? ["created"] : []), ...(input.options.withLink ? ["link"] : [])];
      const keyOf = (p: { kind: string; id: string }): string => (p.kind === "team" ? `${TEAM_KEY}${p.id}` : p.id);
      const seen = new Set(((await loadManifest(ctx.db, input.migrationId))?.people ?? []).map(keyOf));
      const manifest = await discoverStep(deps, { only: input.boardIds, extras, listArchived: true, handLists: true, setup: { plakySpaceId: input.spaceId, options: input.options, draft } });
      dropPlan(input.migrationId);
      if (manifest.people.some((p) => (p.kind === "person" || p.kind === "team") && !seen.has(keyOf(p)))) await defaultChoices(ctx.db, input.migrationId, manifest, await loadDirectory(deps.plaky), { seen });
      return { manifest: summarizeManifest((await loadManifest(ctx.db, input.migrationId)) ?? manifest), messages: events.messages() };
    });
  }),

  manifest: migrationProcedure.output(z.object({
    manifest: manifestSummary.nullable(), spaceId: z.number().nullable(), options: optionsInput.extend({ prune: z.boolean(), recreateDrifted: z.boolean() }), selected: z.array(z.string()),
    pick: z.array(z.string()).nullable(),
    draft: z.object({ boards: z.array(z.string()), spaceId: z.number().nullable(), options: optionsInput.optional() }).nullable(),
    seedFailures: z.array(z.string()),
  })).query(async ({ ctx, input }) => {
    const [migration, manifest] = await Promise.all([getMigration(ctx.db, input.migrationId), loadManifest(ctx.db, input.migrationId)]);
    const o = { ...DEFAULT_OPTIONS, ...migration.options };
    return {
      manifest: manifest ? summarizeManifest(manifest) : null,
      spaceId: migration.plakySpaceId ?? env.PLAKY_E2E_SPACE_ID ?? null,
      options: { syncComments: o.syncComments, syncFiles: o.syncFiles, syncSubscribers: o.syncSubscribers, withCreated: o.withCreated, withLink: o.withLink, subitems: o.subitems ?? "board", prune: o.prune, recreateDrifted: o.recreateDrifted },
      selected: manifest ? manifest.boards.filter((b) => b.parentBoardId === null).map((b) => b.id) : [],
      pick: migration.options.pick ?? null,
      draft: migration.options.draft ?? null,
      seedFailures: migration.seedFailures,
    };
  }),
});
