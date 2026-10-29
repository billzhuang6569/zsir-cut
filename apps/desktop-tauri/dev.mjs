import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const args = process.argv.slice(2).filter((arg) => arg !== "--");
if (args.length > 1) {
  console.error("用法：pnpm desktop:dev -- <工程路径>");
  process.exit(1);
}
const env = {
  ...process.env,
  ZCUT_PROJECT: args[0] || process.env.ZCUT_PROJECT ? resolve(args[0] || process.env.ZCUT_PROJECT) : "",
};
for (const args of [["typecheck"], ["--filter", "@zsir-cut/desktop-tauri", "dev"]]) {
  const result = spawnSync("pnpm", args, { env, stdio: "inherit" });
  if (result.error) console.error("桌面版启动失败：", result.error.message);
  if (result.status !== 0) process.exit(result.status ?? 1);
}
