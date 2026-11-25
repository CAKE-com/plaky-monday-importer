import { z } from "zod";
import { withSetup } from "@/server/jobs/runner";
import { PreconditionError } from "@/server/errors";
import { loadDirectory } from "@/server/pipeline/plan";
import { loadManifest } from "@/server/pipeline/store";
import { assignableUsers, currentPeople, saveEveryoneUnmatched, savePeopleMatch, unmatchedPeople } from "@/server/pipeline/people-match";
import { router } from "../init";
import { depsFor, migrationProcedure } from "./shared";

const row = z.object({
  kind: z.enum(["person", "team"]), mondayUserId: z.string(), name: z.string(), email: z.string().nullable(), state: z.string(), members: z.array(z.string()), plakyUserId: z.number().nullable(),
  standIn: z.string().nullable(), placeholder: z.string().nullable(), teamExists: z.boolean(), problem: z.string().nullable(), other: z.string().nullable(), choice: z.enum(["user", "unassigned", "header", "team", "other"]),
});

export const peopleRouter = router({
  list: migrationProcedure.output(z.object({ linked: z.boolean(), rows: z.array(row), users: z.array(z.object({ id: z.number(), name: z.string(), email: z.string() })) })).query(async ({ ctx, input }) => {
    const manifest = await loadManifest(ctx.db, input.migrationId);
    if (!manifest) throw new PreconditionError("discover first: this migration has no manifest");
    const directory = await loadDirectory((await depsFor(ctx, input.migrationId, () => undefined)).plaky);
    const { people, linked } = await currentPeople(ctx.db, input.migrationId);
    return { linked, rows: unmatchedPeople(manifest, directory, people), users: assignableUsers(directory).map((u) => ({ id: u.id, name: u.name, email: u.email })) };
  }),

  match: migrationProcedure.input(z.object({
    mondayUserId: z.string().regex(/^(team:)?\d{1,20}$/, "a monday user id, or team:<id> for a monday team"), to: z.union([z.number().int().positive(), z.literal("unassigned"), z.literal("header"), z.literal("team")]),
  })).output(z.object({ saved: z.boolean() })).mutation(async ({ ctx, input }) =>
    withSetup(input.migrationId, "saving a people match", async () => {
      const manifest = await loadManifest(ctx.db, input.migrationId);
      if (!manifest) throw new PreconditionError("discover first: this migration has no manifest");
      const directory = await loadDirectory((await depsFor(ctx, input.migrationId, () => undefined)).plaky);
      await savePeopleMatch(ctx.db, input.migrationId, manifest, directory, input.mondayUserId, input.to);
      return { saved: true };
    })),

  matchAll: migrationProcedure.input(z.object({ to: z.enum(["header", "team", "unassigned"]) })).output(z.object({ changed: z.number() })).mutation(async ({ ctx, input }) =>
    withSetup(input.migrationId, "saving the people matches", async () => {
      const manifest = await loadManifest(ctx.db, input.migrationId);
      if (!manifest) throw new PreconditionError("discover first: this migration has no manifest");
      const directory = await loadDirectory((await depsFor(ctx, input.migrationId, () => undefined)).plaky);
      return { changed: await saveEveryoneUnmatched(ctx.db, input.migrationId, manifest, directory, input.to) };
    })),
});
