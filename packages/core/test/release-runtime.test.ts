import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { asrPythonPath } from "../src/asr-environment.ts";
import { parseProject } from "../src/project/io.ts";
import { invokeAsr } from "../src/transcribe.ts";
import { createVoiceKeychain, readVoiceKey } from "../src/voice-keychain.ts";

const platform = Object.getOwnPropertyDescriptor(process, "platform");
let directory: string;
afterEach(async () => {
  if (platform) Object.defineProperty(process, "platform", platform);
  vi.unstubAllEnvs();
  if (directory) await rm(directory, { recursive: true, force: true });
});
it("uses the user ASR environment only in packaged mode", async () => {
  directory = await mkdtemp(join(tmpdir(), "zcut-asr-env-"));
  vi.stubEnv("HOME", directory);
  vi.stubEnv("USERPROFILE", directory);
  expect(asrPythonPath("/worker", false)).toBe(join("/worker", ".venv/bin/python"));
  expect(asrPythonPath("/app/runtime/workers/asr", true)).toBe(join(directory, ".zsir-cut/asr/.venv/bin/python"));
  vi.stubEnv("ZCUT_PACKAGED", "1");
  expect(asrPythonPath("/worker")).toBe(join(directory, ".zsir-cut/asr/.venv/bin/python"));
});
it("explains missing ASR installation and unsupported Windows without starting Python", async () => {
  directory = await mkdtemp(join(tmpdir(), "zcut-asr-env-"));
  const parsed = parseProject(await readFile(new URL("../../../examples/minimal.zcut.json", import.meta.url), "utf8"));
  if (!parsed.ok) throw new Error("Invalid fixture");
  const run = () =>
    invokeAsr(
      parsed.project,
      { project: "test", media_id: "med_a" },
      join(directory, "result.json"),
      join(directory, "missing-python"),
      directory,
    );
  Object.defineProperty(process, "platform", { value: "darwin" });
  await expect(run()).rejects.toMatchObject({
    code: "E_ASR_MODEL_UNAVAILABLE",
    retryable: false,
    message: expect.stringContaining("python3.13 -m venv ~/.zsir-cut/asr/.venv"),
  });
  await expect(run()).rejects.toThrow("requirements.lock");
  Object.defineProperty(process, "platform", { value: "win32" });
  await expect(run()).rejects.toMatchObject({
    code: "E_UNSUPPORTED",
    message: expect.stringContaining("Windows 暂不支持本地语音识别"),
  });
});
it("allows reading settings on Windows, explains key storage and preserves environment-key support", async () => {
  Object.defineProperty(process, "platform", { value: "win32" });
  vi.stubEnv("ZSIR_FISH_API_KEY", "");
  const keychain = createVoiceKeychain();
  expect(await keychain.read()).toBeNull();
  await expect(keychain.write("secret")).rejects.toThrow("Windows 暂不支持保存配音密钥");
  vi.stubEnv("ZSIR_FISH_API_KEY", "environment-secret");
  expect(await readVoiceKey()).toBe("environment-secret");
});
