// biome-ignore-all lint/style/noNonNullAssertion: Test fixtures establish these entities.
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { dispatch, parseProject, validateCommand, validateEnvelope } from "../src/index.js";

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
    if (job.state === "succeeded" || job.state === "failed") return job;
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
const scenario = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'scenario.json'), 'utf8'));
const input = fs.readFileSync(arg('--input'));
const output = scenario.error ? {schema:'zsir-cut/asr-error',schema_version:'0.1',code:scenario.error,message:'model unavailable',retryable:false} : {
  schema:'zsir-cut/asr-result',schema_version:'0.1',
  input:{path:arg('--input'),size_bytes:input.length,fingerprint:crypto.createHash('sha256').update(input).digest('hex'),channels:[Number(arg('--channels'))],start_ms:Number(arg('--start') ?? 0) * 1000,duration_ms:Number(arg('--duration') ?? 60) * 1000},
  language:'zh',asr:{name:'fake-asr',model:'test',version:'1',weights_digest:'sha256:test'},align:{name:'fake-align',model:'test',version:'1',weights_digest:'sha256:test'},tokens:scenario.tokens,runtime:{seconds:0,peak_memory_mb:0,engine_used:'local'},warnings:[]
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
  await rm(directory, { recursive: true, force: true });
});

it("creates all transcript layers, segments cues, and undoes the single revision", async () => {
  expect(validateCommand("transcribe", request()).valid).toBe(true);
  const job = await run();
  expect(job.state, JSON.stringify(job.envelope)).toBe("succeeded");
  expect(validateEnvelope(job.envelope).valid).toBe(true);
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
