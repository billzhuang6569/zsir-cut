import * as childProcess from "node:child_process";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { Exporter } from "../src/export-framework.js";
import {
  cuttingList,
  dispatch,
  fingerprint,
  parseProject,
  rational,
  renderPreview,
  runExport,
  serializeProject,
  validateManifest,
  validateProjectSemantics,
  viewTimeline,
  visibleFrame,
} from "../src/index.js";
import type { Clip, Project } from "../src/project/types.js";

vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof childProcess>();
  return { ...original, spawn: vi.fn(original.spawn) };
});

const directories: string[] = [];
afterEach(async () => {
  vi.mocked(childProcess.spawn).mockReset();
  vi.unstubAllEnvs();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});
const run = (args: string[], input?: Buffer) => {
  const result = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-nostdin", ...args], {
    input,
    maxBuffer: 16_000_000,
  });
  const error: NodeJS.ErrnoException | undefined = result.error;
  if (error) throw new Error(`ffmpeg ${error.code === "ENOENT" ? "not found" : "failed to start"}: ${error.message}`);
  if (result.status !== 0) throw new Error(`ffmpeg exited ${result.status}: ${result.stderr?.toString() ?? ""}`);
  return result.stdout;
};
const clip = (id: string, at: bigint, source: bigint, map?: Clip["time_map"]): Clip => ({
  id: `clp_${id}`,
  occurrence_id: `occ_${id}`,
  media_id: "med_barcode",
  timeline_start: rational(at),
  duration: rational(1n),
  source_start: rational(source),
  ...(map ? { time_map: map } : {}),
});
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "zcut-preview-test-"));
  directories.push(directory);
  const mediaPath = join(directory, "barcode.mov");
  const frames = Buffer.alloc(12 * 64 * 32 * 3);
  const digits = [
    "111101101101111",
    "010110010010111",
    "111001111100111",
    "111001111001111",
    "101101111001001",
    "111100111001111",
    "111100111101111",
    "111001001001001",
    "111101111101111",
    "111101111001111",
  ];
  for (let n = 0; n < 12; n++) {
    for (let y = 0; y < 32; y++)
      for (let x = 0; x < 64; x++) {
        const bit = (n >> Math.floor(x / 8)) & 1;
        const offset = (n * 64 * 32 + y * 64 + x) * 3;
        frames.fill(bit ? 255 : 0, offset, offset + 3);
      }
    for (let y = 25; y < 32; y++) frames.fill(0, (n * 64 * 32 + y * 64) * 3, (n * 64 * 32 + y * 64 + 16) * 3);
    for (const [position, character] of String(n).padStart(2, "0").split("").entries())
      for (let pixel = 0; pixel < 15; pixel++)
        if (digits[Number(character)]?.[pixel] === "1") {
          const x = position * 5 + (pixel % 3);
          const y = 26 + Math.floor(pixel / 3);
          frames.fill(255, (n * 64 * 32 + y * 64 + x) * 3, (n * 64 * 32 + y * 64 + x) * 3 + 3);
        }
  }
  run(
    [
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgb24",
      "-s",
      "64x32",
      "-r",
      "4",
      "-i",
      "pipe:0",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:duration=3",
      "-map",
      "0:v",
      "-map",
      "1:a",
      "-c:v",
      "ffv1",
      "-c:a",
      "pcm_s16le",
      "-y",
      mediaPath,
    ],
    frames,
  );
  const info = await stat(mediaPath);
  const forward = clip("forward", 0n, 0n);
  const reverse = clip("reverse", 1n, 2n, [
    { at: rational(0n), source: rational(2n), interp: "linear" },
    { at: rational(1n), source: rational(1n), interp: "linear" },
  ]);
  const hold = clip("hold", 2n, 2n, [
    { at: rational(0n), source: rational(2n), interp: "hold" },
    { at: rational(1n), source: rational(1n), interp: "linear" },
  ]);
  const project: Project = {
    schema: "zsir-cut/timeline",
    schema_version: "0.1",
    id: "prj_preview",
    name: "Barcode",
    revision: {
      seq: 1,
      id: "rev_preview",
      parent: null,
      created_at: "2026-10-27T00:00:00Z",
      author: { kind: "system", name: "test" },
    },
    media: [
      {
        id: "med_barcode",
        kind: "video",
        path: "barcode.mov",
        size_bytes: info.size,
        fingerprint: await fingerprint(mediaPath),
        duration: rational(3n),
        video: { rate: rational(4n), width: 64, height: 32 },
        audio: { sample_rate: rational(44100n), channels: 1 },
      },
    ],
    timelines: [
      {
        id: "tl_preview",
        name: "Timeline",
        edit_rate: rational(4n),
        drop_frame: false,
        start_timecode: "01:00:00:00",
        audio_rate: rational(48000n),
        format: { width: 64, height: 32 },
        markers: [],
        tracks: [
          {
            id: "trk_video",
            kind: "video",
            name: "V1",
            enabled: true,
            clips: [forward, reverse, hold],
            transitions: [],
          },
          {
            id: "trk_audio",
            kind: "audio",
            name: "A1",
            enabled: true,
            clips: [{ ...clip("audio", 0n, 0n), source_channels: [0] }],
            transitions: [],
          },
          {
            id: "trk_subtitle",
            kind: "subtitle",
            name: "EN",
            enabled: true,
            language: "en",
            carrier_tracks: ["trk_audio"],
            default_style_id: "sty_default",
            overrides: [],
            free_cues: [{ id: "cue_free", timeline_start: rational(0n), duration: rational(1n), text: "hello" }],
          },
        ],
      },
    ],
    transcripts: [],
    subtitle_styles: [
      {
        id: "sty_default",
        name: "Default",
        version: 1,
        font_family: "Arial",
        font_size: 32,
        color: "#FFFFFFFF",
        position: { anchor: "bottom", margin_v: 0.1 },
      },
    ],
  };
  const projectPath = join(directory, "test.zcut.json");
  await writeFile(projectPath, serializeProject(project));
  expect(parseProject(await readFile(projectPath, "utf8")).ok).toBe(true);
  return { directory, project, projectPath };
}
function barcode(raw: Buffer, width: number, xOffset = 0) {
  let value = 0;
  for (let bit = 0; bit < 8; bit++) {
    const x = xOffset + bit * 80 + 40;
    if ((raw[(180 * width + x) * 3] ?? 0) > 127) value |= 1 << bit;
  }
  return value;
}

it("reports a missing ffmpeg in the fixture helper", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zcut-no-ffmpeg-"));
  directories.push(directory);
  vi.stubEnv("PATH", directory);
  expect(() => run(["-version"])).toThrow("ffmpeg not found");
});

it.each([false, true])("returns E_IO when ffmpeg cannot start (streaming=%s)", async (streaming) => {
  const { directory, projectPath } = await setup();
  const { spawn } = await vi.importActual<typeof childProcess>("node:child_process");
  vi.mocked(childProcess.spawn).mockImplementation((command, args, options) =>
    spawn(command, args, {
      ...options,
      ...(args?.includes("image2pipe") === streaming ? { env: { ...process.env, PATH: directory } } : {}),
    }),
  );
  const output = await dispatch(
    "render_preview",
    { project: projectPath, output: directory },
    { worker: true, jobFile: join(directory, "job_missing", "job.json") },
  );
  expect(output.status).toBe("failed");
  expect(output.error).toMatchObject({ code: "E_IO", message: expect.stringContaining("ffmpeg not found") });
});

it.each(["render_preview", "view_timeline"] as const)("returns E_IO when %s cannot find ffprobe", async (verb) => {
  const { directory, projectPath } = await setup();
  vi.stubEnv("PATH", directory);
  const output = await dispatch(
    verb,
    { project: projectPath, output: directory },
    { worker: true, jobFile: join(directory, "job_missing", "job.json") },
  );
  expect(output.status).toBe("failed");
  expect(output.error).toMatchObject({ code: "E_IO", message: expect.stringContaining("ffprobe not found") });
});

it("renders exact forward, reverse, hold frames and both sides of each cut", async () => {
  const { directory, project, projectPath } = await setup();
  const timeline = project.timelines[0];
  if (!timeline) throw new Error("Timeline missing");
  expect(
    [0n, 1n, 2n, 3n, 4n, 5n, 6n, 7n, 8n, 9n, 10n, 11n].map((frame) =>
      Number(visibleFrame(project, timeline, frame)?.source_frame),
    ),
  ).toEqual([0, 1, 2, 3, 7, 6, 5, 4, 8, 8, 8, 8]);
  const movie = join(directory, "preview.mov");
  await renderPreview(project, timeline, projectPath, { output: movie, profile: "preview", exportId: "exp_test" });
  const probe = spawnSync("ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", movie]);
  const error: NodeJS.ErrnoException | undefined = probe.error;
  if (error) throw new Error(`ffprobe ${error.code === "ENOENT" ? "not found" : "failed to start"}: ${error.message}`);
  if (probe.status !== 0) throw new Error(`ffprobe exited ${probe.status}: ${probe.stderr?.toString() ?? ""}`);
  const container = JSON.parse(probe.stdout.toString()) as {
    streams: {
      codec_name: string;
      codec_type: string;
      duration?: string;
      tags?: { timecode?: string; handler_name?: string };
    }[];
    format: { tags?: { title?: string; comment?: string } };
  };
  expect(container.streams.map((stream) => stream.codec_type)).toEqual(["video", "audio", "subtitle", "data"]);
  expect(container.streams.slice(0, 3).map((stream) => stream.codec_name)).toEqual(["h264", "aac", "mov_text"]);
  expect(Number(container.streams[1]?.duration)).toBeGreaterThanOrEqual(3);
  expect(container.streams.find((stream) => stream.tags?.timecode)?.tags?.timecode).toMatch(/^01:00:00:0+$/);
  expect(container.format.tags?.title).toBe("Barcode");
  expect(container.format.tags?.comment).toContain("export_id=exp_test");
  const raw = run(["-i", movie, "-map", "0:v:0", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"]);
  const oneFrame = 640 * 360 * 3;
  expect(Array.from({ length: 12 }, (_, i) => barcode(raw.subarray(i * oneFrame, (i + 1) * oneFrame), 640))).toEqual([
    0, 1, 2, 3, 7, 6, 5, 4, 8, 8, 8, 8,
  ]);
  const view = await viewTimeline(project, timeline, projectPath, join(directory, "view"));
  expect(view.cuts).toBe(2);
  for (const [index, pair] of [
    [3, 7],
    [4, 8],
  ].entries()) {
    const picture = run([
      "-i",
      join(view.directory, `cut-${String(index + 1).padStart(4, "0")}.png`),
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgb24",
      "pipe:1",
    ]);
    expect([barcode(picture, 1280), barcode(picture, 1280, 640)]).toEqual(pair);
  }
});

it("runs both verbs through jobs", async () => {
  const { directory, projectPath } = await setup();
  for (const verb of ["render_preview", "view_timeline"] as const) {
    const accepted = await dispatch(verb, { project: projectPath, output: directory });
    expect(accepted.status).toBe("accepted");
    const jobId = (accepted.result as { job_id: string }).job_id;
    let state = "queued";
    for (let i = 0; i < 100 && state !== "succeeded" && state !== "failed"; i++) {
      await new Promise((done) => setTimeout(done, 100));
      const status = await dispatch("job_status", { project: projectPath, job_id: jobId });
      state = (status.result as { state: string }).state;
      if (state === "failed") throw new Error(JSON.stringify(status.result));
    }
    expect(state).toBe("succeeded");
  }
});

it("composites a transparent upper track over the selected source frame", async () => {
  const { directory, project, projectPath } = await setup();
  const pixels = Buffer.alloc(4 * 64 * 32 * 4);
  for (let frame = 0; frame < 4; frame++)
    for (let y = 0; y < 32; y++)
      for (let x = 32; x < 64; x++) {
        const offset = (frame * 64 * 32 + y * 64 + x) * 4;
        pixels[offset] = 255;
        pixels[offset + 3] = 255;
      }
  const overlay = join(directory, "overlay.mov");
  run(
    [
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgba",
      "-s",
      "64x32",
      "-r",
      "4",
      "-i",
      "pipe:0",
      "-c:v",
      "qtrle",
      "-pix_fmt",
      "argb",
      "-y",
      overlay,
    ],
    pixels,
  );
  const info = await stat(overlay);
  project.media.push({
    id: "med_alpha",
    kind: "video",
    path: "overlay.mov",
    size_bytes: info.size,
    fingerprint: await fingerprint(overlay),
    duration: rational(1n),
    video: { rate: rational(4n), width: 64, height: 32 },
  });
  const timeline = project.timelines[0];
  if (!timeline) throw new Error("Timeline missing");
  timeline.tracks.push({
    id: "trk_overlay",
    kind: "video",
    name: "V2",
    enabled: true,
    transitions: [],
    clips: [{ ...clip("overlay", 0n, 0n), media_id: "med_alpha" }],
  });
  await writeFile(projectPath, serializeProject(project));
  const movie = join(directory, "composite.mov");
  await renderPreview(project, timeline, projectPath, { output: movie, profile: "preview", exportId: "exp_alpha" });
  const raw = run(["-i", movie, "-map", "0:v:0", "-frames:v", "2", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"]);
  const frame = raw.subarray(640 * 360 * 3);
  expect(frame[(180 * 640 + 40) * 3]).toBeGreaterThan(180);
  expect(frame[(180 * 640 + 600) * 3]).toBeGreaterThan(180);
  expect(frame[(180 * 640 + 600) * 3 + 1]).toBeLessThan(70);
  const view = await viewTimeline(project, timeline, projectPath, join(directory, "alpha-view"));
  const strip = run(["-i", join(view.directory, "cut-0001.png"), "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"]);
  expect(strip[(180 * 1280 + 600) * 3]).toBeGreaterThan(180);
  expect(strip[(180 * 1280 + 600) * 3 + 1]).toBeLessThan(70);
});

it("uses exact segmented mapping and reports smooth approximation", async () => {
  const { directory, project, projectPath } = await setup();
  const timeline = project.timelines[0];
  if (!timeline) throw new Error("Timeline missing");
  const video = timeline.tracks.find((track) => track.id === "trk_video");
  if (!video || video.kind !== "video") throw new Error("Video track missing");
  const original = video.clips[0];
  if (!original) throw new Error("Clip missing");
  video.clips = [
    {
      ...original,
      duration: rational(2n),
      time_map: [
        { at: rational(0n), source: rational(0n), interp: "linear" },
        { at: rational(1n), source: rational(1n), interp: "smooth" },
        { at: rational(2n), source: rational(3n), interp: "linear" },
      ],
    },
  ];
  expect(
    Array.from({ length: 8 }, (_, frame) => Number(visibleFrame(project, timeline, BigInt(frame))?.source_frame)),
  ).toEqual([0, 1, 2, 3, 4, 6, 8, 10]);
  expect(validateProjectSemantics(project).some((issue) => issue.code === "W_TIMEMAP_APPROX")).toBe(true);
  await writeFile(projectPath, serializeProject(project));
  const preview = await dispatch(
    "render_preview",
    { project: projectPath, output: directory },
    {
      worker: true,
      jobFile: join(directory, "job_smooth", "job.json"),
    },
  );
  expect(preview.status).toBe("applied");
  expect(preview.verification.issues.some((issue) => issue.code === "W_TIMEMAP_APPROX")).toBe(true);
});

it("adds the reference MOV to an online handoff package and manifest", async () => {
  const { directory, project, projectPath } = await setup();
  const exporter: Exporter = {
    version: "test",
    git_sha: "0000000",
    async generate(candidate, timeline, profile) {
      return { name: "timeline.json", data: JSON.stringify(cuttingList(candidate, timeline, profile)) };
    },
    async readBack(data) {
      return JSON.parse(data.toString());
    },
    losses() {
      return [];
    },
    async validate() {
      return true;
    },
  };
  const result = await runExport(
    project,
    { project: projectPath, output: directory },
    exporter,
    "exp_preview",
    "2026-10-27T00:00:00Z",
    "fcp-11-fcpxml-1.13",
  );
  if (!result.package || !result.manifest) throw new Error("Export package missing");
  expect(validateManifest(result.manifest).valid).toBe(true);
  const preview = result.manifest.files.find((file) => file.role === "preview");
  expect(preview?.path).toContain("Barcode_r1_fcp-11-fcpxml-1.13_exp_preview.mov");
  if (!preview) throw new Error("Preview missing");
  expect(await stat(join(result.package, preview.path))).toMatchObject({ size: expect.any(Number) });
});
