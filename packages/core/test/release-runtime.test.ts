import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { asrPythonPath } from "../src/asr-environment.ts";
import { dispatch } from "../src/dispatch.ts";
import { parseProject } from "../src/project/io.ts";
import { validateEnvelope } from "../src/schema.ts";
import { invokeAsr } from "../src/transcribe.ts";
import { createVoiceKeychain, readVoiceKey } from "../src/voice-keychain.ts";

const platform = Object.getOwnPropertyDescriptor(process, "platform");
let directory: string;
afterEach(async () => {
  if (platform) Object.defineProperty(process, "platform", platform);
  vi.unstubAllEnvs();
  if (directory) await rm(directory, { recursive: true, force: true });
});
it("uses bundled Python only in packaged mode", async () => {
  directory = await mkdtemp(join(tmpdir(), "zcut-asr-env-"));
  expect(asrPythonPath("/worker", false)).toBe(join("/worker", ".venv/bin/python"));
  expect(asrPythonPath("/app/runtime/workers/asr", true)).toBe(join("/app/runtime/python/bin/python3"));
  vi.stubEnv("ZCUT_PACKAGED", "1");
  expect(asrPythonPath("/app/runtime/workers/asr")).toBe(join("/app/runtime/python/bin/python3"));
});
it("reports missing bundled Python and unsupported Windows without starting Python", async () => {
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
    message: expect.stringContaining("没有找到本地识别环境"),
  });

  Object.defineProperty(process, "platform", { value: "win32" });
  await expect(run()).rejects.toMatchObject({
    code: "E_ASR_MODEL_UNAVAILABLE",
    message: "这个版本的 Windows 版不能识别字幕",
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
it("rejects Windows transcription with the ASR reason without queuing a worker", async () => {
  directory = await mkdtemp(join(tmpdir(), "zcut-asr-env-"));
  const project = join(directory, "test.zcut.json");
  await writeFile(project, await readFile(new URL("../../../examples/minimal.zcut.json", import.meta.url)));
  Object.defineProperty(process, "platform", { value: "win32" });
  const result = await dispatch("transcribe", {
    project,
    media_id: "med_a",
    base_revision: "rev_example_1",
    idempotency_key: "windows-asr",
    author: { kind: "agent", name: "test" },
  });
  expect(result.status).toBe("failed");
  expect(result.error).toMatchObject({
    code: "E_INTERNAL",
    details: { code: "E_ASR_MODEL_UNAVAILABLE" },
    message: "这个版本的 Windows 版不能识别字幕",
  });
  expect(result.result).toBeNull();
  expect(validateEnvelope(result).valid).toBe(true);
});
it.skipIf(process.platform === "win32")(
  "runs packaged ASR from its writable output directory with worker imports and no bytecode",
  async () => {
    directory = await mkdtemp(join(tmpdir(), "zcut-asr-env-"));
    vi.stubEnv("HOME", directory);
    vi.stubEnv("ZCUT_PACKAGED", "1");
    const worker = join(directory, "app/workers/asr");
    const output = join(directory, "job");
    await mkdir(worker, { recursive: true });
    await mkdir(output);
    const python = join(directory, "python");
    await writeFile(
      python,
      `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv;
fs.writeFileSync(args[args.indexOf('--out') + 1], JSON.stringify({
  schema: 'zsir-cut/asr-error', code: 'E_ASR_MODEL_UNAVAILABLE', retryable: false,
  message: JSON.stringify({cwd: process.cwd(), imports: process.env.PYTHONPATH, bytecode: process.env.PYTHONDONTWRITEBYTECODE})
}));
`,
      { mode: 0o755 },
    );
    const parsed = parseProject(
      await readFile(new URL("../../../examples/minimal.zcut.json", import.meta.url), "utf8"),
    );
    if (!parsed.ok) throw new Error("Invalid fixture");
    await expect(
      invokeAsr(
        parsed.project,
        { project: join(directory, "test"), media_id: "med_a" },
        join(output, "result.json"),
        python,
        worker,
      ),
    ).rejects.toMatchObject({ code: "E_ASR_MODEL_UNAVAILABLE" });
    const result = JSON.parse(await readFile(join(output, "result.json"), "utf8"));
    const environment = JSON.parse(result.message);
    expect(environment.cwd).toBe(await realpath(output));
    expect(environment.imports.split(":")[0]).toBe(worker);
    expect(environment.bytecode).toBe("1");
  },
);
