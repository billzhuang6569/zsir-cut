// biome-ignore-all lint/style/noNonNullAssertion: Test fixtures establish the requested entries.

import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  createFishAudioClient,
  createVoiceKeychain,
  dispatch,
  type FishAudioClient,
  newId,
  parseProject,
  rational,
  readVoiceKey,
  readVoiceSettings,
  readVoices,
  serializeProject,
  VoiceError,
  type VoiceKeychain,
  type VoiceOptions,
  validateEnvelope,
  voiceDataPath,
  withVoiceLock,
  writeVoices,
} from "../src/index.ts";
import { readJob } from "../src/jobs.ts";
import { runVoiceJob, voiceJobPath } from "../src/voice-jobs.ts";

let home: string;
let client: FishAudioClient;
let keychain: VoiceKeychain;
let options: VoiceOptions;
const key = "test-voice-secret-never-persist";
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "zcut-voice-"));
  vi.stubEnv("HOME", home);
  vi.stubEnv("ZSIR_FISH_API_KEY", key);
  vi.stubEnv("HTTPS_PROXY", "");
  client = {
    generate: vi.fn(async () => new Uint8Array()),
    createModel: vi.fn(async () => ({ _id: "fish_model" })),
    updateModel: vi.fn(async () => {}),
    deleteModel: vi.fn(async () => {}),
  };
  keychain = {
    read: vi.fn(async () => {
      throw new Error("Real keychain must not be accessed");
    }),
    write: vi.fn(async () => {
      throw new Error("Real keychain must not be accessed");
    }),
  };
  options = {
    fishClient: client,
    voiceKeychain: keychain,
    probe: vi.fn(async () => ({
      streams: [
        {
          index: 0,
          codec_type: "audio",
          sample_rate: "44100",
          channels: 1,
          duration_ts: "441000",
          time_base: "1/44100",
        },
      ],
    })),
    voiceFfmpeg: vi.fn(async (args) => {
      await writeFile(args.at(-1)!, "fake wav");
    }),
  };
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(home, { recursive: true, force: true });
});
async function clone(extra: Record<string, unknown> = {}) {
  const output = await dispatch(
    "voice_clone",
    { name: "庄Sir", file: join(home, "input.wav"), ...extra },
    { ...options, worker: true },
  );
  expect(validateEnvelope(output)).toEqual({ valid: true, errors: [] });
  return output;
}
async function allLocalText() {
  const files = await readdir(home, { recursive: true, withFileTypes: true });
  return (
    await Promise.all(
      files.filter((file) => file.isFile()).map((file) => readFile(join(file.parentPath, file.name), "utf8")),
    )
  ).join("\n");
}

it("uses defaults, partial settings, deterministic sorted keys, no_op, and an environment key without accessing Keychain", async () => {
  const first = await dispatch("settings_get", {}, options);
  expect(first).toMatchObject({
    status: "no_op",
    receipt: null,
    result: {
      settings: { voice: { model: "s2.1-pro", provider: "fish_audio" }, network: { proxy: null } },
      voice_key_set: true,
    },
  });
  const input = { voice: { model: "drama-3" }, network: { proxy: "http://127.0.0.1:7897" }, voice_key: "ignored-key" };
  const changed = await dispatch("settings_set", input, options);
  expect(changed).toMatchObject({ status: "applied", changes: [{ entity: "settings", action: "updated" }] });
  expect(validateEnvelope(changed).valid).toBe(true);
  const bytes = await readFile(voiceDataPath("settings.json"), "utf8");
  expect(bytes).not.toContain("key");
  expect(Object.keys(JSON.parse(bytes))).toEqual(["network", "schema", "version", "voice"]);
  expect(Object.keys(JSON.parse(bytes).voice)).toEqual(["model", "provider"]);
  expect((await dispatch("settings_set", input, options)).status).toBe("no_op");
  await dispatch("settings_set", { network: { proxy: null } }, options);
  expect((await readVoiceSettings()).voice.model).toBe("drama-3");
  expect(keychain.read).not.toHaveBeenCalled();
  expect(keychain.write).not.toHaveBeenCalled();
  expect(await allLocalText()).not.toContain(key);
});

it("injects Keychain writes and deletes, returns presence only, and never serializes a key", async () => {
  vi.stubEnv("ZSIR_FISH_API_KEY", "");
  let stored: string | null = null;
  keychain = {
    read: vi.fn(async () => stored),
    write: vi.fn(async (value) => {
      stored = value;
    }),
  };
  const opts = { voiceKeychain: keychain };
  expect((await dispatch("settings_get", {}, opts)).result?.voice_key_set).toBe(false);
  for (const [value, status] of [
    [key, "applied"],
    [key, "no_op"],
    [null, "applied"],
    [null, "no_op"],
  ] as const) {
    const output = await dispatch("settings_set", { voice_key: value }, opts);
    expect(output.status).toBe(status);
    expect(JSON.stringify(output)).not.toContain(key);
  }
  expect(keychain.write).toHaveBeenCalledTimes(2);
  expect(await allLocalText()).not.toContain(key);
});

it("passes keys only on security stdin, quotes input and treats missing Keychain entries as unset", async () => {
  const run = vi.fn(async (_args: string[], _input?: string) => ({ code: 0, stdout: `${key}\n` }));
  const chain = createVoiceKeychain(run);
  expect(await chain.read()).toBe(key);
  expect(run.mock.calls[0]?.[0]).toEqual(["find-generic-password", "-s", "zsir-cut.fish-audio", "-a", "default", "-w"]);
  run.mockResolvedValueOnce({ code: 0, stdout: "" }).mockResolvedValueOnce({ code: 0, stdout: 'key"with\\quotes\n' });
  await chain.write('key"with\\quotes');
  expect(run.mock.calls[1]).toEqual([
    ["-i"],
    'add-generic-password -U -s zsir-cut.fish-audio -a default -w "key\\"with\\\\quotes"\n',
  ]);
  run.mockResolvedValueOnce({ code: 0, stdout: "" }).mockResolvedValueOnce({ code: 44, stdout: "" });
  await chain.write(null);
  expect(run.mock.calls[3]).toEqual([["-i"], "delete-generic-password -s zsir-cut.fish-audio -a default\n"]);
  await expect(chain.write("bad\ncommand")).rejects.toThrow("Invalid voice key");
  run.mockResolvedValueOnce({ code: 44, stdout: "" });
  expect(await chain.read()).toBeNull();
  run.mockResolvedValueOnce({ code: 1, stdout: key });
  await expect(chain.read()).rejects.toThrow("Cannot read voice Keychain entry");
  expect(
    await readVoiceKey({
      read: async () => {
        throw new Error("No");
      },
      write: async () => {},
    }),
  ).toBe(key);
});

it.each([
  { voice: { model: "unknown" } },
  { network: { proxy: "file:///tmp/a" } },
  { network: { proxy: "ftp://localhost" } },
  { voice_key: "a\nb" },
  { voice_key: "" },
  { project: "/tmp/project" },
  { base_revision: "rev_1" },
])("rejects invalid settings without writing: %j", async (input) => {
  expect(await dispatch("settings_set", input, options)).toMatchObject({
    status: "rejected",
    error: { code: "E_VALIDATION" },
  });
  expect(await readdir(home)).toEqual([]);
});

it("does not overwrite corrupt files and returns retryable E_IO on a two-second lock timeout", async () => {
  await mkdir(voiceDataPath(), { recursive: true });
  await writeFile(voiceDataPath("settings.json"), "bad");
  expect(await dispatch("settings_set", { voice: { model: "s2-pro" } }, options)).toMatchObject({
    status: "failed",
    error: { code: "E_IO", retryable: true },
  });
  expect(await readFile(voiceDataPath("settings.json"), "utf8")).toBe("bad");
  await rm(voiceDataPath("settings.json"));
  await writeFile(voiceDataPath("settings.json.lock"), "busy");
  const start = Date.now();
  expect(await dispatch("settings_set", { voice: { model: "s2-pro" } }, options)).toMatchObject({
    status: "failed",
    error: { code: "E_IO", retryable: true },
  });
  expect(Date.now() - start).toBeGreaterThanOrEqual(1950);
  await rm(voiceDataPath("settings.json.lock"));
  await writeFile(
    voiceDataPath("voices.json"),
    '{"schema":"zsir-cut/voices","version":1,"voices":[{"sample":"../../outside"}]}',
  );
  expect(await dispatch("voice_list", {}, options)).toMatchObject({ status: "failed", error: { code: "E_IO" } });
});

it("serializes concurrent settings and library writes without lost updates", async () => {
  await Promise.all([
    dispatch("settings_set", { voice: { model: "s2-pro" } }, options),
    dispatch("settings_set", { network: { proxy: "http://127.0.0.1:7897" } }, options),
  ]);
  expect(await readVoiceSettings()).toMatchObject({
    voice: { model: "s2-pro" },
    network: { proxy: "http://127.0.0.1:7897" },
  });
  await Promise.all([clone({ name: "one" }), clone({ name: "two" })]);
  expect(await readVoices()).toHaveLength(2);
  const bytes = await readFile(voiceDataPath("voices.json"), "utf8");
  await withVoiceLock("voices.json", async () => writeVoices(await readVoices()));
  expect(await readFile(voiceDataPath("voices.json"), "utf8")).toBe(bytes);
  expect((await readdir(voiceDataPath())).filter((name) => name.endsWith(".lock") || name.endsWith(".tmp"))).toEqual(
    [],
  );
});

it("clones a file into a mono 44.1kHz 16-bit WAV, retaining only the file name and a UUIDv7 voice id", async () => {
  const output = await clone({ text: "参考文字" });
  expect(output).toMatchObject({
    status: "applied",
    receipt: null,
    changes: [{ entity: "voice", action: "created" }],
    result: { voice: { source: { kind: "file", name: "input.wav" } }, warnings: [] },
  });
  const voice = (await readVoices())[0]!;
  expect(voice.id).toMatch(/^voc_[0-9a-f-]{14}7[0-9a-f-]+$/);
  expect(voice.sample).toBe(`voices/${voice.id}.wav`);
  expect(await readFile(voiceDataPath(voice.sample), "utf8")).toBe("fake wav");
  expect(client.createModel).toHaveBeenCalledWith({ name: "庄Sir", audio: Buffer.from("fake wav"), text: "参考文字" });
  expect(options.voiceFfmpeg).toHaveBeenCalledWith(
    expect.arrayContaining(["-ar", "44100", "-ac", "1", "-c:a", "pcm_s16le"]),
  );
  expect(JSON.stringify(output)).not.toContain(key);
  expect(await allLocalText()).not.toContain(key);
});

it.each([
  ["220499", "rejected", false],
  ["220500", "applied", false],
  ["2646000", "applied", false],
  ["2646001", "applied", true],
])("checks sample boundaries exactly at %s samples", async (samples, status, trimmed) => {
  options.probe = async () => ({
    streams: [
      { index: 0, codec_type: "audio", sample_rate: "44100", channels: 1, duration_ts: samples, time_base: "1/44100" },
    ],
  });
  const output = await clone();
  expect(output.status).toBe(status);
  if (status === "rejected") {
    expect(output.error?.code).toBe("E_VALIDATION");
    expect(options.voiceFfmpeg).not.toHaveBeenCalled();
    expect(client.createModel).not.toHaveBeenCalled();
  } else if (trimmed) {
    expect(output.result?.warnings).toEqual([{ code: "W_VOICE_SAMPLE_TRIMMED" }]);
    expect(options.voiceFfmpeg).toHaveBeenCalledWith(expect.arrayContaining(["-t", "60.000000000"]));
  } else expect(output.result?.warnings).toEqual([]);
});

it("extracts visible layer-2 transcript text only in the used media range, with explicit text taking precedence", async () => {
  const parsed = parseProject(
    await readFile(new URL("../../../fixtures/projects/std-25.zcut.json", import.meta.url), "utf8"),
  );
  if (!parsed.ok) throw new Error("Invalid fixture");
  const media = parsed.project.media[0]!;
  media.duration = rational(100n);
  media.audio = { sample_rate: rational(44100n), channels: 1 };
  const transcript = parsed.project.transcripts.find((t) => t.media_id === media.id)!;
  transcript.tokens = [
    {
      id: "tok_before",
      text: "前",
      state: "edited",
      align: { start: rational(0n), end: rational(1n), run: transcript.raw_runs[0]!.id },
    },
    {
      id: "tok_first",
      text: "修改后",
      heard: "原始",
      state: "edited",
      align: { start: rational(1n), end: rational(2n), run: transcript.raw_runs[0]!.id },
    },
    {
      id: "tok_hidden",
      text: "",
      state: "edited",
      align: { start: rational(2n), end: rational(3n), run: transcript.raw_runs[0]!.id },
    },
    {
      id: "tok_last",
      text: "文字",
      state: "edited",
      align: { start: rational(60n), end: rational(61n), run: transcript.raw_runs[0]!.id },
    },
    {
      id: "tok_after",
      text: "后",
      state: "edited",
      align: { start: rational(61n), end: rational(62n), run: transcript.raw_runs[0]!.id },
    },
  ];
  const project = join(home, "source.zcut.json");
  await writeFile(project, serializeProject(parsed.project));
  const ref = { project, media_id: media.id, source_start: "1s", duration: "70s" };
  const output = await dispatch("voice_clone", { name: "素材", media: ref }, { ...options, worker: true });
  expect(output.status).toBe("applied");
  expect(client.createModel).toHaveBeenLastCalledWith(expect.objectContaining({ text: "修改后文字" }));
  expect(output.result?.voice).toMatchObject({
    source: { kind: "media", project: parsed.project.id, media_id: media.id, source_start: "1s", duration: "70s" },
  });
  await dispatch("voice_clone", { name: "素材", media: ref, text: "指定文字" }, { ...options, worker: true });
  expect(client.createModel).toHaveBeenLastCalledWith(expect.objectContaining({ text: "指定文字" }));
  await dispatch("voice_clone", { name: "素材", media: ref, text: "" }, { ...options, worker: true });
  expect(client.createModel).toHaveBeenLastCalledWith(expect.not.objectContaining({ text: expect.anything() }));
});

it("cleans samples and leaves the library unchanged on upstream or conversion failure", async () => {
  const first = await clone();
  expect(first.ok).toBe(true);
  const bytes = await readFile(voiceDataPath("voices.json"), "utf8");
  vi.mocked(client.createModel).mockRejectedValueOnce(
    new VoiceError("E_VOICE_UPSTREAM", `upstream echoed ${key}`, true),
  );
  const failed = await clone();
  expect(failed).toMatchObject({ status: "failed", error: { code: "E_VOICE_UPSTREAM", retryable: true } });
  expect(JSON.stringify(failed)).not.toContain(key);
  options.voiceFfmpeg = async (args) => {
    await writeFile(args.at(-1)!, "partial");
    throw new Error(key);
  };
  expect((await clone()).error?.code).toBe("E_IO");
  expect(await readFile(voiceDataPath("voices.json"), "utf8")).toBe(bytes);
  expect(await readdir(voiceDataPath("voices"))).toHaveLength(1);
});

it("rejects missing auth and invalid clone inputs before queuing or creating files", async () => {
  vi.stubEnv("ZSIR_FISH_API_KEY", "");
  options.voiceKeychain = { read: async () => null, write: async () => {} };
  expect(await dispatch("voice_clone", { name: "名字", file: join(home, "source.wav") }, options)).toMatchObject({
    status: "rejected",
    error: { code: "E_VOICE_AUTH", retryable: false },
  });
  for (const input of [
    { name: " ", file: "/file" },
    { name: "名字", file: "relative" },
    { name: "名字" },
    { name: "名字", file: "/file", media: {} },
    { name: "名".repeat(41), file: "/file" },
  ])
    expect((await dispatch("voice_clone", input, options)).status).toBe("rejected");
  expect(await readdir(home)).toEqual([]);
});

it("renames and deletes remotely first; remote failure leaves local metadata and sample unchanged", async () => {
  await clone();
  const voice = (await readVoices())[0]!;
  const input = { ops: [{ op: "rename", id: voice.id, name: "新名字" }] };
  vi.mocked(client.updateModel).mockRejectedValueOnce(new VoiceError("E_VOICE_AUTH", "Unauthorized"));
  expect((await dispatch("voice_edit", input, options)).error?.code).toBe("E_VOICE_AUTH");
  expect((await readVoices())[0]!.name).toBe("庄Sir");
  expect((await dispatch("voice_edit", input, options)).status).toBe("applied");
  expect(client.updateModel).toHaveBeenCalledWith("fish_model", "新名字");
  expect((await dispatch("voice_edit", input, options)).status).toBe("no_op");
  vi.mocked(client.deleteModel).mockRejectedValueOnce(new VoiceError("E_VOICE_UPSTREAM", "Failed", true));
  const deletion = { ops: [{ op: "delete", id: voice.id }] };
  expect((await dispatch("voice_edit", deletion, options)).status).toBe("failed");
  expect(await readFile(voiceDataPath(voice.sample), "utf8")).toBe("fake wav");
  expect((await dispatch("voice_edit", deletion, options)).status).toBe("applied");
  expect(client.deleteModel).toHaveBeenCalledWith("fish_model");
  expect(await readVoices()).toEqual([]);
  expect(await readdir(voiceDataPath("voices"))).toEqual([]);
  expect(await dispatch("voice_edit", deletion, options)).toMatchObject({
    status: "rejected",
    error: { code: "E_NOT_FOUND" },
  });
});

it("validates all voice operations before any upstream call", async () => {
  await clone();
  const voice = (await readVoices())[0]!;
  for (const bad of [
    { op: "rename", id: voice.id, name: " " },
    { op: "unknown", id: voice.id },
    { op: "delete", id: newId("voc_") },
  ]) {
    expect(
      (await dispatch("voice_edit", { ops: [{ op: "rename", id: voice.id, name: "changed" }, bad] }, options)).status,
    ).toBe("rejected");
    expect(client.updateModel).not.toHaveBeenCalled();
    expect((await readVoices())[0]!.name).toBe("庄Sir");
  }
});

it("queues global jobs, executes the injected worker and exposes a sanitized job_status summary", async () => {
  let path = "";
  const accepted = await dispatch(
    "voice_clone",
    { name: "长任务", file: join(home, "source.wav") },
    {
      ...options,
      launchVoiceJob: async (file) => {
        path = file;
      },
    },
  );
  expect(accepted).toMatchObject({ status: "accepted", result: { job_id: expect.stringMatching(/^job_/) } });
  expect(validateEnvelope(accepted).valid).toBe(true);
  expect(path).toBe(voiceJobPath(accepted.result!.job_id as string));
  expect((await readJob(path)).state).toBe("queued");
  await runVoiceJob(path, options);
  expect((await readJob(path)).envelope?.status).toBe("applied");
  const status = await dispatch("job_status", { job_id: accepted.result!.job_id });
  expect(status).toMatchObject({
    status: "no_op",
    receipt: null,
    result: { state: "succeeded", request: {}, envelope: { changes_count: 1, changes_sample: [{ entity: "voice" }] } },
  });
  expect(validateEnvelope(status).valid).toBe(true);
  expect(JSON.stringify(status)).not.toContain(key);
  expect(await allLocalText()).not.toContain(key);
  const failedJob = await dispatch(
    "voice_clone",
    { name: "失败任务", file: join(home, "source.wav") },
    {
      ...options,
      launchVoiceJob: async (file) => {
        path = file;
      },
    },
  );
  expect(failedJob.status).toBe("accepted");
  vi.mocked(client.createModel).mockRejectedValueOnce(new VoiceError("E_VOICE_UPSTREAM", `echo ${key}`, true));
  await runVoiceJob(path, options);
  expect(await readJob(path)).toMatchObject({
    state: "failed",
    envelope: { error: { code: "E_VOICE_UPSTREAM", retryable: true } },
  });
  expect(await allLocalText()).not.toContain(key);
  expect(await dispatch("job_status", { job_id: newId("job_") })).toMatchObject({
    status: "rejected",
    error: { code: "E_NOT_FOUND" },
  });
});

it("sends private fast TTS multipart and bearer auth; PATCH uses title and DELETE treats 404 as success", async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(new Response(JSON.stringify({ _id: "fish-id" }), { status: 200 }))
    .mockResolvedValueOnce(new Response(null, { status: 204 }))
    .mockResolvedValueOnce(new Response(null, { status: 404 }));
  const fish = createFishAudioClient(key, null, fetcher);
  expect(await fish.createModel({ name: "音色", audio: new Uint8Array([1, 2]), text: "参考" })).toEqual({
    _id: "fish-id",
  });
  const [url, request] = fetcher.mock.calls[0]!;
  expect(url).toBe("https://api.fish.audio/model");
  expect(request).toMatchObject({ method: "POST", headers: { Authorization: `Bearer ${key}` }, redirect: "error" });
  expect(request!.signal).toBeInstanceOf(AbortSignal);
  const form = request!.body as FormData;
  for (const [field, value] of Object.entries({
    type: "tts",
    train_mode: "fast",
    visibility: "private",
    title: "音色",
    texts: "参考",
    enhance_audio_quality: "true",
  }))
    expect(form.get(field)).toBe(value);
  const audio = form.get("voices") as File;
  expect(audio.name).toBe("sample.wav");
  expect(audio.type).toBe("audio/wav");
  expect(new Uint8Array(await audio.arrayBuffer())).toEqual(new Uint8Array([1, 2]));
  await fish.updateModel("id/escape", "新名字");
  expect(fetcher.mock.calls[1]![0]).toBe("https://api.fish.audio/model/id%2Fescape");
  expect((fetcher.mock.calls[1]![1]!.body as FormData).get("title")).toBe("新名字");
  await fish.deleteModel("fish-id");
  expect(fetcher.mock.calls[2]![1]!.method).toBe("DELETE");
});

it.each([
  [401, "E_VOICE_AUTH", false],
  [402, "E_VOICE_PAYMENT", false],
  [429, "E_VOICE_UPSTREAM", true],
  [500, "E_VOICE_UPSTREAM", true],
  [503, "E_VOICE_UPSTREAM", true],
  [400, "E_VOICE_UPSTREAM", false],
  [403, "E_VOICE_UPSTREAM", false],
])("maps HTTP %s and redacts reflected keys", async (status, code, retryable) => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValue(new Response(JSON.stringify({ message: `upstream message ${key}` }), { status }));
  const fish = createFishAudioClient(key, null, fetcher);
  const error = await fish.deleteModel("model").catch((error: unknown) => error);
  expect(error).toMatchObject({ code, retryable, status: "failed" });
  expect(String(error)).not.toContain(key);
  if (status === 400 || status === 403) expect(String(error)).toContain("upstream message [redacted]");
});

it("maps network errors, timeouts and malformed upstream responses without exposing key-bearing errors", async () => {
  for (const error of [new Error(key), new DOMException(key, "TimeoutError")]) {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(error);
    await expect(createFishAudioClient(key, null, fetcher).deleteModel("model")).rejects.toMatchObject({
      code: "E_VOICE_UPSTREAM",
      retryable: true,
      message: "Cannot reach fish.audio",
    });
  }
  for (const value of [{}, { _id: key }]) {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(value)));
    await expect(
      createFishAudioClient(key, null, fetcher).createModel({ name: "name", audio: new Uint8Array() }),
    ).rejects.toMatchObject({ code: "E_VOICE_UPSTREAM" });
  }
});

it("uses a ProxyAgent for an explicit proxy or HTTPS_PROXY, without changing the environment", async () => {
  vi.stubEnv("HTTPS_PROXY", "http://127.0.0.1:7898");
  for (const proxy of [null, "http://127.0.0.1:7897"]) {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));
    await createFishAudioClient(key, proxy, fetcher).deleteModel("model");
    expect(fetcher.mock.calls[0]![1]).toHaveProperty("dispatcher");
  }
  expect(process.env.HTTPS_PROXY).toBe("http://127.0.0.1:7898");
});

it("runs source and built CLI --wait through an independent worker with fake HTTP and media tools", async () => {
  const bin = join(home, "bin");
  await mkdir(bin);
  const metadata = {
    streams: [
      { index: 0, codec_type: "audio", sample_rate: "44100", channels: 1, duration_ts: "441000", time_base: "1/44100" },
    ],
  };
  const scripts = {
    ffprobe: `process.stdout.write(${JSON.stringify(JSON.stringify(metadata))});`,
    ffmpeg: 'require("node:fs").writeFileSync(process.argv.at(-1), "fake sample");',
  };
  for (const [name, script] of Object.entries(scripts)) {
    const path = join(bin, name);
    await writeFile(path, `#!${process.execPath}\n${script}\n`);
    await chmod(path, 0o700);
  }
  const preload = join(home, "fake-http.mjs");
  await writeFile(
    preload,
    'globalThis.fetch = async () => new Response(JSON.stringify({_id: "fish_subprocess"}), {status: 200});',
  );
  for (const entry of ["src/index.ts", "dist/index.js"]) {
    const cli = fileURLToPath(new URL(`../../cli/${entry}`, import.meta.url));
    const input = join(home, "request.json");
    await writeFile(input, JSON.stringify({ name: "worker", file: join(home, "source.wav") }));
    const { stdout, stderr } = await promisify(execFile)(
      process.execPath,
      [cli, "voice", "clone", "--input", input, "--wait"],
      {
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`,
        },
        timeout: 15000,
      },
    );
    const output = JSON.parse(stdout);
    expect(stderr).toBe("");
    expect(output).toMatchObject({
      status: "applied",
      verb: "voice_clone",
      receipt: null,
      result: { voice: { fish_model_id: "fish_subprocess" } },
    });
    expect(validateEnvelope(output).valid).toBe(true);
    expect(stdout).not.toContain(key);
  }
  expect(await readVoices()).toHaveLength(2);
  const jobs = await readdir(voiceDataPath("jobs"));
  expect(jobs).toHaveLength(2);
  for (const id of jobs) {
    const job = await readJob(voiceJobPath(id));
    expect(job).toMatchObject({ state: "succeeded", progress: 1, verb: "voice_clone", pid: expect.any(Number) });
    expect(JSON.stringify(job)).not.toContain(key);
  }
}, 30000);

it("rejects a converted sample shorter than five seconds before uploading and removes it", async () => {
  const originalProbe = options.probe!;
  options.probe = async (path) =>
    path.includes("/voices/")
      ? {
          streams: [
            {
              index: 0,
              codec_type: "audio",
              sample_rate: "44100",
              channels: 1,
              duration_ts: "176400",
              time_base: "1/44100",
            },
          ],
        }
      : originalProbe(path);
  const output = await clone();
  expect(output).toMatchObject({ status: "rejected", error: { code: "E_VALIDATION" } });
  expect(client.createModel).not.toHaveBeenCalled();
  expect(await readVoices()).toEqual([]);
  expect(await readdir(voiceDataPath("voices"))).toEqual([]);
});
