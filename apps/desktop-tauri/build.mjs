import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const result = spawnSync(
  process.execPath,
  [
    createRequire(import.meta.url).resolve("@tauri-apps/cli/tauri.js"),
    "build",
    "--config",
    "src-tauri/tauri.release.conf.json",
    ...process.argv.slice(2),
  ],
  { env: { ...process.env, CI: "true" }, stdio: "inherit", windowsHide: true },
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
