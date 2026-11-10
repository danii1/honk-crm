/** Set up an isolated local Worker/D1 instance for the screenshot fixture. */
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";

const directory = ".wrangler/screenshot-config";
const state = ".wrangler/screenshot-state";
if (process.argv.includes("--reset")) rmSync(state, { recursive: true, force: true });

const vars = readFileSync(".dev.vars", "utf8");
if (!/^BETTER_AUTH_SECRET=/m.test(vars)) throw new Error("Set BETTER_AUTH_SECRET in .dev.vars first");
const localVars = /^BETTER_AUTH_URL=/m.test(vars)
  ? vars.replace(/^BETTER_AUTH_URL=.*$/m, "BETTER_AUTH_URL=http://localhost:5174")
  : `${vars.trimEnd()}\nBETTER_AUTH_URL=http://localhost:5174\n`;

mkdirSync(directory, { recursive: true });
writeFileSync(`${directory}/.dev.vars`, localVars, { mode: 0o600 });
const config = JSON.parse(readFileSync("wrangler.jsonc", "utf8"));
config.main = "../../src/index.ts";
config.d1_databases[0].migrations_dir = "../../migrations";
config.vars.BETTER_AUTH_URL = "http://localhost:5174";
writeFileSync(`${directory}/wrangler.jsonc`, JSON.stringify(config, null, 2));

const migration = spawnSync("bunx", ["wrangler", "d1", "migrations", "apply", "DB", "--local", "--persist-to", state], { stdio: "inherit" });
if (migration.error) throw migration.error;
if (migration.status !== 0) process.exit(migration.status ?? 1);
console.log("Screenshot database ready. Start with: bunx vite --config vite.screenshots.config.ts");
