import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureEnvFile, isOurHealth, openerFor } from "./launch-lib";

const root = join(import.meta.dir, "..");
const inRoot = (...parts: string[]): string => join(root, ...parts);

function step(what: string, command: string[]): void {
  console.log(`\n${what}…`);
  const { status } = spawnSync(command[0]!, command.slice(1), { cwd: root, stdio: "inherit" });
  if (status !== 0) {
    console.error(`\nStopped: ${what.toLowerCase()} failed. The lines above say why.`);
    process.exit(1);
  }
}

function needNode(): void {
  const version = spawnSync("node", ["-v"], { encoding: "utf8" }).stdout?.trim().replace(/^v/, "") ?? "";
  const [major = 0, minor = 0] = version.split(".").map(Number);
  if (major > 20 || (major === 20 && minor >= 9)) return;
  console.error(`Node.js 20.9 or newer is needed${version ? ` (found ${version})` : ""}. Install it from https://nodejs.org and run this again.`);
  process.exit(1);
}

async function isOurs(port: number): Promise<boolean> {
  try {
    const answer = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(800) });
    return isOurHealth(await answer.json());
  } catch {
    return false;
  }
}

function isFree(port: number): boolean {
  try {
    Bun.listen({ hostname: "127.0.0.1", port, socket: { data() {} } }).stop(true);
    return true;
  } catch {
    return false;
  }
}

function openBrowser(url: string): void {
  const opener = openerFor(process.platform, Boolean(Bun.which("wslview")), url);
  const { status } = spawnSync(opener[0]!, opener.slice(1), { stdio: "ignore" });
  if (status !== 0) console.log(`Open ${url} in your browser.`);
}

const PORTS = Array.from({ length: 20 }, (_, i) => 3000 + i);

needNode();
for (const port of PORTS) {
  if (await isOurs(port)) {
    console.log(`Already running: http://localhost:${port}`);
    openBrowser(`http://localhost:${port}`);
    process.exit(0);
  }
}
const env = ensureEnvFile(inRoot(".env.example"), inRoot(".env"));
if (env.created) console.log(".env created from .env.example (readable by you only): the monday token and Plaky key can be set there, or pasted into the page's Connect form.");
if (env.note) console.log(env.note);
if (!existsSync(inRoot("node_modules"))) step("Installing", ["bun", "install", "--frozen-lockfile"]);
const BUILT = inRoot(".next", "built-from");
const code = (spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).stdout ?? "").trim() || (JSON.parse(readFileSync(inRoot("package.json"), "utf8")) as { version: string }).version;
if (!existsSync(BUILT) || readFileSync(BUILT, "utf8") !== code) {
  step("Building (about a minute, the first time and after an update)", ["bun", "run", "build:app"]);
  writeFileSync(BUILT, code);
}

const port = PORTS.find(isFree);
if (port === undefined) {
  console.error("Stopped: ports 3000 to 3019 are all in use.");
  process.exit(1);
}
const url = `http://localhost:${port}`;
console.log(`\nStarting on ${url}…`);
const app = Bun.spawn(["bun", "run", "start", "-p", String(port)], { cwd: root, stdio: ["inherit", "inherit", "inherit"] });
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => app.kill());

for (let tries = 0; tries < 120 && app.exitCode === null; tries++) {
  if (await isOurs(port)) {
    openBrowser(url);
    console.log(`\nRunning at ${url}. Keep this window open; press Ctrl+C to stop.`);
    break;
  }
  await Bun.sleep(500);
}
const exitCode = await app.exited;
spawnSync("bun", ["run", "scripts/purge-finished.ts"], { cwd: root, stdio: "inherit" });
process.exit(exitCode);
