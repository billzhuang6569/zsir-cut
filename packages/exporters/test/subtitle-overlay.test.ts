// biome-ignore-all lint/style/noNonNullAssertion: Synthetic fixture and probe assertions guard indexed entries.
import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { createCanvas, GlobalFonts } from "@napi-rs/canvas";
import { afterEach, beforeEach, expect, it } from "vitest";
import { dispatch, parseProject, rational as q, serializeProject, validateEnvelope } from "../../core/src/index.ts";
import type { Project } from "../../core/src/project/types.ts";
import { checkSubtitleFont } from "../src/subtitle-fonts.ts";
import { renderSubtitleOverlay } from "../src/subtitle-overlay.ts";
import { renderSubtitle } from "../src/subtitle-render.ts";

const run = promisify(execFile);
let dir: string, path: string, project: Project;
const timeline = () => project.timelines[0]!;
const overlay = () => project.subtitle_overlays![0]!;
const save = () => writeFile(path, serializeProject(project));
const request = (key: string) => ({
  project: path,
  base_revision: project.revision.id,
  idempotency_key: key,
  author: { kind: "human", name: "test" },
  profile: "subtitle-overlay",
  overlay_id: "ovl_test",
});
async function reload() {
  const parsed = parseProject(await readFile(path, "utf8"));
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
  project = parsed.project;
}
async function decode(file = overlay().output_path) {
  const { stdout } = await run(
    "ffmpeg",
    ["-v", "error", "-i", file, "-map", "0:v:0", "-f", "rawvideo", "-pix_fmt", "rgba", "-"],
    { encoding: "buffer", maxBuffer: 20 * 1024 * 1024 },
  );
  return stdout;
}
const frameSize = 320 * 180 * 4;
const frame = (data: Buffer, index: number) => data.subarray(index * frameSize, (index + 1) * frameSize);
const alphas = (data: Buffer) => [...data].filter((_, i) => i % 4 === 3);
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "zcut-overlay 中文 100% ' -"));
  path = join(dir, "test.zcut.json");
  const parsed = parseProject(
    await readFile(
      new URL("../../../fixtures/regressions/subtitle-overlay-boundaries.zcut.json", import.meta.url),
      "utf8",
    ),
  );
  if (!parsed.ok) throw new Error("Bad fixture");
  project = parsed.project;
  project.subtitle_overlays = [
    {
      id: "ovl_test",
      name: "Overlay",
      timeline_id: timeline().id,
      subtitle_track_id: "trk_s",
      output_path: join(dir, "字幕 ' overlay.mov"),
      tail: q(1n, 5n),
      last_export: null,
    },
  ];
  await save();
  await reload();
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

it("shares wrapping, explicit breaks, overflow, positioning and box geometry on standard Canvas", () => {
  const style = project.subtitle_styles[0]!;
  const canvas = createCanvas(320, 180);
  const context = canvas.getContext("2d");
  const rendered = renderSubtitle(
    context,
    "Alpha\n中文 subtitle long text",
    { ...style, max_lines: 1, position: { anchor: "top", margin_v: 0.1, max_width: 0.3 } },
    320,
    180,
  );
  expect(rendered.lines[0]).toBe("Alpha");
  expect(rendered.lines.length).toBeGreaterThan(2);
  expect(rendered.warnings).toEqual([{ code: "W_SUB_OVERFLOW" }]);
  expect(context.font).toBe("10px sans-serif");
  const data = context.getImageData(0, 0, 320, 180).data;
  const visibleY = Array.from({ length: 180 }, (_, y) => y).filter((y) =>
    Array.from({ length: 320 }, (_, x) => data[(y * 320 + x) * 4 + 3]).some((a) => a! > 0),
  );
  expect(Math.min(...visibleY)).toBe(18);
});

it.each([
  { rate: q(25n), df: false, tc: "01:00:00:00", frames: 30 },
  { rate: q(30000n, 1001n), df: true, tc: "01:00:00;00", frames: 36 },
])(
  "encodes metadata, transparent gaps, and deterministic decoded frames at $tc",
  async ({ rate, df, tc, frames }) => {
    timeline().edit_rate = rate;
    timeline().drop_frame = df;
    timeline().start_timecode = tc;
    // Keep the synthetic clip on the target frame grid.
    const videoTrack = timeline().tracks[0]!;
    if (videoTrack.kind !== "subtitle") videoTrack.clips[0]!.duration = q(df ? 1001n : 1n, df ? 1000n : 1n);
    await save();
    const result = await renderSubtitleOverlay(project, overlay(), path);
    expect(result.frame_count).toBe(frames);
    expect(result.subtitle_count).toBe(2);
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "W_FONT_FALLBACK", font_family: "Missing Zcut Test Font" }),
      ]),
    );
    const { stdout } = await run("ffprobe", [
      "-v",
      "error",
      "-count_frames",
      "-show_streams",
      "-of",
      "json",
      overlay().output_path,
    ]);
    const streams = JSON.parse(stdout).streams;
    const video = streams.find((s: { codec_type: string }) => s.codec_type === "video");
    expect(video).toMatchObject({
      codec_name: "prores",
      profile: "4444",
      width: 320,
      height: 180,
      r_frame_rate: df ? "30000/1001" : "25/1",
      nb_read_frames: String(frames),
      pix_fmt: "yuva444p12le",
    });
    expect(video.tags.timecode).toBe(tc);
    expect(streams.some((s: { codec_type: string }) => s.codec_type === "audio")).toBe(false);
    const first = await decode();
    expect(first.length).toBe(frames * frameSize);
    for (let i = 0; i < frames; i++) {
      const active = df ? (i >= 6 && i < 12) || (i >= 18 && i < 24) : (i >= 5 && i < 10) || (i >= 15 && i < 20);
      expect(
        alphas(frame(first, i)).some((a) => a > 0),
        `alpha at frame ${i}`,
      ).toBe(active);
    }
    expect(alphas(frame(first, 0)).every((a) => a === 0)).toBe(true);
    expect(alphas(frame(first, df ? 15 : 12)).every((a) => a === 0)).toBe(true);
    expect(alphas(frame(first, df ? 9 : 7)).some((a) => a > 0)).toBe(true);
    expect(alphas(frame(first, df ? 21 : 17)).some((a) => a > 0)).toBe(true);
    await renderSubtitleOverlay(project, overlay(), path);
    expect(await decode()).toEqual(first);
  },
  30000,
);

it("atomically replaces the same path, commits last_export and only changes edited subtitle frames", async () => {
  const initial = project.revision.id;
  const output = await dispatch("export", request("first"), { worker: true });
  expect(output.status, JSON.stringify(output)).toBe("applied");
  expect(validateEnvelope(output).valid).toBe(true);
  const first = await decode();
  await reload();
  expect(project.revision.seq).toBe(2);
  expect(overlay().last_export).toMatchObject({
    revision_id: initial,
    size_bytes: (await readFile(overlay().output_path)).length,
  });
  const originalPath = overlay().output_path;
  const { profile: _profile, overlay_id: _overlay, ...editRequest } = request("change");
  const edit = await dispatch("edit", {
    ...editRequest,
    ops: [
      { op: "remove_free_cue", track_id: "trk_s", id: "cue_a" },
      { op: "add_free_cue", track_id: "trk_s", id: "cue_a", timeline_start: "1/5s", duration: "1/5s", text: "Changed" },
    ],
  });
  expect(edit.status, JSON.stringify(edit)).toBe("applied");
  await reload();
  const req = request("second");
  expect((await dispatch("export", req, { worker: true })).status).toBe("applied");
  await reload();
  expect(overlay().output_path).toBe(originalPath);
  expect(project.revision.seq).toBe(4);
  const second = await decode();
  for (let i = 0; i < 30; i++) expect(frame(second, i).equals(frame(first, i)), `frame ${i}`).toBe(i < 5 || i >= 10);
  const replay = await dispatch("export", req, { worker: true });
  expect(replay.status).toBe("applied");
  await reload();
  expect(project.revision.seq).toBe(4);
  expect((await readdir(dir)).filter((name) => name.includes("zcut-tmp") || name.startsWith(".zcut-overlay"))).toEqual(
    [],
  );
}, 30000);

it("keeps the old output on encoding failure and refuses an occupied temporary path", async () => {
  await writeFile(overlay().output_path, "original");
  const temp = join(dir, `.${overlay().output_path.split("/").at(-1)}.zcut-tmp`);
  await writeFile(temp, "reserved");
  await expect(renderSubtitleOverlay(project, overlay(), path)).rejects.toThrow();
  expect(await readFile(temp, "utf8")).toBe("reserved");
  await rm(temp);
  const oldPath = process.env.PATH;
  process.env.PATH = dir;
  try {
    await expect(renderSubtitleOverlay(project, overlay(), path)).rejects.toThrow();
  } finally {
    process.env.PATH = oldPath;
  }
  expect(await readFile(overlay().output_path, "utf8")).toBe("original");
  expect((await readdir(dir)).filter((name) => name.includes("zcut-tmp") || name.startsWith(".zcut-overlay"))).toEqual(
    [],
  );
  await reload();
  expect(overlay().last_export).toBeNull();
}, 30000);

it("returns accepted and finishes in the detached export worker with a new revision", async () => {
  const accepted = await dispatch("export", request("background"));
  expect(accepted.status, JSON.stringify(accepted)).toBe("accepted");
  expect(validateEnvelope(accepted).valid).toBe(true);
  const jobId = (accepted.result as { job_id: string }).job_id;
  const until = Date.now() + 20000;
  let status: Awaited<ReturnType<typeof dispatch>>;
  do {
    await new Promise((resolve) => setTimeout(resolve, 100));
    status = await dispatch("job_status", { project: path, job_id: jobId });
  } while (
    (status.result as { state: string }).state !== "succeeded" &&
    (status.result as { state: string }).state !== "failed" &&
    Date.now() < until
  );
  expect((status.result as { state: string }).state, JSON.stringify(status)).toBe("succeeded");
  await reload();
  expect(project.revision.seq).toBe(2);
  expect(overlay().last_export).not.toBeNull();
}, 30000);

it("renders disabled subtitle tracks as transparent video and refuses source-media destinations", async () => {
  timeline().tracks[1]!.enabled = false;
  const result = await renderSubtitleOverlay(project, overlay(), path);
  expect(result.subtitle_count).toBe(0);
  const data = await decode();
  expect(alphas(data).every((alpha) => alpha === 0)).toBe(true);
  project.media[0]!.path = overlay().output_path;
  const old = await readFile(overlay().output_path);
  await expect(renderSubtitleOverlay(project, overlay(), path)).rejects.toThrow("overwrite source media");
  expect(await readFile(overlay().output_path)).toEqual(old);
}, 30000);

it("exports the Chinese regression without a false font warning when the family is available", async (context) => {
  const parsed = parseProject(
    await readFile(
      new URL("../../../fixtures/regressions/subtitle-overlay-chinese-glyphs.zcut.json", import.meta.url),
      "utf8",
    ),
  );
  if (!parsed.ok) throw new Error("Bad Chinese fixture");
  project.subtitle_styles = parsed.project.subtitle_styles;
  const subtitles = timeline().tracks[1]!;
  const source = parsed.project.timelines[0]!.tracks[1]!;
  if (subtitles.kind !== "subtitle" || source.kind !== "subtitle") throw new Error("Missing subtitle track");
  subtitles.free_cues = source.free_cues;
  const checked = checkSubtitleFont("在物美很多商场都有", project.subtitle_styles[0]!);
  if (checked.missing.length) {
    context.skip("No font in the installed Chinese fallback chain covers the regression text.");
    return;
  }
  const result = await renderSubtitleOverlay(project, overlay(), path);
  expect(result.warnings.filter((warning) => warning.code === "W_FONT_FALLBACK")).toEqual(
    checked.found ? [] : [{ code: "W_FONT_FALLBACK", font_family: "PingFang SC" }],
  );
  expect(alphas(frame(await decode(), 7)).some((alpha) => alpha > 0)).toBe(true);
}, 30000);

it("merges missing glyphs into the existing font warning even for a registered family", async () => {
  project.subtitle_styles[0]!.font_family = GlobalFonts.families[0]!.family;
  const subtitles = timeline().tracks[1]!;
  if (subtitles.kind !== "subtitle") throw new Error("Missing subtitle track");
  subtitles.free_cues[0]!.text = "A\u{10ffff}";
  subtitles.free_cues[1]!.text = "B\u{10fffe}\u{10ffff}";
  const result = await renderSubtitleOverlay(project, overlay(), path);
  expect(result.warnings.filter((warning) => warning.code === "W_FONT_FALLBACK")).toEqual([
    {
      code: "W_FONT_FALLBACK",
      font_family: project.subtitle_styles[0]!.font_family,
      missing_glyphs: ["\u{10ffff}", "\u{10fffe}"],
    },
  ]);
}, 30000);
