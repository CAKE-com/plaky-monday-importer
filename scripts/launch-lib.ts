import { chmodSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";

export function openerFor(platform: NodeJS.Platform, hasWslview: boolean, url: string): string[] {
  if (platform === "darwin") return ["open", url];
  if (platform === "win32") return ["cmd", "/c", "start", "", url];
  return hasWslview ? ["wslview", url] : ["xdg-open", url];
}

export function ensureEnvFile(example: string, target: string): { created: boolean; note?: string } {
  if (!existsSync(target)) {
    writeFileSync(target, readFileSync(example), { mode: 0o600, flag: "wx" });
    chmodSync(target, 0o600);
    return { created: true };
  }
  if (process.platform !== "win32" && (statSync(target).mode & 0o077) !== 0) {
    return { created: false, note: ".env can be read by other users of this computer and holds keys: run `chmod 600 .env` to keep it to yourself." };
  }
  return { created: false };
}

const APP_NAME = "monday-to-plaky-migrator";

export function isOurHealth(body: unknown): boolean {
  return typeof body === "object" && body !== null && (body as { app?: unknown }).app === APP_NAME && typeof (body as { migrations?: unknown }).migrations === "number";
}
