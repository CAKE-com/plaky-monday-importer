import { lstatSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";

import { normalizeWebAddress, PLAKY_WEB_ADDRESS, PLAKY_WEB_ADDRESS_HINT } from "@/lib/web-address";
export { normalizeWebAddress, PLAKY_WEB_ADDRESS, PLAKY_WEB_ADDRESS_HINT };

function namesAFile(url: string): boolean {
  const [path = "", query = ""] = url.slice("file:".length).split("?", 2);
  return path.trim() !== "" && !path.includes(":memory:") && !/(^|&)mode=memory(&|$)/.test(query);
}

const serverEnvSchema = z.object({
  DATABASE_URL: z.string().min(1).default("file:./data/monday-to-plaky-migrator.db")
    .refine((v) => v.startsWith("file:"), "must be a file: URL, such as file:./data/monday-to-plaky-migrator.db")
    .refine((v) => !v.startsWith("file:") || namesAFile(v), "must name a database file; an empty or in-memory database keeps nothing once the server stops"),
  MONDAY_API_TOKEN: z.string().min(1).optional(),
  PLAKY_API_KEY: z.string().min(1).optional(),
  PLAKY_WEB_BASE_URL: z.string().transform(normalizeWebAddress).refine((v) => PLAKY_WEB_ADDRESS.test(v), PLAKY_WEB_ADDRESS_HINT).optional(),
  PLAKY_E2E_SPACE_ID: z.coerce.number().int().positive().optional(),
  NODE_ENV: z.string().optional(),
});

export type ServerEnv = z.infer<typeof serverEnvSchema>;

export function parseServerEnv(source: Record<string, string | undefined>): ServerEnv {
  const present = Object.fromEntries(Object.entries(source).filter(([, value]) => value !== ""));
  const result = serverEnvSchema.safeParse(present);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
    throw new Error(`Invalid server environment: ${issues.join("; ")}`);
  }
  return result.data;
}

export function assertEnvFileNotSymlink(path: string = resolve(process.cwd(), ".env")): void {
  let isLink = false;
  try {
    isLink = lstatSync(path).isSymbolicLink();
  } catch {
    return;
  }
  if (isLink) throw new Error(`.env: ${path} is a symlink; copy the file instead`);
}

export function startupRefusal(source: Record<string, string | undefined>, envFile?: string): string | null {
  try {
    assertEnvFileNotSymlink(envFile);
    const parsed = parseServerEnv(source);
    if (parsed.NODE_ENV === "production" && parsed.PLAKY_E2E_SPACE_ID !== undefined) {
      return "Cannot start: PLAKY_E2E_SPACE_ID: names a Plaky space the E2E may wipe; not allowed in production (NODE_ENV=production): unset it, or set NODE_ENV=test for a test server";
    }
    return null;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `Cannot start: ${message.replace(/^Invalid server environment: /, "").replace(/\s+/g, " ")}`;
  }
}
