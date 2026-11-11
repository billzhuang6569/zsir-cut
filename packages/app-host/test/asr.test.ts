import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createAsrKeychain } from "../../core/src/asr-keychain.ts";
import { AsrSettings, asrTestReason } from "../src/asr.js";
import {
  AsrModels,
  alignName,
  type ModelRequest,
  type ModelResponse,
  modelNames,
  supportedAsr,
} from "../src/asr-models.js";
import { DesktopPreferences } from "../src/preferences.js";

const directories: string[] = [];
beforeEach(() => {
  for (const key of Object.keys(process.env)) {
    if (/^(https_proxy|http_proxy|all_proxy|no_proxy)$/i.test(key)) vi.stubEnv(key, undefined);
  }
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true });
});
it("defaults missing ASR preferences without migrating and persists partial mode/model patches", async () => {
  const directory = await mkdtemp(join(tmpdir(), "asr-prefs-"));
  directories.push(directory);
  const prefs = new DesktopPreferences(directory);
  await prefs.load();
  expect(prefs.get().prefs).toHaveProperty("asr.mode", "local");
  await prefs.set({ asr: { mode: "api" } });
  expect(prefs.get().prefs).toHaveProperty("asr.mode", "api");
  const stored = JSON.parse(await readFile(join(directory, "desktop.json"), "utf8"));
  expect(stored.version).toBe(2);
  delete stored.asr;
  await writeFile(join(directory, "desktop.json"), JSON.stringify(stored));
  await prefs.load();
  expect(prefs.get().prefs).toHaveProperty("asr.mode", "local");
  expect(prefs.warning).toBeUndefined();
});

function response(body: string | Buffer, statusCode = 200, headers = {}): ModelResponse {
  return Object.assign(Readable.from([Buffer.from(body)]), { statusCode, headers });
}
const contents = { "config.json": Buffer.from("{}"), "model.safetensors": Buffer.from("weights") };
const listing = Object.entries(contents).map(([path, body]) => ({
  type: "file",
  path,
  size: body.length,
  ...(path.endsWith("safetensors")
    ? { lfs: { size: body.length, oid: createHash("sha256").update(body).digest("hex") } }
    : {}),
}));
async function folder() {
  const directory = await mkdtemp(join(tmpdir(), "asr-test-"));
  directories.push(directory);
  return directory;
}
function modelHttp(
  handler?: (url: string, signal: AbortSignal, offset: number) => Promise<ModelResponse> | undefined,
): ModelRequest {
  return vi.fn(async (url, signal, offset = 0) => {
    const special = handler?.(url, signal, offset);
    if (special) return special;
    if (url.includes("/tree/")) return response(JSON.stringify(listing));
    const name = url.split("/").at(-1) as keyof typeof contents;
    const body = contents[name];
    return offset
      ? response(body.subarray(offset), 206, { "content-range": `bytes ${offset}-${body.length - 1}/${body.length}` })
      : response(body);
  });
}
async function waitFor(models: AsrModels, state: string, id = "1.7b") {
  await vi.waitFor(async () => expect((await models.status()).find((item) => item.id === id)?.state).toBe(state));
}
it("resumes partial files, verifies SHA-256, reuses the aligner and deletes it only after the last model", async () => {
  const directory = await folder();
  await mkdir(join(directory, `${modelNames["1.7b"]}.partial`), { recursive: true });
  await writeFile(join(directory, `${modelNames["1.7b"]}.partial/model.safetensors`), "wei");
  const http = modelHttp();
  const models = new AsrModels(vi.fn(), directory, http);
  try {
    await models.download("1.7b");
    await waitFor(models, "ready");
    expect(http).toHaveBeenCalledWith(
      expect.stringContaining("model.safetensors"),
      expect.any(AbortSignal),
      3,
      "",
      expect.any(Object),
    );
    expect(await readFile(join(directory, modelNames["1.7b"], "model.safetensors"), "utf8")).toBe("weights");
    vi.mocked(http).mockClear();
    await models.download("0.6b");
    await waitFor(models, "ready", "0.6b");
    expect(vi.mocked(http).mock.calls.every(([url]) => !url.includes(alignName))).toBe(true);
    await models.delete("1.7b");
    expect(await stat(join(directory, alignName))).toBeDefined();
    await models.delete("0.6b");
    await expect(stat(join(directory, alignName))).rejects.toThrow();
  } finally {
    await models.close();
  }
});
it("switches to the mirror on failure and removes files that fail checksum validation", async () => {
  const directory = await folder();
  const http = modelHttp(async (url) => {
    if (url.startsWith("https://huggingface.co")) throw new Error("offline");
    if (url.endsWith("model.safetensors")) return response("corrupt");
    return url.includes("/tree/") ? response(JSON.stringify(listing)) : response("{}");
  });
  const models = new AsrModels(vi.fn(), directory, http);
  try {
    await models.download("1.7b");
    await waitFor(models, "missing");
    expect((await models.status())[0]?.error).not.toBeNull();
    expect(vi.mocked(http).mock.calls.some(([url]) => url.startsWith("https://hf-mirror.com"))).toBe(true);
    await expect(stat(join(directory, `${modelNames["1.7b"]}.partial/model.safetensors`))).rejects.toThrow();
    await expect(stat(join(directory, modelNames["1.7b"]))).rejects.toThrow();
  } finally {
    await models.close();
  }
});
it("queues a second model, cancels the active stream, and preserves its resumable partial bytes", async () => {
  const directory = await folder();
  let flowing = false;
  const http = modelHttp((url, signal) => {
    if (!url.endsWith("model.safetensors") || flowing) return;
    flowing = true;
    return Promise.resolve(
      Object.assign(
        Readable.from(
          (async function* () {
            yield Buffer.from("wei");
            await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
            signal.throwIfAborted();
          })(),
        ),
        { statusCode: 200, headers: {} },
      ),
    );
  });
  const models = new AsrModels(vi.fn(), directory, http);
  try {
    await models.download("1.7b");
    await vi.waitFor(async () =>
      expect(await readFile(join(directory, `${modelNames["1.7b"]}.partial/model.safetensors`), "utf8")).toBe("wei"),
    );
    await models.download("0.6b");
    expect((await models.status())[1]?.state).toBe("queued");
    await models.cancel("1.7b");
    expect(await readFile(join(directory, `${modelNames["1.7b"]}.partial/model.safetensors`), "utf8")).toBe("wei");
    await waitFor(models, "ready", "0.6b");
    await models.download("1.7b");
    await waitFor(models, "ready");
  } finally {
    await models.close();
  }
});
it("uses a private Keychain service, keeps the key off argv, verifies writes and clears", async () => {
  let stored: string | null = null;
  const run = vi.fn(async (args: string[], input?: string) => {
    if (args[0] === "-i") {
      stored = input?.startsWith("delete") ? null : "test-secret";
      return { code: 0, stdout: "" };
    }
    return { code: stored ? 0 : 44, stdout: stored ? `${stored}\n` : "" };
  });
  const keychain = createAsrKeychain(run);
  await keychain.write("test-secret");
  expect(await keychain.read()).toBe("test-secret");
  expect(JSON.stringify(run.mock.calls.map(([args]) => args))).not.toContain("test-secret");
  expect(run.mock.calls[0]?.[1]).toContain("zsir-cut.volc-asr");
  await keychain.write(null);
  expect(await keychain.read()).toBeNull();
  await expect(keychain.write("bad\nkey")).rejects.toThrow("Invalid ASR key");
});
it("returns only key presence, sanitizes key failures, tests via the selected model and disables Windows", async () => {
  const directory = await folder();
  const prefs = new DesktopPreferences(directory);
  await prefs.load();
  const models = new AsrModels(vi.fn(), directory, modelHttp());
  const keychain = {
    read: vi.fn(async () => "private-key"),
    write: vi.fn(async () => {
      throw new Error("private-key");
    }),
  };
  const test = vi.fn(async () => ({ ok: true, audio_seconds: 5, used_seconds: 1, text: "测试" }));
  try {
    const settings = new AsrSettings(prefs, models, keychain, true, test);
    expect(JSON.stringify(await settings.handle("asr_status", {}))).not.toContain("private-key");
    await expect(settings.handle("asr_key_set", { key: "private-key" })).rejects.toThrow("无法保存 API Key");
    await prefs.set({ asr: { model: "0.6b" } });
    await settings.handle("asr_test", { mode: "api" });
    expect(test).toHaveBeenCalledWith("api", "0.6b");
    const windows = new AsrSettings(prefs, models, keychain, false, test);
    keychain.read.mockClear();
    expect(await windows.handle("asr_status", {})).toMatchObject({ supported: false, api_key_set: false });
    expect(keychain.read).not.toHaveBeenCalled();
    await expect(windows.handle("asr_test", { mode: "api" })).rejects.toThrow("这个版本的 Windows 版不能识别字幕");
    expect(supportedAsr("win32", "x64")).toBe(false);
    expect(supportedAsr("darwin", "x64")).toBe(false);
    expect(supportedAsr("darwin", "arm64")).toBe(true);
    expect(asrTestReason("E_ASR_CLOUD_AUTH", "45000010")).toBe("API Key 不对。检查后再测一次。");
    expect(asrTestReason("E_ASR_CLOUD_AUTH", "45000030")).toBe("这个账号没有开通豆包语音识别极速版。开通后再测一次。");
    expect(asrTestReason("E_ASR_CLOUD_NETWORK", "")).toBe("连不上火山引擎。检查网络后再测一次。");
  } finally {
    await models.close();
  }
});

it("requests cloud permission for API auto, while explicit local and local auto need none", async () => {
  const directory = await folder();
  vi.stubEnv("HOME", directory);
  vi.stubEnv("USERPROFILE", directory);
  vi.stubEnv("XDG_DATA_HOME", join(directory, "data"));
  const { desktopPreferencesDirectory } = await import("../../core/src/asr-settings.ts");
  const { parseProject } = await import("../../core/src/project/io.ts");
  const { Permissions } = await import("../src/permissions.js");
  const parsed = parseProject(
    await readFile(new URL("../../../examples/interview.zcut.json", import.meta.url), "utf8"),
  );
  if (!parsed.ok) throw new Error("fixture");
  const prefs = new DesktopPreferences(desktopPreferencesDirectory());
  await prefs.load();
  await prefs.set({ asr: { mode: "api" } });
  const prompts: { id: string }[] = [];
  const gate = new Permissions(() => (request) => prompts.push(request));
  const project = join(directory, "test.zcut.json");
  const pending = gate.request("transcribe", {}, project, async () => parsed.project);
  await vi.waitFor(() => expect(prompts).toHaveLength(1));
  await gate.answer({ id: prompts[0]?.id, answer: "once" });
  expect(await pending).toBeNull();
  expect(await gate.request("transcribe", { engine: "local" }, project, async () => parsed.project)).toBeNull();
  await prefs.set({ asr: { mode: "local" } });
  expect(await gate.request("transcribe", {}, project, async () => parsed.project)).toBeNull();
  expect(prompts).toHaveLength(1);
});

it("snapshots the saved proxy for each download and keeps active requests on that snapshot", async () => {
  const directory = await folder();
  const prefs = new DesktopPreferences(directory);
  await prefs.set({ network: { proxy: "http://localhost:7890" } });
  const http = modelHttp();
  const used: string[] = [];
  const request: ModelRequest = async (url, signal, offset, proxy) => {
    used.push(proxy ?? "");
    if (used.length === 1) await prefs.set({ network: { proxy: "http://localhost:7891" } });
    return http(url, signal, offset);
  };
  const models = new AsrModels(vi.fn(), directory, request, () => prefs.get().prefs.network.proxy);
  try {
    await models.download("1.7b");
    await waitFor(models, "ready");
    expect(used.length).toBeGreaterThan(1);
    expect(new Set(used)).toEqual(new Set(["http://localhost:7890"]));
    used.length = 0;
    await models.download("0.6b");
    await waitFor(models, "ready", "0.6b");
    expect(new Set(used)).toEqual(new Set(["http://localhost:7891"]));
  } finally {
    await models.close();
  }
});
