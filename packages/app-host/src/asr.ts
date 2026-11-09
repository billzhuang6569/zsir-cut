import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { z } from "zod";
import type { AsrKeychain } from "../../core/dist/index.js";
import { type AsrModels, asrMemory, supportedAsr } from "./asr-models.js";
import type { DesktopPreferences } from "./preferences.js";
import { hostPath } from "./runtime.js";

const {
  createAsrKeychain,
  runAsrWorker,
  asrPythonPath,
  AsrError,
  recommendedAsrModel,
}: typeof import("../../core/dist/index.js") = await import(
  new URL(import.meta.url.endsWith(".ts") ? "../../core/src/index.ts" : "../../core/dist/index.js", import.meta.url)
    .href
);
const execute = promisify(execFile);
export const ASR_VERBS = [
  "asr_status",
  "asr_key_set",
  "asr_model_download",
  "asr_model_cancel",
  "asr_model_delete",
  "asr_test",
];
const modelRequest = z.strictObject({ model: z.enum(["1.7b", "0.6b"]) });
const modeRequest = z.strictObject({ mode: z.enum(["local", "api"]) });
export const asrTestReason = (code: string, message: string) => {
  if (message.includes("45000010")) return "API Key 不对。检查后再测一次。";
  if (message.includes("45000030")) return "这个账号没有开通豆包语音识别极速版。开通后再测一次。";
  if (code === "E_ASR_CLOUD_NETWORK") return "连不上火山引擎。检查网络后再测一次。";
  if (code === "E_ASR_CLOUD_AUTH") return "API Key 不对。检查后再测一次。";
  return "模型没能运行。可以换「省内存」或 API 识别。";
};
export async function testAsr(mode: "local" | "api", model: "1.7b" | "0.6b") {
  const directory = await mkdtemp(join(tmpdir(), "zsir-asr-test-"));
  try {
    const audio = join(directory, "test.aiff");
    try {
      await execute("say", ["-v", "Tingting", "-o", audio, "今天我们来试一下字幕识别，看看能不能听清楚这句话。"], {
        env: { ...process.env, PATH: hostPath() },
        windowsHide: true,
      });
    } catch {
      return { ok: false, code: "E_ASR_INPUT", reason: "无法生成测试语音。请检查 Tingting 语音是否可用。" };
    }
    const out = join(directory, "result.json");
    const worker = fileURLToPath(new URL("../../../workers/asr/", import.meta.url));
    const result = await runAsrWorker(
      [
        "-m",
        "zsir_asr",
        "transcribe",
        "--input",
        audio,
        "--channels",
        "0",
        "--language",
        "zh",
        "--engine",
        mode === "api" ? "cloud" : "local",
        "--model",
        model,
        "--out",
        out,
      ],
      out,
      asrPythonPath(worker),
      worker,
      true,
    );
    const text = result.tokens.map((token) => token.text).join("");
    return text.trim()
      ? { ok: true, audio_seconds: result.input.duration_ms / 1000, used_seconds: result.runtime.seconds, text }
      : { ok: false, code: "E_ASR_INPUT", reason: "没有识别出文字。请再测一次。" };
  } catch (error) {
    const code = error instanceof AsrError ? error.code : "E_ASR_INTERNAL";
    return { ok: false, code, reason: asrTestReason(code, error instanceof AsrError ? error.message : "") };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
export class AsrSettings {
  constructor(
    private prefs: DesktopPreferences,
    private models: AsrModels,
    private keychain: AsrKeychain = createAsrKeychain(),
    private supported = supportedAsr(),
    private test = testAsr,
  ) {}
  async handle(verb: string, request: unknown) {
    if (verb === "asr_status") {
      z.strictObject({}).parse(request);
      return {
        supported: this.supported,
        memory_bytes: asrMemory(),
        recommended: recommendedAsrModel(),
        models: await this.models.status(),
        api_key_set: this.supported && Boolean(await this.keychain.read()),
      };
    }
    if (!this.supported) throw new Error("这个版本的 Windows 版不能识别字幕");
    if (verb === "asr_key_set") {
      const parsed = z.strictObject({ key: z.string().min(1).nullable() }).safeParse(request);
      if (!parsed.success) throw new Error("API Key 无效");
      try {
        await this.keychain.write(parsed.data.key);
      } catch {
        throw new Error("无法保存 API Key");
      }
      return null;
    }
    if (verb === "asr_test") {
      const { mode } = modeRequest.parse(request);
      return this.test(mode, this.prefs.get().prefs.asr.model);
    }
    const { model } = modelRequest.parse(request);
    if (verb === "asr_model_download") await this.models.download(model);
    else if (verb === "asr_model_cancel") await this.models.cancel(model);
    else if (verb === "asr_model_delete") await this.models.delete(model);
    return null;
  }
}
