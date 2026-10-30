// biome-ignore-all lint/style/noNonNullAssertion: Fixtures establish entries before use.
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  createFishAudioClient,
  dispatch,
  type FishAudioClient,
  type FishTtsRequest,
  fingerprint,
  newId,
  type Project,
  parseProject,
  printRational,
  projectSubtitles,
  rational,
  serializeProject,
  type VoiceMediaInfo,
  validateEnvelope,
  voiceMediaState,
  writeVoices,
} from "../src/index.ts";
import { jobPath, readJob } from "../src/jobs.ts";
import { runVoiceJob } from "../src/voice-jobs.ts";

let home: string;
let path: string;
let project: Project;
let client: FishAudioClient;
const key = "secret-must-not-persist";
const voiceId = "voc_019a0000-0000-7000-8000-000000000001";
const probe = async () => ({
  streams: [
    { index: 0, codec_type: "audio", sample_rate: "44100", channels: 1, duration_ts: "44100", time_base: "1/44100" },
  ],
});
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "zcut-generate-"));
  vi.stubEnv("HOME", home);
  vi.stubEnv("ZSIR_FISH_API_KEY", key);
  vi.stubEnv("HTTPS_PROXY", "");
  path = join(home, "project.zcut.json");
  const parsed = parseProject(
    await readFile(new URL("../../../fixtures/projects/std-25.zcut.json", import.meta.url), "utf8"),
  );
  if (!parsed.ok) throw new Error("Invalid fixture");
  project = parsed.project;
  const transcript = project.transcripts[0]!;
  // Keep the real fixture's alignment and projection, with unmistakable layer-2 text.
  for (let i = 0; i < 18; i++) transcript.tokens[i]!.text = "";
  transcript.tokens[0]!.text = "你好";
  transcript.tokens[0]!.heard = "原始";
  transcript.tokens[1]!.text = "世界";
  transcript.tokens[5]!.text = "第二句。";
  transcript.tokens[10]!.text = "第三句";
  await writeFile(path, serializeProject(project));
  await mkdir(join(home, "Library/Application Support/zsir-cut"), { recursive: true });
  await writeVoices([
    {
      id: voiceId,
      name: "庄Sir",
      fish_model_id: "fish-reference",
      source: { kind: "file", name: "sample.wav" },
      sample: `voices/${voiceId}.wav`,
      created_at: "2026-10-30T00:00:00.000Z",
    },
  ]);
  client = {
    generate: vi.fn(async (input: FishTtsRequest) => Buffer.from(`wav:${input.text}`)),
    createModel: vi.fn(),
    updateModel: vi.fn(),
    deleteModel: vi.fn(),
  };
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(home, { recursive: true, force: true });
});
const request = (extra: Record<string, unknown> = {}) => ({
  project: path,
  base_revision: project.revision.id,
  idempotency_key: "generate-test",
  author: { kind: "agent", name: "test" },
  voice_id: voiceId,
  items: [{ text: "旁白" }],
  ...extra,
});
async function generate(extra: Record<string, unknown> = {}) {
  const output = await dispatch("voice_generate", request(extra), { fishClient: client, probe, worker: true });
  expect(validateEnvelope(output)).toEqual({ valid: true, errors: [] });
  return output;
}
async function current() {
  const parsed = parseProject(await readFile(path, "utf8"));
  if (!parsed.ok) throw new Error("Invalid generated project");
  return parsed.project;
}
const cues = (mode: "per_cue" | "merged") => ({
  transcript_id: project.transcripts[0]!.id,
  cue_ids: project.transcripts[0]!.cues.slice(0, 3)
    .map((cue) => cue.id)
    .reverse(),
  mode,
});

it.each(["per_cue", "merged"] as const)(
  "imports %s in one revision and matches the golden project fragment",
  async (mode) => {
    const output = await generate({
      items: undefined,
      cues: cues(mode),
      params: { speed: 1.2, volume: -2, temperature: 0, top_p: 1, normalize_loudness: false },
      replaces: "med_A",
    });
    expect(output.status, JSON.stringify(output)).toBe("applied");
    const updated = await current();
    expect(updated.revision.seq).toBe(project.revision.seq + 1);
    const added = updated.media.slice(project.media.length);
    expect(added).toHaveLength(mode === "merged" ? 1 : 3);
    expect(output.changes.map((change) => change.id)).toEqual(added.map((media) => media.id));
    expect(output.result?.imported).toEqual(added.map((media) => ({ media_id: media.id })));
    const expectedTexts = mode === "merged" ? ["你好世界，第二句。第三句"] : ["第三句", "第二句。", "你好世界"];
    for (const [index, media] of added.entries()) {
      expect(media.path).toBe(`voice/${media.id}.wav`);
      expect(media.fingerprint).toEqual(await fingerprint(join(home, media.path)));
      expect(media.size_bytes).toBe(Buffer.byteLength(`wav:${expectedTexts[index]}`));
      const info = media.ext!["zsir.voice"] as VoiceMediaInfo;
      expect(info.text).toBe(expectedTexts[index]);
      expect(info.generated_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(client.generate).toHaveBeenCalledWith(
        {
          text: expectedTexts[index],
          reference_id: "fish-reference",
          format: "wav",
          sample_rate: 44100,
          latency: "normal",
          prosody: { speed: 1.2, volume: -2, normalize_loudness: false },
          temperature: 0,
          top_p: 1,
        },
        "s2.1-pro",
      );
    }
    const fragment = added.map((media) => ({
      kind: media.kind,
      name: media.name,
      duration: printRational(media.duration, true),
      audio: { sample_rate: printRational(media.audio!.sample_rate), channels: media.audio!.channels },
      ext: { "zsir.voice": { ...(media.ext!["zsir.voice"] as object), generated_at: "2026-10-30T00:00:00.000Z" } },
    }));
    const golden = JSON.parse(
      await readFile(new URL(`../../../fixtures/golden/voice-${mode}.json`, import.meta.url), "utf8"),
    );
    expect({ media: fragment }).toEqual(golden);
    expect(await readFile(path, "utf8")).not.toContain(key);
    const replay = await generate({
      items: undefined,
      cues: cues(mode),
      params: { speed: 1.2, volume: -2, temperature: 0, top_p: 1, normalize_loudness: false },
      replaces: "med_A",
    });
    expect(replay.receipt?.replayed).toBe(true);
    expect(replay.changes).toEqual(output.changes);
    expect(client.generate).toHaveBeenCalledTimes(added.length);
    expect((await generate({ items: [{ text: "changed" }] })).error?.code).toBe("E_IDEMPOTENCY_MISMATCH");
  },
);

it("uses settings defaults, omits unset fields, preserves free text and counts Unicode characters for names", async () => {
  await dispatch("settings_set", { voice: { model: "drama-3" } });
  const text = "😀".repeat(21);
  expect((await generate({ items: [{ text }] })).status).toBe("applied");
  const media = (await current()).media.at(-1)!;
  expect(media.name).toBe("😀".repeat(20));
  expect(media.ext!["zsir.voice"]).toMatchObject({
    kind: "free",
    voice_id: voiceId,
    voice_name: "庄Sir",
    model: "drama-3",
    params: {},
    text,
  });
  expect(media.ext!["zsir.voice"]).not.toHaveProperty("cue_ids");
  expect(media.ext!["zsir.voice"]).not.toHaveProperty("take_of");
  expect(client.generate).toHaveBeenCalledWith(
    { text, reference_id: "fish-reference", format: "wav", sample_rate: 44100, latency: "normal" },
    "drama-3",
  );
});

it("limits concurrency to three, waits for outstanding requests before cleanup, and records failing item/status in project job.json", async () => {
  const original = await readFile(path, "utf8");
  let active = 0;
  let maximum = 0;
  client.generate = vi.fn(async (input) => {
    maximum = Math.max(maximum, ++active);
    await new Promise((resolve) => setTimeout(resolve, input.text === "1" ? 5 : 20));
    active--;
    if (input.text === "1") throw new VoiceErrorForTest();
    return Buffer.from(input.text);
  });
  class VoiceErrorForTest extends Error {}
  // Exercise the real HTTP mapping so the saved upstream status is not synthesized by the worker.
  const http = createFishAudioClient(
    key,
    null,
    vi.fn<typeof fetch>().mockResolvedValue(new Response("", { status: 402 })),
  );
  const originalGenerate = client.generate;
  client.generate = async (input, model) => {
    try {
      return await originalGenerate(input, model);
    } catch {
      return http.generate(input, model);
    }
  };
  let jobFile = "";
  const accepted = await dispatch(
    "voice_generate",
    request({ items: Array.from({ length: 8 }, (_, i) => ({ text: String(i) })) }),
    {
      fishClient: client,
      probe,
      launchVoiceJob: async (file) => {
        jobFile = file;
      },
    },
  );
  expect(accepted.status).toBe("accepted");
  expect(jobFile).toBe(jobPath(path, project.id, accepted.result!.job_id as string));
  await runVoiceJob(jobFile, { fishClient: client, probe });
  expect(active).toBe(0);
  expect(maximum).toBe(3);
  const job = await readJob(jobFile);
  expect(job).toMatchObject({
    verb: "voice_generate",
    state: "failed",
    envelope: {
      error: { code: "E_VOICE_PAYMENT", retryable: false, details: { item_index: 1, upstream_status: 402 } },
    },
  });
  expect(await readdir(join(home, "voice"))).toEqual([]);
  expect(await readFile(path, "utf8")).toBe(original);
  expect(await readFile(jobFile, "utf8")).not.toContain(key);
  expect((await dispatch("job_status", { project: path, job_id: job.job_id })).result?.state).toBe("failed");
});

it("caps successful batches at three concurrent requests and keeps result order despite out-of-order completion", async () => {
  let active = 0;
  let maximum = 0;
  client.generate = vi.fn(async (input) => {
    maximum = Math.max(maximum, ++active);
    await new Promise((resolve) => setTimeout(resolve, input.text === "0" ? 30 : 2));
    active--;
    return Buffer.from(input.text);
  });
  const output = await generate({ items: Array.from({ length: 8 }, (_, i) => ({ text: String(i) })) });
  expect(output.status).toBe("applied");
  expect(maximum).toBe(3);
  const added = (await current()).media.slice(project.media.length);
  expect(added.map((media) => (media.ext!["zsir.voice"] as VoiceMediaInfo).text)).toEqual([
    "0",
    "1",
    "2",
    "3",
    "4",
    "5",
    "6",
    "7",
  ]);
  expect(output.changes.map((change) => change.id)).toEqual(added.map((media) => media.id));
});

it("cleans files on import failure and on a revision change during generation", async () => {
  const original = await readFile(path, "utf8");
  const bad = await dispatch("voice_generate", request(), {
    worker: true,
    fishClient: client,
    probe: async () => {
      throw new Error(key);
    },
  });
  expect(bad.error?.code).toBe("E_IO");
  expect(JSON.stringify(bad)).not.toContain(key);
  expect(await readFile(path, "utf8")).toBe(original);
  expect(await readdir(join(home, "voice"))).toEqual([]);
  client.generate = async () => {
    project.revision.id = newId("rev_");
    await writeFile(path, serializeProject(project));
    return Buffer.from("audio");
  };
  const oldRevision = "rev_fixture_1";
  const output = await generate({ base_revision: oldRevision });
  expect(output.status).toBe("conflict");
  expect(await readdir(join(home, "voice"))).toEqual([]);
  expect((await current()).revision.id).toBe(project.revision.id);
});

it.each([
  { items: [] },
  { items: Array.from({ length: 51 }, () => ({ text: "a" })) },
  { items: [{ text: "" }] },
  { items: [{ text: "a".repeat(2001) }] },
  { items: [{ text: "a" }], cues: { transcript_id: "trs_A_zh", cue_ids: ["cue_zh_00"], mode: "merged" } },
  { items: undefined },
  { model: "unknown" },
  { params: { speed: 0.49 } },
  { params: { speed: 2.01 } },
  { params: { temperature: -0.1 } },
  { params: { top_p: 1.01 } },
  { params: { normalize_loudness: 1 } },
  { params: { language: "zh" } },
  { items: undefined, cues: { transcript_id: "trs_A_zh", cue_ids: [], mode: "merged" } },
  { items: undefined, cues: { transcript_id: "trs_A_zh", cue_ids: ["cue_zh_00"] } },
])("rejects invalid generation input before any upstream call: %j", async (extra) => {
  expect((await generate(extra)).error?.code).toBe("E_VALIDATION");
  expect(client.generate).not.toHaveBeenCalled();
});

it("rejects missing voices, cues, replacement media and missing authentication before queuing", async () => {
  for (const extra of [
    { voice_id: "voc_missing" },
    { replaces: "med_missing" },
    { items: undefined, cues: { transcript_id: "trs_A_zh", cue_ids: ["cue_missing"], mode: "merged" } },
  ])
    expect((await generate(extra)).error?.code).toBe("E_NOT_FOUND");
  vi.stubEnv("ZSIR_FISH_API_KEY", "");
  const output = await dispatch("voice_generate", request(), {
    fishClient: client,
    probe,
    voiceKeychain: { read: async () => null, write: async () => {} },
  });
  expect(output).toMatchObject({ status: "rejected", error: { code: "E_VOICE_AUTH" } });
  expect(client.generate).not.toHaveBeenCalled();
});

it("recomputes stale state from layer-2 text and recommended start from the current subtitle projection", async () => {
  await generate({ items: undefined, cues: cues("merged") });
  const updated = await current();
  const info = updated.media.at(-1)!.ext!["zsir.voice"] as VoiceMediaInfo;
  const timelineId = updated.timelines[0]!.id;
  const carrier = updated.timelines[0]!.tracks.find((track) => track.id === "trk_a1")!;
  if (carrier.kind !== "audio") throw new Error("Missing audio carrier");
  carrier.clips = [
    {
      ...carrier.clips[0]!,
      media_id: "med_A",
      source_start: rational(0n),
      timeline_start: rational(7n),
      duration: rational(20n),
    },
  ];
  delete carrier.clips[0]!.time_map;

  const projected = projectSubtitles(updated, timelineId).cues.filter((cue) => cue.cue_id === info.cue_ids![0]);
  expect(voiceMediaState(updated, timelineId, info)).toEqual({ stale: false, recommended_start: projected[0]!.start });
  expect(voiceMediaState(updated, timelineId, info).recommended_start).toEqual(rational(15n, 2n));
  carrier.clips[0]!.time_map = [
    { at: rational(0n), source: rational(0n), interp: "linear" },
    { at: rational(20n), source: rational(40n), interp: "linear" },
  ];
  expect(voiceMediaState(updated, timelineId, info).recommended_start).toEqual(rational(29n, 4n));
  carrier.enabled = false;
  expect(voiceMediaState(updated, timelineId, info)).toEqual({ stale: false, recommended_start: null });
  carrier.enabled = true;
  const before = serializeProject(updated);
  voiceMediaState(updated, timelineId, info);
  expect(serializeProject(updated)).toBe(before);
  updated.transcripts[0]!.tokens[0]!.heard = "different raw words";
  expect(voiceMediaState(updated, timelineId, info).stale).toBe(false);
  updated.transcripts[0]!.tokens[0]!.text = "改了";
  expect(voiceMediaState(updated, timelineId, info).stale).toBe(true);
  updated.transcripts[0]!.cues.shift();
  expect(voiceMediaState(updated, timelineId, info)).toEqual({ stale: true, recommended_start: null });
  expect(voiceMediaState(updated, timelineId, { ...info, kind: "free" })).toEqual({
    stale: false,
    recommended_start: null,
  });
});

it.each([401, 402, 429, 500, 400])("maps TTS HTTP %i and redacts upstream messages", async (status) => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValue(new Response(JSON.stringify({ message: `echo ${key}` }), { status }));
  const fish = createFishAudioClient(key, null, fetcher);
  await expect(
    fish.generate(
      { text: "text", reference_id: "ref", format: "wav", sample_rate: 44100, latency: "normal" },
      "s2-pro",
    ),
  ).rejects.toMatchObject({
    code: status === 401 ? "E_VOICE_AUTH" : status === 402 ? "E_VOICE_PAYMENT" : "E_VOICE_UPSTREAM",
    retryable: status === 429 || status >= 500,
    upstream_status: status,
  });
  try {
    await fish.generate(
      { text: "text", reference_id: "ref", format: "wav", sample_rate: 44100, latency: "normal" },
      "s2-pro",
    );
  } catch (error) {
    expect(String(error)).not.toContain(key);
  }
});

it("sends JSON with Bearer/model headers, receives WAV bytes, and keeps the 120 second timeout active while downloading", async () => {
  const timeout = vi.spyOn(AbortSignal, "timeout");
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(new Uint8Array([1, 2, 3])));
  const fish = createFishAudioClient(key, null, fetcher);
  const input: FishTtsRequest = {
    text: "text",
    reference_id: "ref",
    format: "wav",
    sample_rate: 44100,
    latency: "normal",
  };
  expect(await fish.generate(input, "s2-pro")).toEqual(new Uint8Array([1, 2, 3]));
  expect(fetcher).toHaveBeenCalledWith(
    "https://api.fish.audio/v1/tts",
    expect.objectContaining({
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, model: "s2-pro", "Content-Type": "application/json" },
      body: JSON.stringify(input),
      signal: expect.any(AbortSignal),
    }),
  );
  expect(timeout).toHaveBeenCalledWith(120000);
  timeout.mockRestore();
});

it("accepts 50 items and 2000 Unicode characters, keeps separate takes for identical audio, and applies an explicit model", async () => {
  const text = "😀".repeat(2000);
  const output = await generate({
    items: Array.from({ length: 50 }, () => ({ text })),
    model: "s2-pro",
    params: { speed: 0.5, temperature: 1, top_p: 0 },
  });
  expect(output.status).toBe("applied");
  expect(output.changes).toHaveLength(50);
  expect(client.generate).toHaveBeenCalledTimes(50);
  expect(client.generate).toHaveBeenCalledWith(
    expect.objectContaining({ text, prosody: { speed: 0.5 }, temperature: 1, top_p: 0 }),
    "s2-pro",
  );
  expect((await current()).media.slice(project.media.length)).toHaveLength(50);
});

it("maps an interrupted TTS response body to a retryable safe upstream failure", async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
    new Response(
      new ReadableStream({
        start(controller) {
          controller.error(new DOMException(key, "TimeoutError"));
        },
      }),
    ),
  );
  const client = createFishAudioClient(key, null, fetcher);
  await expect(
    client.generate(
      { text: "text", reference_id: "ref", format: "wav", sample_rate: 44100, latency: "normal" },
      "s2-pro",
    ),
  ).rejects.toMatchObject({ code: "E_VOICE_UPSTREAM", retryable: true, message: "Cannot reach fish.audio" });
});
