// biome-ignore-all lint/style/noNonNullAssertion: Test fixtures establish these entities.
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { dispatch, editTermLibrary, parseProject, validateCommand, validateEnvelope } from "../src/index.js";

import { jobPath, readJob } from "../src/jobs.ts";

let directory: string;
let path: string;
let python: string;
const author = { kind: "agent", name: "test" };
const request = (base_revision = "rev_example_1", key = "transcribe-1") => ({
  project: path,
  base_revision,
  idempotency_key: key,
  author,
  media_id: "med_a",
  engine: "auto",
  rules: { profile: "zh-talk", hard_pause: "1/2s" },
});
const project = async () => {
  const value = parseProject(await readFile(path, "utf8"));
  if (!value.ok) throw new Error("Project is invalid");
  return value.project;
};
const finish = async (jobId: string) => {
  for (let i = 0; i < 100; i++) {
    const status = await dispatch("job_status", { project: path, job_id: jobId });
    const job = status.result as { state: string; envelope: Awaited<ReturnType<typeof dispatch>> | null };
    if (job.state === "succeeded" || job.state === "failed") return readJob(jobPath(path, (await project()).id, jobId));
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error("ASR job timeout");
};
const run = async (base_revision = "rev_example_1", key = "transcribe-1") => {
  const accepted = await dispatch("transcribe", request(base_revision, key), {
    asrPython: python,
    asrWorkerDirectory: directory,
  });
  expect(accepted.status, JSON.stringify(accepted)).toBe("accepted");
  return finish((accepted.result as { job_id: string }).job_id);
};

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "zcut-asr-"));
  vi.stubEnv("HOME", directory);
  path = join(directory, "project.zcut.json");
  const media = Buffer.from("synthetic media for ASR contract test");
  await writeFile(join(directory, "media.bin"), media);
  const sample = JSON.parse(await readFile(new URL("../../../examples/minimal.zcut.json", import.meta.url), "utf8"));
  sample.media[0].path = "media.bin";
  sample.media[0].size_bytes = media.length;
  sample.media[0].fingerprint.value = createHash("sha256").update(media).digest("hex");
  sample.timelines[0].tracks.push({
    id: "trk_sub",
    kind: "subtitle",
    name: "中文",
    enabled: true,
    language: "zh-Hans",
    carrier_tracks: ["trk_a1"],
    default_style_id: "sty_default",
    overrides: [],
    free_cues: [],
  });
  sample.subtitle_styles.push({
    id: "sty_default",
    name: "默认",
    version: 1,
    font_family: "Arial",
    font_size: 0.05,
    color: "#FFFFFF",
  });
  await writeFile(path, JSON.stringify(sample, null, 2));
  python = join(directory, "fake-python");
  await writeFile(
    python,
    `#!${process.execPath}
const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');
const args = process.argv.slice(2);
const arg = (name) => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
fs.writeFileSync(path.join(process.cwd(), 'worker-args.json'), JSON.stringify(args));
if (arg('--hotwords')) fs.writeFileSync(path.join(process.cwd(), 'worker-hotwords.txt'), fs.readFileSync(arg('--hotwords')));
const scenario = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'scenario.json'), 'utf8'));
const input = fs.readFileSync(arg('--input'));
const output = scenario.error ? {schema:'zsir-cut/asr-error',schema_version:'0.1',code:scenario.error,message:'model unavailable',retryable:false} : {
  schema:'zsir-cut/asr-result',schema_version:'0.1',
  input:{path:arg('--input'),size_bytes:input.length,fingerprint:crypto.createHash('sha256').update(input).digest('hex'),channels:[Number(arg('--channels'))],start_ms:Number(arg('--start') ?? 0) * 1000,duration_ms:Number(arg('--duration') ?? 60) * 1000},
  language:'zh',asr:{name:'fake-asr',model:'test',version:'1',weights_digest:'sha256:test'},align:{name:'fake-align',model:'test',version:'1',weights_digest:'sha256:test'},tokens:scenario.tokens,runtime:{seconds:0,peak_memory_mb:0,engine_used:'local'},warnings:scenario.warnings ?? []
};
fs.writeFileSync(arg('--out'), JSON.stringify(output));
process.exit(scenario.error ? 1 : 0);
`,
    { mode: 0o755 },
  );
  await writeFile(
    join(directory, "scenario.json"),
    JSON.stringify({
      tokens: [
        { text: "你好", start_ms: 1000, end_ms: 1400, conf: null },
        { text: "世界。", start_ms: 1500, end_ms: 1900, conf: 0.9 },
        { text: "继续", start_ms: 3000, end_ms: 3500, conf: 0.8 },
        { text: "再见。", start_ms: 4500, end_ms: 5000, conf: 0.7 },
      ],
    }),
  );
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});

it("creates all transcript layers, segments cues, and undoes the single revision", async () => {
  expect(validateCommand("transcribe", request()).valid).toBe(true);
  const job = await run();
  expect(job.state, JSON.stringify(job.envelope)).toBe("succeeded");
  expect(validateEnvelope(job.envelope).valid).toBe(true);
  expect(job.envelope?.result?.hotwords).toEqual([]);
  const next = await project();
  expect(next.transcripts).toHaveLength(1);
  const transcript = next.transcripts[0]!;
  expect(transcript).toMatchObject({
    media_id: "med_a",
    source_channels: [0],
    language: "zh-Hans",
    subtitle_rules: { profile: "zh-talk" },
  });
  expect(transcript.raw_runs.map((run) => run.kind)).toEqual(["asr", "align"]);
  expect(transcript.raw_runs[0]!.tokens[0]).toMatchObject({
    text: "你好",
    start: { numerator: 1n, denominator: 1n },
    end: { numerator: 7n, denominator: 5n },
  });
  expect(transcript.raw_runs[0]!.tokens[0]!.conf).toBeUndefined();
  expect(transcript.tokens.map((token) => token.state)).toEqual(["auto", "auto", "auto", "auto"]);
  expect(transcript.tokens.every((token) => token.align.run === transcript.raw_runs[1]!.id)).toBe(true);
  expect(
    transcript.cues.map((cue) =>
      transcript.tokens
        .slice(
          transcript.tokens.findIndex((token) => token.id === cue.first_token),
          transcript.tokens.findIndex((token) => token.id === cue.last_token) + 1,
        )
        .map((token) => token.text)
        .join(""),
    ),
  ).toEqual(["你好世界。", "继续", "再见。"]);
  expect(next.subtitle_styles).toHaveLength(1);
  const replay = await dispatch("transcribe", request());
  expect(replay.status).toBe("applied");
  expect(replay.receipt?.replayed).toBe(true);
  expect((await project()).revision.id).toBe(next.revision.id);
  expect((await dispatch("transcribe", { ...request(), language: "en" })).error?.code).toBe("E_IDEMPOTENCY_MISMATCH");
  const undone = await dispatch("undo", {
    project: path,
    base_revision: next.revision.id,
    idempotency_key: "undo-asr",
    author,
  });
  expect(undone.status, JSON.stringify(undone)).toBe("applied");
  expect((await project()).transcripts).toHaveLength(0);
});

it("preserves edited and approved words and locked cues on a second run", async () => {
  const first = await run();
  expect(first.state).toBe("succeeded");
  const before = await project();
  const transcript = before.transcripts[0]!;
  transcript.tokens[0]!.state = "edited";
  transcript.tokens[0]!.text = "您好";
  transcript.tokens[1]!.state = "approved";
  const locked = transcript.cues.at(-1)!;
  locked.timing = { locked: true };
  const raw = JSON.parse(await readFile(path, "utf8"));
  raw.transcripts[0].tokens[0].state = "edited";
  raw.transcripts[0].tokens[0].text = "您好";
  raw.transcripts[0].tokens[1].state = "approved";
  raw.transcripts[0].cues.at(-1).timing = { locked: true };
  await writeFile(path, JSON.stringify(raw, null, 2));
  await writeFile(
    join(directory, "scenario.json"),
    JSON.stringify({
      tokens: [
        { text: "错误", start_ms: 1000, end_ms: 1400, conf: null },
        { text: "错误。", start_ms: 1500, end_ms: 1900, conf: null },
        { text: "更新", start_ms: 3000, end_ms: 3500, conf: null },
        { text: "错误。", start_ms: 4500, end_ms: 5000, conf: null },
      ],
    }),
  );
  const second = await run(before.revision.id, "transcribe-2");
  expect(second.state, JSON.stringify(second.envelope)).toBe("succeeded");
  const after = (await project()).transcripts[0]!;
  expect(after.tokens.find((token) => token.id === transcript.tokens[0]!.id)).toEqual(transcript.tokens[0]);
  expect(after.tokens.find((token) => token.id === transcript.tokens[1]!.id)).toEqual(transcript.tokens[1]);
  expect(after.tokens.some((token) => token.text === "更新")).toBe(true);
  expect(after.tokens.some((token) => token.text === "继续")).toBe(false);
  expect(after.cues.find((cue) => cue.id === locked.id)).toEqual(locked);
  expect(after.raw_runs).toHaveLength(4);
});

it("surfaces worker errors in job details without changing the project", async () => {
  await writeFile(join(directory, "scenario.json"), JSON.stringify({ error: "E_ASR_MODEL_UNAVAILABLE" }));
  const before = await readFile(path, "utf8");
  const job = await run();
  expect(job.state).toBe("failed");
  expect(job.envelope?.error).toMatchObject({ code: "E_INTERNAL", details: { code: "E_ASR_MODEL_UNAVAILABLE" } });
  expect(await readFile(path, "utf8")).toBe(before);
});

it("passes an exact millisecond range and the default auto engine to the worker", async () => {
  const input = request();
  delete (input as Partial<typeof input>).engine;
  const accepted = await dispatch(
    "transcribe",
    { ...input, range: { start: "1/2s", duration: "5s" } },
    { asrPython: python, asrWorkerDirectory: directory },
  );
  expect(accepted.status).toBe("accepted");
  const job = await finish((accepted.result as { job_id: string }).job_id);
  expect(job.state, JSON.stringify(job.envelope)).toBe("succeeded");
  const args = JSON.parse(await readFile(join(directory, "worker-args.json"), "utf8")) as string[];
  expect(args.slice(args.indexOf("--start"), args.indexOf("--start") + 4)).toEqual([
    "--start",
    "0.5",
    "--duration",
    "5",
  ]);
  expect(args[args.indexOf("--engine") + 1]).toBe("auto");
  expect((await project()).transcripts[0]!.raw_runs[0]!.range.start).toEqual({ numerator: 1n, denominator: 2n });
  expect((await dispatch("transcribe", request("rev_example_1", "stale"))).error?.code).toBe("E_CONFLICT");
  expect(
    (
      await dispatch("transcribe", {
        ...request((await project()).revision.id, "invalid-range"),
        range: { start: "1/3s", duration: "5s" },
      })
    ).error?.code,
  ).toBe("E_VALIDATION");
});

it("rejects transcribe inside an editing session", async () => {
  const result = await dispatch("transcribe", { ...request(), session_id: "ses_test" });
  expect(result.error?.code).toBe("E_SESSION_STATE");
});

it("rejects the first invalid worker token with its index and reason, then accepts repaired regression tokens", async () => {
  const fixture = JSON.parse(
    await readFile(new URL("../../../fixtures/regressions/asr-zero-width.zcut.json", import.meta.url), "utf8"),
  );
  const original = JSON.parse(await readFile(path, "utf8"));
  fixture.media = original.media;
  await writeFile(path, JSON.stringify(fixture));
  const cases = JSON.parse(
    await readFile(new URL("../../../fixtures/regressions/asr-zero-width.json", import.meta.url), "utf8"),
  );
  const scenario = { tokens: cases[2].tokens };
  await writeFile(join(directory, "scenario.json"), JSON.stringify(scenario));
  const failed = await run();
  expect(failed.state).toBe("failed");
  expect(failed.envelope?.error?.message).toMatch(/index 1:.*greater than start_ms/u);
  expect((await project()).transcripts).toHaveLength(0);
  await writeFile(
    join(directory, "scenario.json"),
    JSON.stringify({ tokens: cases[2].expected, warnings: [{ code: "W_ASR_ZERO_WIDTH", count: 1 }] }),
  );
  const repaired = await run("rev_example_1", "repaired");
  expect(repaired.state, JSON.stringify(repaired.envelope)).toBe("succeeded");
  expect(repaired.envelope?.result).toMatchObject({ warnings: [{ code: "W_ASR_ZERO_WIDTH", count: 1 }] });
  expect((await project()).transcripts[0]!.tokens.map((token) => token.text)).toEqual(["ab", "c"]);
});

it("writes empty transcripts with runs, no tokens or cues, and W_ASR_EMPTY", async () => {
  await writeFile(join(directory, "scenario.json"), JSON.stringify({ tokens: [] }));
  const job = await run();
  expect(job.state, JSON.stringify(job.envelope)).toBe("succeeded");
  expect(job.envelope?.result).toMatchObject({ warnings: ["W_ASR_EMPTY"] });
  expect((await project()).transcripts[0]).toMatchObject({
    tokens: [],
    cues: [],
    raw_runs: [{ kind: "asr" }, { kind: "align" }],
  });
});

it("passes worker alignment and repetition warnings through result.warnings and replay", async () => {
  const scenarioPath = join(directory, "scenario.json");
  const scenario = JSON.parse(await readFile(scenarioPath, "utf8"));
  const warnings = [
    { code: "W_ASR_ALIGN_DEGRADED", ratio: 0.06 },
    { code: "W_ASR_ZERO_WIDTH", count: 6 },
    { code: "W_ASR_REPETITION", start_ms: 100, end_ms: 200, count: 20 },
  ];
  await writeFile(scenarioPath, JSON.stringify({ ...scenario, warnings }));
  const job = await run();
  expect(job.state, JSON.stringify(job.envelope)).toBe("succeeded");
  expect(validateEnvelope(job.envelope).valid).toBe(true);
  expect(job.envelope?.result).toMatchObject({ warnings });
  const replay = await dispatch("transcribe", request());
  expect(replay.receipt?.replayed).toBe(true);
  expect(replay.result).toMatchObject({ warnings });
});

it("continues short IDs and clears the subtitle pass and proofread marks while preserving other ext when transcribing again", async () => {
  await run();
  const before = await project();
  const first = before.transcripts[0]!;
  const tag = (first.ext?.zsir as { id_tag: string }).id_tag;
  expect(tag).toBe(first.id.replaceAll("-", "").slice(-6));
  expect(first.tokens.map((token) => token.id)).toEqual([0, 1, 2, 3].map((i) => `tok_${tag}_${i}`));
  expect(first.cues.map((cue) => cue.id)).toEqual([0, 1, 2].map((i) => `cue_${tag}_${i}`));
  const raw = JSON.parse(await readFile(path, "utf8"));
  raw.transcripts[0].ext = {
    ...first.ext,
    "zsir.subtitle_pass": { by: "字幕整理" },
    "zsir.proofread": { by: "字幕校对" },
    "test.keep": [1, 2],
  };
  await writeFile(path, JSON.stringify(raw));
  await run(before.revision.id, "again");
  const next = (await project()).transcripts[0]!;
  expect(next.tokens[0]!.id).toBe(`tok_${tag}_4`);
  expect(next.cues[0]!.id).toBe(`cue_${tag}_3`);
  expect(next.ext).toEqual({ ...first.ext, "test.keep": [1, 2] });
});

it("merges recognition terms with file hotwords and changes their cache digest", async () => {
  const sample = JSON.parse(await readFile(path, "utf8"));
  sample.recognition = { language: "zh", terms: ["飞书", "豆包工作"] };
  await writeFile(path, JSON.stringify(sample));
  await writeFile(join(directory, "hotwords.txt"), " 飞书 \n其他\n\n其他\n");
  const execute = async (key: string, language?: string) => {
    const accepted = await dispatch(
      "transcribe",
      { ...request((await project()).revision.id, key), hotwords: "hotwords.txt", ...(language ? { language } : {}) },
      { asrPython: python, asrWorkerDirectory: directory },
    );
    const completed = await finish((accepted.result as { job_id: string }).job_id);
    expect(completed.state).toBe("succeeded");
    expect(validateEnvelope(completed.envelope)).toEqual({ valid: true, errors: [] });
    const saved = JSON.parse(await readFile(path, "utf8"));
    for (const transcript of saved.transcripts)
      for (const run of transcript.raw_runs) expect(run).not.toHaveProperty("params.hotwords");
    expect(completed.envelope?.result?.hotwords).toEqual(
      (await readFile(join(directory, "worker-hotwords.txt"), "utf8")).split("\n"),
    );
    return readFile(join(directory, "worker-hotwords.txt"), "utf8");
  };
  await editTermLibrary([
    { op: "add", text: "全局词" },
    { op: "block", text: "屏蔽词" },
  ]);
  const before = await execute("terms-1");
  expect(before).toBe("飞书\n豆包工作\n其他\n全局词");
  const args = JSON.parse(await readFile(join(directory, "worker-args.json"), "utf8"));
  expect(args[args.indexOf("--language") + 1]).toBe("zh");
  const changed = JSON.parse(await readFile(path, "utf8"));
  await editTermLibrary([{ op: "add", text: "新词" }]);
  await writeFile(path, JSON.stringify(changed));
  const after = await execute("terms-2", "auto");
  expect(createHash("sha256").update(after).digest("hex")).not.toBe(createHash("sha256").update(before).digest("hex"));
  const override = JSON.parse(await readFile(join(directory, "worker-args.json"), "utf8"));
  expect(override[override.indexOf("--language") + 1]).toBe("auto");
});

it.each([undefined, false, true])(
  "defaults filler removal to true and respects explicit settings (%s)",
  async (setting) => {
    const sample = JSON.parse(await readFile(path, "utf8"));
    if (setting === undefined) delete sample.recognition;
    else sample.recognition = { remove_fillers: setting };
    await writeFile(path, JSON.stringify(sample));
    await writeFile(
      join(directory, "scenario.json"),
      JSON.stringify({
        tokens: [
          { text: "嗯", start_ms: 1000, end_ms: 1080, conf: null },
          { text: "好", start_ms: 1080, end_ms: 1160, conf: null },
        ],
      }),
    );
    const job = await run();
    expect(job.state, JSON.stringify(job.envelope)).toBe("succeeded");
    expect((await project()).transcripts[0]!.tokens[0]!.text).toBe(setting === false ? "嗯" : "");
  },
);

it("hides whole default fillers only, keeps heard and joins cues across hidden tokens", async () => {
  const words = ["开头", "嗯", "啊！", "（呃）", "额", "哦", "唉", "哎", "诶", "那个", "嗯嗯", "结尾"];
  const sample = JSON.parse(await readFile(path, "utf8"));
  sample.recognition = { remove_fillers: true };
  await writeFile(path, JSON.stringify(sample));
  await writeFile(
    join(directory, "scenario.json"),
    JSON.stringify({
      tokens: words.map((text, i) => ({ text, start_ms: 1000 + i * 80, end_ms: 1080 + i * 80, conf: null })),
    }),
  );
  const job = await run();
  expect(job.state, JSON.stringify(job.envelope)).toBe("succeeded");
  expect(job.envelope?.result?.warnings).toContainEqual({ code: "W_FILLERS_HIDDEN", count: 8 });
  const item = (await project()).transcripts[0]!;
  expect(item.tokens.slice(1, 9).map((token) => token.text)).toEqual(Array(8).fill(""));
  expect(item.tokens.slice(1, 9).map((token) => token.heard)).toEqual(words.slice(1, 9));
  expect(item.tokens.every((token) => token.state === "auto")).toBe(true);
  expect(item.tokens[9]!.text).toBe("那个");
  expect(item.tokens[10]!.text).toBe("嗯嗯");
  expect(item.cues).toHaveLength(1);
  expect(item.cues[0]).toMatchObject({ first_token: item.tokens[0]!.id, last_token: item.tokens.at(-1)!.id });
  const changed = JSON.parse(await readFile(path, "utf8"));
  changed.recognition.filler_words = ["那个"];
  changed.transcripts[0].tokens[0].text = "那个";
  changed.transcripts[0].tokens[0].state = "edited";
  await writeFile(path, JSON.stringify(changed));
  const again = await run(changed.revision.id, "custom-fillers");
  expect(again.state).toBe("succeeded");
  expect(again.envelope?.result?.warnings).toContainEqual({ code: "W_FILLERS_HIDDEN", count: 1 });
  const next = (await project()).transcripts[0]!;
  expect(next.tokens[0]).toMatchObject({ text: "那个", state: "edited" });
  expect(next.tokens[9]).toMatchObject({ text: "", heard: "那个", state: "auto" });
  expect(next.tokens[1]!.text).toBe("嗯");
  const partial = JSON.parse(await readFile(path, "utf8"));
  partial.recognition.filler_words = ["那个", "嗯"];
  await writeFile(path, JSON.stringify(partial));
  await writeFile(
    join(directory, "scenario.json"),
    JSON.stringify({ tokens: [{ text: "那个", start_ms: 1720, end_ms: 1800, conf: null }] }),
  );
  const accepted = await dispatch(
    "transcribe",
    { ...request(partial.revision.id, "partial-fillers"), range: { start: "43/25s", duration: "2/25s" } },
    { asrPython: python, asrWorkerDirectory: directory },
  );
  const partialJob = await finish((accepted.result as { job_id: string }).job_id);
  expect(partialJob.state, JSON.stringify(partialJob.envelope)).toBe("succeeded");
  expect(partialJob.envelope?.result?.warnings).toContainEqual({ code: "W_FILLERS_HIDDEN", count: 1 });
  expect((await project()).transcripts[0]!.tokens[1]).toMatchObject({
    id: next.tokens[1]!.id,
    text: "嗯",
    state: "auto",
  });
});
