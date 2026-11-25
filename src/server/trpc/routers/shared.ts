import { baseBoardId } from "@/server/pipeline/names";
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "@/db/client";
import { migrations } from "@/db/schema";
import { clientsFor, type Clients } from "@/server/jobs/runner";
import { keysFor } from "@/server/pipeline/store";
import type { PipelineEvent } from "@/server/pipeline/events";
import type { Deps } from "@/server/pipeline/migration";
import type { Context } from "../context";
import { env } from "@/server/env";
import { publicProcedure } from "../init";
import { redactString } from "@/server/redact";

const migrationInput = z.object({ migrationId: z.number().int().positive() });

export const migrationProcedure = publicProcedure.input(migrationInput).use(async ({ ctx, input, next }) => {
  const found = await ctx.db.select({ id: migrations.id }).from(migrations).where(eq(migrations.id, input.migrationId)).limit(1);
  if (!found[0]) throw new TRPCError({ code: "NOT_FOUND", message: `There is no migration ${input.migrationId}: it was erased, or the address is wrong.` });
  return next();
});

export function collect(): { log: (e: PipelineEvent) => void; messages: () => { level: string; code: string; message: string; board?: string }[] } {
  const events: PipelineEvent[] = [];
  return {
    log: (e) => void events.push(e),
    messages: () => events.filter((e) => e.level === "warn" || e.level === "error").map(({ level, code, message, board }) => ({ level, code, message: redactString(message), ...(board ? { board } : {}) })),
  };
}

export const plakyBoardUrl = (space: number, board: number): string => `${env.PLAKY_WEB_BASE_URL ?? "https://app.plaky.com"}/spaces/${space}/boards/${board}`;

export async function plakyLinksFor(db: Db, migrationId: number): Promise<typeof plakyBoardUrl | null> {
  const { plakyKey, plakyWebBase } = await keysFor(db, migrationId);
  if (plakyWebBase) return (space, board) => `${plakyWebBase}/spaces/${space}/boards/${board}`;
  return plakyKey ? null : plakyBoardUrl;
}

export function mondayItemUrl(slug: string | null | undefined, entry: string | null | undefined, item: unknown): string | null {
  const board = entry ? baseBoardId(entry) : entry;
  if (!slug || !/^[a-z0-9][a-z0-9-]*$/i.test(slug) || !board || !/^\d+$/.test(board) || typeof item !== "string" || !/^\d+$/.test(item)) return null;
  return `https://${slug}.monday.com/boards/${board}/pulses/${item}`;
}

export async function clientsOf(ctx: Pick<Context, "db" | "clients">, migrationId: number): Promise<Clients> {
  return ctx.clients ? ctx.clients(await keysFor(ctx.db, migrationId)) : clientsFor(ctx.db, migrationId);
}

export async function depsFor(ctx: Pick<Context, "db" | "clients">, migrationId: number, log: Deps["log"]): Promise<Deps> {
  const clients = await clientsOf(ctx, migrationId);
  return { db: ctx.db, migrationId, monday: clients.monday(), plaky: clients.plaky(), log };
}
