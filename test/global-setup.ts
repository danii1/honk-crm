import { execSync } from "node:child_process";
import path from "node:path";

/** Build the SPA + worker before the worker tests so dashboard assertions exercise the real client assets. */
export default function globalSetup() {
  execSync("bun run build", { cwd: path.resolve(import.meta.dirname, ".."), stdio: "pipe" });
}
