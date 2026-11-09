import { stat, writeFile } from "node:fs/promises";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { testAsr } from "../src/asr.js";

vi.mock("../../core/src/asr-keychain.ts", () => ({ readAsrKey: vi.fn(async () => "probe-secret") }));
vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  return {
    ...original,
    execFile: (
      program: string,
      args: string[],
      options: { env: NodeJS.ProcessEnv },
      callback: (error: Error | null, stdout: string, stderr: string) => void,
    ) => {
      calls.push({ program, args, env: options.env });
      if (program === "say") {
        callback(sayUnavailable ? new Error("say missing") : null, "", "");
        return;
      }
      const out = args[args.indexOf("--out") + 1];
      void writeFile(out ?? "", JSON.stringify(output)).then(() => callback(null, "", ""));
    },
  };
});
let calls: { program: string; args: string[]; env: NodeJS.ProcessEnv }[];
let sayUnavailable = false;
let output: Record<string, unknown>;
beforeEach(() => {
  calls = [];
  sayUnavailable = false;
  output = {
    schema: "zsir-cut/asr-result",
    schema_version: "0.1",
    input: { duration_ms: 5000 },
    tokens: [{ text: "今天我们来试一下字幕识别。" }],
    runtime: { seconds: 1.2 },
  };
});
afterEach(() => vi.unstubAllEnvs());
it.each(["local", "api"] as const)(
  "synthesizes Tingting and uses the normal %s worker without project writes or caching",
  async (mode) => {
    expect(await testAsr(mode, "0.6b")).toEqual({
      ok: true,
      audio_seconds: 5,
      used_seconds: 1.2,
      text: "今天我们来试一下字幕识别。",
    });
    expect(calls[0]?.args).toEqual([
      "-v",
      "Tingting",
      "-o",
      expect.any(String),
      "今天我们来试一下字幕识别，看看能不能听清楚这句话。",
    ]);
    const worker = calls[1];
    expect(worker?.args).toContain("0.6b");
    expect(worker?.args).toContain(mode === "api" ? "cloud" : "local");
    expect(worker?.env.ZSIR_ASR_NO_CACHE).toBe("1");
    expect(worker?.args).not.toContain("probe-secret");
    expect(worker?.env.ZSIR_VOLC_API_KEY).toBe(mode === "api" ? "probe-secret" : "");
    const audio = calls[0]?.args[3];
    await expect(stat(audio ?? "")).rejects.toThrow();
  },
);
it("reports unavailable say without invoking a worker", async () => {
  sayUnavailable = true;
  expect(await testAsr("api", "1.7b")).toMatchObject({
    ok: false,
    code: "E_ASR_INPUT",
    reason: "无法生成测试语音。请检查 Tingting 语音是否可用。",
  });
  expect(calls).toHaveLength(1);
});
it.each([
  ["E_ASR_CLOUD_AUTH", "45000010 probe-secret", "API Key 不对。检查后再测一次。"],
  ["E_ASR_CLOUD_AUTH", "45000030 probe-secret", "这个账号没有开通豆包语音识别极速版。开通后再测一次。"],
  ["E_ASR_CLOUD_NETWORK", "probe-secret", "连不上火山引擎。检查网络后再测一次。"],
  ["E_ASR_OOM", "probe-secret", "模型没能运行。可以换「省内存」或 API 识别。"],
])("maps %s (%s) without leaking credentials", async (code, message, reason) => {
  output = { schema: "zsir-cut/asr-error", schema_version: "0.1", code, message };
  const result = await testAsr("api", "1.7b");
  expect(result).toEqual({ ok: false, code, reason });
  expect(JSON.stringify(result)).not.toContain("probe-secret");
});
