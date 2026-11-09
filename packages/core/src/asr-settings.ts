import { readFile } from "node:fs/promises";
import { homedir, totalmem } from "node:os";
import { join } from "node:path";

export const recommendedAsrModel = (memory = totalmem()) =>
  memory > 16 * 1024 ** 3 ? ("1.7b" as const) : ("0.6b" as const);
export const desktopPreferencesDirectory = () =>
  process.platform === "darwin"
    ? join(homedir(), "Library/Application Support/zsir-cut")
    : join(process.env.XDG_DATA_HOME || join(homedir(), ".local/share"), "zsir-cut");
export async function readAsrSettings() {
  let asr: Record<string, unknown> | undefined;
  try {
    asr = JSON.parse(await readFile(join(desktopPreferencesDirectory(), "desktop.json"), "utf8"))?.asr;
  } catch {}
  return {
    mode: asr?.mode === "api" ? ("api" as const) : ("local" as const),
    model: asr?.model === "1.7b" || asr?.model === "0.6b" ? asr.model : recommendedAsrModel(),
  };
}

export async function cloudFallbackEnabled() {
  try {
    return JSON.parse(await readFile(join(homedir(), ".zsir-cut/config.json"), "utf8"))?.asr?.cloud_fallback === true;
  } catch {
    return false;
  }
}
