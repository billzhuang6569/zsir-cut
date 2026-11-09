import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { readAsrKey } from "../src/asr-keychain.ts";
import { desktopPreferencesDirectory, recommendedAsrModel } from "../src/asr-settings.ts";
import { parseProject } from "../src/project/io.ts";
import { invokeAsr, runAsrWorker } from "../src/transcribe.ts";

vi.mock("../src/asr-keychain.ts", () => ({ readAsrKey: vi.fn(async () => "unit-secret-key") }));
const platform = Object.getOwnPropertyDescriptor(process, "platform");
let directory: string;
const capture: { args?: string[]; env?: NodeJS.ProcessEnv; options?: { cwd?: string } } = {};
vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  return {
    ...original,
    execFile: (
      _program: string,
      args: string[],
      options: { env: NodeJS.ProcessEnv; cwd?: string },
      callback: (error: Error | null, stdout: string, stderr: string) => void,
    ) => {
      capture.args = args;
      capture.env = options.env;
      capture.options = options;
      const out = args[args.indexOf("--out") + 1];
      void writeFile(out ?? "", JSON.stringify(workerResult)).then(() => callback(null, "", ""));
    },
  };
});
let workerResult: Record<string, unknown>;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "asr-mode-"));
  vi.stubEnv("HOME", directory);
  vi.stubEnv("USERPROFILE", directory);
  vi.stubEnv("XDG_DATA_HOME", join(directory, "data"));
  vi.stubEnv("ZCUT_PACKAGED", "0");
  vi.mocked(readAsrKey).mockReset().mockResolvedValue("unit-secret-key");
  workerResult = {
    schema: "zsir-cut/asr-result",
    schema_version: "0.1",
    input: {},
    asr: { name: "volcengine", model: "bigmodel", version: null },
    align: { name: "volcengine", model: "bigmodel", version: null },
    tokens: [],
    warnings: [],
    language: "zh",
  };
});
afterEach(async () => {
  if (platform) Object.defineProperty(process, "platform", platform);
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});
it("routes auto by persisted mode/model, keeps explicit local local, and passes a key only through worker env", async () => {
  Object.defineProperty(process, "platform", { value: "darwin" });
  const parsed = parseProject(
    await readFile(new URL("../../../examples/interview.zcut.json", import.meta.url), "utf8"),
  );
  if (!parsed.ok) throw new Error("fixture");
  const media = parsed.project.media[0];
  if (!media) throw new Error("media");
  const prefsDir = desktopPreferencesDirectory();
  await mkdir(prefsDir, { recursive: true });
  await writeFile(join(prefsDir, "desktop.json"), JSON.stringify({ asr: { mode: "api", model: "0.6b" } }));
  workerResult.input = {
    size_bytes: media.size_bytes,
    fingerprint: media.fingerprint.value,
    channels: [0],
    start_ms: 0,
    duration_ms: 1000,
  };
  const request = { project: join(directory, "project.json"), media_id: media.id };
  const output = await invokeAsr(parsed.project, request, join(directory, "out.json"), process.execPath, directory);
  expect(capture.args?.[capture.args.indexOf("--engine") + 1]).toBe("cloud");
  expect(capture.args?.[capture.args.indexOf("--model") + 1]).toBe("0.6b");
  expect(capture.env?.ZSIR_VOLC_API_KEY).toBe("unit-secret-key");
  expect(JSON.stringify(capture.args)).not.toContain("unit-secret-key");
  expect(JSON.stringify(output)).not.toContain("unit-secret-key");
  await invokeAsr(
    parsed.project,
    { ...request, engine: "local" },
    join(directory, "out.json"),
    process.execPath,
    directory,
  );
  expect(capture.args?.[capture.args.indexOf("--engine") + 1]).toBe("local");
  expect(capture.env?.ZSIR_VOLC_API_KEY).toBe("");
  expect(recommendedAsrModel(16 * 1024 ** 3)).toBe("0.6b");
  expect(recommendedAsrModel(16 * 1024 ** 3 + 1)).toBe("1.7b");
});
it("redacts upstream errors and disables cache for test workers in both development and packaged environments", async () => {
  workerResult = { schema: "zsir-cut/asr-error", code: "E_ASR_CLOUD_AUTH", message: "45000010 unit-secret-key" };
  const out = join(directory, "out.json");
  const args = ["-m", "zsir_asr", "transcribe", "--engine", "cloud", "--out", out];
  await expect(runAsrWorker(args, out, process.execPath, directory, true)).rejects.toThrow("45000010 [redacted]");
  expect(capture.env?.ZSIR_ASR_NO_CACHE).toBe("1");
  expect(capture.options?.cwd).toBe(directory);
  vi.stubEnv("ZCUT_PACKAGED", "1");
  await expect(runAsrWorker(args, out, process.execPath, "/bundle/workers/asr", true)).rejects.toThrow("[redacted]");
  expect(capture.env?.PYTHONPATH).toContain("/bundle/workers/asr");
  expect(capture.options?.cwd).toBe(directory);
});
