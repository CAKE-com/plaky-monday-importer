import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { erasePhrase } from "@/lib/erase-phrase";
import { MONDAY_TOKEN_REFUSED, PLAKY_KEY_REFUSED } from "@/lib/explain";
import { connections, migrations, selectMigrationSchema } from "@/db/schema";
import { env, normalizeWebAddress, PLAKY_WEB_ADDRESS, PLAKY_WEB_ADDRESS_HINT } from "@/server/env";
import { clientsWith, forgetMigration } from "@/server/jobs/runner";
import { identify, type Identity } from "@/server/pipeline/migration";
import { createMigration, ensureConnection, getMigration, keysFor, saveKeys, type Keys, type Typed } from "@/server/pipeline/store";
import { PreconditionError } from "@/server/errors";
import { MondayError } from "@/server/clients/monday";
import { PlakyHttpError } from "@/server/clients/plaky";
import type { Context } from "../context";
import { publicProcedure, router } from "../init";
import { migrationProcedure } from "./shared";

const info = z.object({
  account: z.string().nullable(), user: z.string().nullable(), zone: z.string().nullable(), plakyUser: z.string().nullable(), checkedAt: z.number(),
});

const migrationSummary = selectMigrationSchema.pick({ id: true, name: true, status: true, plakySpaceId: true, createdAt: true, updatedAt: true });

async function whose(ctx: Context, keys: Partial<Keys>) {
  const clients = (ctx.clients ?? clientsWith)(keys);
  try {
    return await identify(clients.monday(), clients.plaky());
  } catch (error) {
    throw refusedKey(error) ?? error;
  }
}

async function record(db: Context["db"], who: Identity, keys: Partial<Typed>) {
  const connectionId = await ensureConnection(db, who.connection, keys);
  await saveKeys(db, connectionId, keys);
  return { account: who.account, user: who.user, zone: who.zone, plakyUser: who.plakyUser, checkedAt: Date.now(), connectionId };
}

export function refusedKey(error: unknown): PreconditionError | null {
  if (error instanceof PlakyHttpError && (error.status === 401 || error.status === 403)) {
    return new PreconditionError(PLAKY_KEY_REFUSED);
  }
  if (error instanceof MondayError && /\bHTTP 40[13]\b|NOT_AUTHENTICATED|Not authenticated/i.test(error.message)) {
    return new PreconditionError(MONDAY_TOKEN_REFUSED);
  }
  return null;
}

const typedKey = z.string().trim().max(4000).optional().transform((v) => v || null);
const workspaceAddress = z.string().trim().max(200).optional().transform((v) => normalizeWebAddress(v ?? "") || null)
  .refine((v) => v === null || PLAKY_WEB_ADDRESS.test(v), PLAKY_WEB_ADDRESS_HINT);

export const connectionRouter = router({
  env: publicProcedure.output(z.object({ mondayToken: z.boolean(), plakyKey: z.boolean(), defaultSpaceId: z.number().nullable(), plakyWebBase: z.string().nullable() })).query(() => ({
    mondayToken: Boolean(env.MONDAY_API_TOKEN), plakyKey: Boolean(env.PLAKY_API_KEY), defaultSpaceId: env.PLAKY_E2E_SPACE_ID ?? null, plakyWebBase: env.PLAKY_WEB_BASE_URL ?? null,
  })),

  list: publicProcedure.output(z.array(migrationSummary)).query(async ({ ctx }) => {
    const rows = await ctx.db.select().from(migrations).orderBy(desc(migrations.id)).limit(50);
    return rows.map((r) => migrationSummary.parse(r));
  }),

  create: publicProcedure.input(z.object({ name: z.string().trim().min(1).max(80).default("monday to Plaky"), mondayToken: typedKey, plakyKey: typedKey, plakyWebBase: workspaceAddress }))
    .output(z.object({ migrationId: z.number() }).extend(info.shape)).mutation(async ({ ctx, input }) => {
      const keys = { mondayToken: input.mondayToken, plakyKey: input.plakyKey, plakyWebBase: input.plakyWebBase };
      const who = await whose(ctx, keys);
      const c = await record(ctx.db, who, keys);
      const migrationId = await createMigration(ctx.db, { connectionId: c.connectionId, name: input.name, plakySpaceId: env.PLAKY_E2E_SPACE_ID ?? null });
      return { migrationId, ...info.parse(c) };
    }),

  forget: migrationProcedure.input(z.object({ confirm: z.string().max(300) })).output(z.object({ erased: z.literal(true) })).mutation(async ({ ctx, input }) => {
    await getMigration(ctx.db, input.migrationId);
    const phrase = erasePhrase(input.migrationId);
    if (input.confirm.trim() !== phrase) throw new PreconditionError(`type "${phrase}" to confirm`);
    await forgetMigration(ctx.db, input.migrationId);
    return { erased: true as const };
  }),

  check: migrationProcedure.output(info).mutation(async ({ ctx, input }) => {
    const migration = await getMigration(ctx.db, input.migrationId);
    const who = await whose(ctx, await keysFor(ctx.db, input.migrationId));
    const conn = (await ctx.db.select().from(connections).where(eq(connections.id, migration.connectionId)).limit(1))[0]!;
    const legacy = conn.mondayAccountUid === null && conn.mondayUserUid === null;
    const same = conn.plakyUserId === who.connection.plakyUserId && (legacy
      ? conn.mondayAccountId === who.connection.mondayAccountId && conn.mondayUserId === who.connection.mondayUserId
      : conn.mondayAccountUid === who.connection.mondayAccountUid && conn.mondayUserUid === who.connection.mondayUserUid);
    if (!same) {
      throw new PreconditionError("the keys now answer for a different monday account or Plaky user than this migration was connected with");
    }
    if (legacy && who.connection.mondayAccountUid && who.connection.mondayUserUid) {
      await ctx.db.update(connections).set({ mondayAccountUid: who.connection.mondayAccountUid, mondayUserUid: who.connection.mondayUserUid }).where(eq(connections.id, migration.connectionId));
    }
    if (who.connection.mondayTier) await ctx.db.update(connections).set({ mondayTier: who.connection.mondayTier }).where(eq(connections.id, migration.connectionId));
    return info.parse({ account: who.account, user: who.user, zone: who.zone, plakyUser: who.plakyUser, checkedAt: Date.now() });
  }),

  get: migrationProcedure.output(z.object({ migration: migrationSummary.extend({ options: selectMigrationSchema.shape.options }), connection: z.object({ account: z.string(), user: z.string(), zone: z.string().nullable(), plakyUserId: z.number(), typedPlakyKey: z.boolean(), plakyWebBase: z.string().nullable() }) })).query(async ({ ctx, input }) => {
    const migration = await getMigration(ctx.db, input.migrationId);
    const conn = (await ctx.db.select().from(connections).where(eq(connections.id, migration.connectionId)).limit(1))[0]!;
    return {
      migration: { ...migrationSummary.parse(migration), options: migration.options },
      connection: { account: conn.mondayAccountId, user: conn.mondayUserId, zone: conn.mondayTimeZone, plakyUserId: conn.plakyUserId, typedPlakyKey: conn.plakyKey !== null, plakyWebBase: conn.plakyWebBase },
    };
  }),
});
