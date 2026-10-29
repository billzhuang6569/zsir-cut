// biome-ignore-all lint/style/noNonNullAssertion: Fixture setup guarantees indexed entries.
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { wavPcm24 } from "../../../fixtures/synth/audio.ts";
import { baseFrame } from "../../../fixtures/synth/picture.ts";
import { directFiles, runDirectExport } from "../src/direct-export.ts";
import { dispatch } from "../src/dispatch.ts";
import { runExport, subtitleFiles } from "../src/export-framework.ts";
import { fingerprint } from "../src/fingerprint.ts";
import { parseProject, serializeProject } from "../src/project/io.ts";
import type { Clip, MediaTrack, Project } from "../src/project/types.ts";
import { rational as q } from "../src/rational.ts";
import { validateEnvelope } from "../src/schema.ts";

let directory: string;
let path: string;
let project: Project;
const timeline = () => project.timelines[0]!;
const request = (profile = "direct-audio-wav", extra = {}) => ({
  project: path,
  base_revision: project.revision.id,
  idempotency_key: "direct",
  author: { kind: "agent", name: "test" },
  profile,
  output: join(directory, "out"),
  ...extra,
});
const clip = (extra: Partial<Clip> = {}): Clip => ({
  id: "clp_test",
  occurrence_id: "occ_test",
  media_id: "med_test",
  timeline_start: q(0n),
  source_start: q(0n),
  duration: q(3n),
  ...extra,
});
const track = (clips: Clip[]): MediaTrack => ({
  id: "trk_test",
  kind: "audio",
  enabled: true,
  name: "Audio",
  clips,
  transitions: [],
});
async function source(data = wavPcm24(5, 2, 2, []), channels = 2) {
  const mediaPath = join(directory, "source.wav");
  await writeFile(mediaPath, data);
  project.transcripts = [];
  timeline().markers = [];
  project.media = [
    {
      id: "med_test",
      kind: "audio",
      path: "source.wav",
      duration: q(BigInt((data.length - 44) / (channels * 3)), 48000n),
      size_bytes: data.length,
      fingerprint: await fingerprint(mediaPath),
      audio: { sample_rate: q(48000n), channels },
    },
  ];
}
async function save() {
  await writeFile(path, serializeProject(project));
}
async function render(output = join(directory, "out")) {
  return runDirectExport(
    project,
    timeline(),
    path,
    output,
    "direct-audio-wav",
    directFiles(project, timeline(), "direct-audio-wav"),
  );
}
async function wav(output = join(directory, "out")) {
  return readFile(join(output, `${timeline().name}_r${project.revision.seq}.wav`));
}
const sample = (data: Buffer, frame: number, channel = 0) => data.readIntLE(44 + (frame * 2 + channel) * 3, 3);
function constant(values: number[], seconds = 5) {
  const data = Buffer.alloc(44 + seconds * 48000 * values.length * 3);
  wavPcm24(0, 2, 2, []).copy(data);
  data.writeUInt32LE(data.length - 8, 4);
  data.writeUInt16LE(values.length, 22);
  data.writeUInt32LE(48000 * values.length * 3, 28);
  data.writeUInt16LE(values.length * 3, 32);
  data.writeUInt32LE(data.length - 44, 40);
  for (let i = 0; i < seconds * 48000; i++)
    for (const [channel, value] of values.entries()) data.writeIntLE(value, 44 + (i * values.length + channel) * 3, 3);
  return data;
}
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "zcut-direct-"));
  path = join(directory, "test.zcut.json");
  const parsed = parseProject(
    await readFile(new URL("../../../fixtures/projects/std-25.zcut.json", import.meta.url), "utf8"),
  );
  if (!parsed.ok) throw new Error("Invalid fixture");
  project = parsed.project;
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

it("writes byte-identical layered SRTs to the same-revision handoff package and golden", async () => {
  const files = directFiles(project, timeline(), "direct-srt");
  const { default: exporter } = await import(new URL("../../exporters/test/fake-exporter.mjs", import.meta.url).href);
  const handoff = await runExport(
    project,
    { project: path, output: directory, accept_losses: true },
    exporter,
    "exp_direct",
    "2026-10-29T00:00:00Z",
    "fcp-11-fcpxml-1.13",
  );
  expect(handoff.rejected).toBe(false);
  const result = await runDirectExport(project, timeline(), path, join(directory, "direct"), "direct-srt", files);
  const handoffFiles = subtitleFiles(project, timeline()).filter((file) => file.role === "subtitle");
  expect(files.length).toBeGreaterThan(2);
  for (const [i, file] of files.entries()) {
    const actual = await readFile(join(directory, "direct", file.name));
    expect(actual).toEqual(await readFile(join(handoff.package!, "subtitles", handoffFiles[i]!.name)));
    expect(result.files[i]!.size_bytes).toBe(actual.length);
  }
  expect(files[0]!.data).toBe(await readFile("fixtures/golden/direct-srt.srt", "utf8"));
  expect(await readdir(join(directory, "direct"))).toEqual(files.map((file) => file.name).sort());
});

it("dry-run returns only filenames without creating output, and handles disabled tracks/name collisions", async () => {
  await save();
  for (const profile of ["direct-srt", "direct-audio-wav"]) {
    const result = await dispatch("export", request(profile, { dry_run: true }));
    expect(result.status).toBe("dry_run");
    expect(validateEnvelope(result).valid).toBe(true);
    expect(Object.keys(result.result!)).toEqual(["files"]);
    for (const file of result.result!.files as object[]) expect(Object.keys(file)).toEqual(["name"]);
  }
  expect(await readdir(directory)).toEqual(["test.zcut.json"]);
  const subtitles = timeline().tracks.filter((item) => item.kind === "subtitle");
  subtitles[0]!.enabled = false;
  expect(directFiles(project, timeline(), "direct-srt").every((file) => !file.name.includes(subtitles[0]!.name))).toBe(
    true,
  );
  subtitles[0]!.enabled = true;
  subtitles[1]!.name = subtitles[0]!.name;
  const files = directFiles(project, timeline(), "direct-srt");
  expect(new Set(files.map((file) => file.name)).size).toBe(files.length);
});

it.each([q(25n), q(30000n, 1001n)])(
  "keeps generated fixture impulses within white-frame intervals at %# and exports deterministic PCM",
  async (editRate) => {
    await source();
    timeline().edit_rate = editRate;
    timeline().tracks = [track([clip({ source_start: q(1n), timeline_start: q(1n, 2n) })])];
    await render();
    await render(join(directory, "again"));
    const data = await wav();
    expect(data).toEqual(await wav(join(directory, "again")));
    expect(data.readUInt16LE(22)).toBe(2);
    expect(data.readUInt32LE(24)).toBe(48000);
    expect(data.readUInt16LE(34)).toBe(24);
    const onsets: number[] = [];
    for (let frame = 24000; frame < 168000; frame++) {
      if (Math.abs(sample(data, frame)) > 10000 && (onsets.length === 0 || frame - onsets.at(-1)! > 24000))
        onsets.push(frame);
    }
    expect(onsets).toHaveLength(3);
    for (const [index, onset] of onsets.entries()) {
      const sourceSecond = BigInt(index + 1);
      const white = (sourceSecond * editRate.numerator) / editRate.denominator;
      expect(baseFrame(2, Number(white), Number(editRate.numerator), Number(editRate.denominator))[0]).toBe(255);
      // Compare exact sample times with the source white-frame interval after the trim/placement.
      const mapped = BigInt(onset + 24000);
      expect(mapped * editRate.numerator >= white * editRate.denominator * 48000n).toBe(true);
      expect(mapped * editRate.numerator < (white + 1n) * editRate.denominator * 48000n).toBe(true);
    }
  },
  20000,
);

it("honors mono duplication, explicit channel order, dropped channels, disabled clips/tracks and gain", async () => {
  await source(constant([1048576, 2097152, 3145728]), 3);
  const audible = clip({ duration: q(1n), source_channels: [2, 0] });
  timeline().tracks = [
    track([audible, clip({ id: "clp_disabled", enabled: false, timeline_start: q(1n) })]),
    { ...track([clip()]), id: "trk_disabled", enabled: false },
  ];
  await render();
  let data = await wav();
  expect(sample(data, 100, 0)).toBe(3145728);
  expect(sample(data, 100, 1)).toBe(1048576);
  expect(sample(data, 48000)).toBe(0);
  audible.source_channels = [1];
  audible.gain_db = -6.020599913279624;
  await render(join(directory, "mono"));
  data = await wav(join(directory, "mono"));
  expect(sample(data, 100, 0)).toBe(1048576);
  expect(sample(data, 100, 1)).toBe(1048576);
  delete audible.source_channels;
  expect((await render(join(directory, "drop"))).warnings).toContainEqual(
    expect.objectContaining({ code: "W_AUDIO_CHANNELS_DROPPED" }),
  );
  await source(constant([1048576]), 1);
  audible.gain_db = 0;
  await render(join(directory, "one"));
  data = await wav(join(directory, "one"));
  expect(sample(data, 100, 0)).toBe(1048576);
  expect(sample(data, 100, 1)).toBe(1048576);
});

it("maps linear speed, reverse, hold and fractional placement by exact samples", async () => {
  const data = constant([0, 0], 1);
  for (let i = 0; i < 48000; i++) {
    data.writeIntLE(i, 44 + i * 6, 3);
    data.writeIntLE(-i, 47 + i * 6, 3);
  }
  await source(data);
  const item = clip({
    timeline_start: q(1n, 96000n),
    duration: q(6n, 48000n),
    time_map: [
      { at: q(0n), source: q(0n), interp: "linear" },
      { at: q(2n, 48000n), source: q(4n, 48000n), interp: "hold" },
      { at: q(4n, 48000n), source: q(4n, 48000n), interp: "linear" },
      { at: q(6n, 48000n), source: q(2n, 48000n), interp: "linear" },
    ],
  });
  timeline().tracks = [track([item])];
  await render();
  const output = await wav();
  expect(Array.from({ length: 7 }, (_, i) => sample(output, i))).toEqual([0, 1, 3, 4, 4, 3, 2]);
  expect(output.toString("hex")).toBe((await readFile("fixtures/golden/direct-audio-wav.hex", "utf8")).trim());
});

it.each(["center", "start", "end"] as const)(
  "mixes equal-power %s dissolves with source handles",
  async (alignment) => {
    await source(constant([1048576, 1048576]));
    const from = clip({ duration: q(1n), source_start: q(1n) });
    const to = clip({
      id: "clp_to",
      occurrence_id: "occ_to",
      timeline_start: q(1n),
      source_start: q(2n),
      duration: q(1n),
    });
    const audio = track([from, to]);
    audio.transitions = [
      { id: "trn_test", type: "cross_dissolve", from_clip: from.id, to_clip: to.id, duration: q(1n), alignment },
    ];
    timeline().tracks = [audio];
    await render();
    const data = await wav();
    const middle = alignment === "center" ? 48000 : alignment === "start" ? 72000 : 24000;
    expect(sample(data, middle)).toBe(Math.round(1048576 * Math.SQRT2));
    expect(sample(data, alignment === "end" ? 96000 - 1 : 0)).toBe(1048576);
  },
  20000,
);

it("reports exact clipped channel-sample counts and never overwrites an existing output", async () => {
  await source(constant([4194304, -4194304]));
  timeline().tracks = [track([clip({ duration: q(1n), gain_db: 12.041199826559248 })])];
  await save();
  const result = await dispatch("export", request(), { worker: true });
  expect(result.status).toBe("applied");
  expect(validateEnvelope(result).valid).toBe(true);
  expect(result.result!.warnings).toContainEqual(
    expect.objectContaining({ code: "W_AUDIO_CLIPPED", clipped_samples: 96000 }),
  );
  const before = await wav();
  expect(sample(before, 1, 0)).toBe(8388607);
  expect(sample(before, 1, 1)).toBe(-8388608);
  expect(await dispatch("export", request())).toMatchObject({ status: "rejected", error: { code: "E_VALIDATION" } });
  expect(await wav()).toEqual(before);
});

it("fails offline or mismatched media without partial output", async () => {
  await source();
  timeline().tracks = [track([clip()])];
  await save();
  await writeFile(join(directory, "source.wav"), "changed");
  expect(await dispatch("export", request(), { worker: true })).toMatchObject({
    status: "failed",
    error: { code: "E_IO" },
  });
  expect(await readdir(join(directory, "out"))).toEqual([]);
  await rm(join(directory, "source.wav"));
  expect(await dispatch("export", request(), { worker: true })).toMatchObject({
    status: "failed",
    error: { code: "E_IO" },
  });
  expect(await readdir(join(directory, "out"))).toEqual([]);
});

it("rolls back newly published SRTs if another destination already exists", async () => {
  const files = directFiles(project, timeline(), "direct-srt");
  const output = join(directory, "race");
  // Publish just the last file to exercise the no-clobber check inside publication.
  await runDirectExport(project, timeline(), path, output, "direct-srt", [files.at(-1)!]);
  const existing = await readFile(join(output, files.at(-1)!.name));
  await expect(runDirectExport(project, timeline(), path, output, "direct-srt", files)).rejects.toThrow(
    "already exists",
  );
  expect(await readdir(output)).toEqual([files.at(-1)!.name]);
  expect(await readFile(join(output, files.at(-1)!.name))).toEqual(existing);
});

it("returns smooth-map approximation warnings and fails decoding without publishing a WAV", async () => {
  await source();
  timeline().tracks = [
    track([
      clip({
        duration: q(1n),
        time_map: [
          { at: q(0n), source: q(0n), interp: "smooth" },
          { at: q(1n), source: q(2n), interp: "linear" },
        ],
      }),
    ]),
  ];
  await save();
  const result = await dispatch("export", request(), { worker: true });
  expect(result.status).toBe("applied");
  expect(result.verification.issues).toContainEqual(expect.objectContaining({ code: "W_TIMEMAP_APPROX" }));
  await writeFile(join(directory, "source.wav"), "invalid audio");
  project.media[0]!.size_bytes = 13;
  project.media[0]!.fingerprint = await fingerprint(join(directory, "source.wav"));
  await save();
  expect(
    await dispatch("export", request("direct-audio-wav", { output: join(directory, "invalid") }), { worker: true }),
  ).toMatchObject({ status: "failed", error: { code: "E_IO" } });
  expect(await readdir(join(directory, "invalid"))).toEqual([]);
});
