// biome-ignore-all lint/style/noNonNullAssertion: Validated project references and indexed intervals are guarded locally.
import { execFile } from "node:child_process";
import { mkdtemp, open, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { createCanvas, GlobalFonts, loadImage } from "@napi-rs/canvas";
import type { Project, SubtitleOverlay } from "../../core/dist/index.js";
import { renderSubtitle } from "./subtitle-render.ts";

const {
  add,
  ceil,
  compare,
  div,
  floor,
  mul,
  printRational,
  projectSubtitles,
  quantizeCue,
  rational,
}: typeof import("../../core/dist/index.js") = await import(
  new URL(import.meta.url.endsWith(".ts") ? "../../core/src/index.ts" : "../../core/dist/index.js", import.meta.url)
    .href
);
const run = promisify(execFile);

export async function renderSubtitleOverlay(project: Project, overlay: SubtitleOverlay, projectPath: string) {
  const timeline = project.timelines.find((item) => item.id === overlay.timeline_id)!;
  const { width, height } = timeline.format;
  const destination = join(await realpath(dirname(overlay.output_path)), basename(overlay.output_path));
  for (const media of project.media) {
    const source = resolve(dirname(projectPath), media.path);
    if (source === resolve(overlay.output_path) || (await realpath(source).catch(() => source)) === destination)
      throw new Error("Overlay output would overwrite source media");
  }
  const zero = rational(0n);
  const clips = timeline.tracks.flatMap((track) => (track.kind === "subtitle" ? [] : track.clips));
  const end = clips.reduce((end, clip) => {
    const stop = add(clip.timeline_start, clip.duration);
    return compare(stop, end) > 0 ? stop : end;
  }, zero);
  const frameCount = ceil(mul(add(end, overlay.tail ?? rational(10n)), timeline.edit_rate));
  if (frameCount <= 0n || frameCount > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Invalid overlay duration");
  const warnings: Record<string, unknown>[] = [];
  const cues = projectSubtitles(project, timeline.id)
    .cues.filter((cue) => cue.track_id === overlay.subtitle_track_id)
    .flatMap((cue) => {
      const carriers = clips.filter((clip) => cue.clip_ids.includes(clip.id));
      const starts = carriers.map((clip) => clip.timeline_start);
      const ends = carriers.map((clip) => add(clip.timeline_start, clip.duration));
      const q = quantizeCue(
        cue.start,
        cue.end,
        timeline.edit_rate,
        starts.sort(compare)[0] ?? zero,
        ends.sort(compare).at(-1) ?? div(rational(frameCount), timeline.edit_rate),
      );
      if (!q) return [];
      // A frame is visible when its start lies in the quantized, clip-clamped interval.
      const start = ceil(mul(q.start, timeline.edit_rate));
      const end = ceil(mul(q.end, timeline.edit_rate));
      return end > start ? [{ cue, start, end: end < frameCount ? end : frameCount, file: "" }] : [];
    })
    .filter((item) => item.start < item.end && item.start < frameCount);
  const temp = join(dirname(overlay.output_path), `.${basename(overlay.output_path)}.zcut-tmp`);
  // Exclusive reservation also protects two different projects targeting the same output.
  const reservation = await open(temp, "wx");
  let directory: string | undefined;
  try {
    await reservation.close();
    directory = await mkdtemp(join(dirname(overlay.output_path), ".zcut-overlay-"));
    const images = new Map<string, string>();
    for (const item of cues) {
      const style = project.subtitle_styles.find((style) => style.id === item.cue.style_id)!;
      const text = item.cue.lines.join("\n");
      const key = JSON.stringify([text, style]);
      let file = images.get(key);
      if (!file) {
        if (!GlobalFonts.has(style.font_family) && !warnings.some((w) => w.font_family === style.font_family))
          warnings.push({ code: "W_FONT_FALLBACK", font_family: style.font_family });
        const canvas = createCanvas(width, height);
        const rendered = renderSubtitle(canvas.getContext("2d"), text, style, width, height);
        warnings.push(...rendered.warnings.map((warning) => ({ ...warning, cue_id: item.cue.cue_id })));
        file = join(directory, `cue-${images.size}.png`);
        await writeFile(file, await canvas.encode("png"));
        images.set(key, file);
      }
      item.file = file;
    }
    const transparent = join(directory, "empty.png");
    await writeFile(transparent, await createCanvas(width, height).encode("png"));
    const cuts = [...new Set([0n, frameCount, ...cues.flatMap((item) => [item.start, item.end])])].sort((a, b) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    const composites = new Map<string, string>();
    const rate = printRational(timeline.edit_rate);
    // Concat timestamps use microseconds. Round absolute boundaries to prevent accumulated drift.
    const micros = (frame: bigint) =>
      floor(add(mul(div(rational(frame), timeline.edit_rate), rational(1000000n)), rational(1n, 2n)));
    const lines = ["ffconcat version 1.0"];
    let last = transparent;
    for (let index = 0; index < cuts.length - 1; index++) {
      const start = cuts[index]!,
        end = cuts[index + 1]!;
      const active = cues.filter((item) => item.start <= start && item.end > start);
      let file = active[0]?.file ?? transparent;
      if (active.length > 1) {
        const key = active.map((item) => item.file).join("\n");
        file = composites.get(key) ?? "";
        if (!file) {
          const canvas = createCanvas(width, height);
          for (const item of active) canvas.getContext("2d").drawImage(await loadImage(item.file), 0, 0);
          file = join(directory, `mix-${composites.size}.png`);
          await writeFile(file, await canvas.encode("png"));
          composites.set(key, file);
        }
      }
      const duration = micros(end) - micros(start);
      const quote = (path: string) => path.replaceAll("'", "'\\''");
      lines.push(
        `file '${quote(file)}'`,
        `option framerate ${rate}`,
        `duration ${duration / 1000000n}.${String(duration % 1000000n).padStart(6, "0")}`,
      );
      last = file;
    }
    lines.push(`file '${last.replaceAll("'", "'\\''")}'`, `option framerate ${rate}`);
    const list = join(directory, "frames.ffconcat");
    await writeFile(list, `${lines.join("\n")}\n`);
    await run("ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "error",
      "-nostdin",
      "-y",
      "-safe",
      "0",
      "-f",
      "concat",
      "-i",
      list,
      "-vf",
      `fps=${rate}:start_time=0:round=near`,
      "-fps_mode",
      "passthrough",
      "-frames:v",
      String(frameCount),
      "-an",
      "-c:v",
      "prores_ks",
      "-profile:v",
      "4444",
      "-pix_fmt",
      "yuva444p10le",
      "-timecode",
      timeline.start_timecode,
      "-f",
      "mov",
      temp,
    ]);
    const { stdout } = await run("ffprobe", [
      "-v",
      "error",
      "-count_frames",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=nb_read_frames",
      "-of",
      "json",
      temp,
    ]);
    const probe = JSON.parse(stdout) as { streams: { nb_read_frames: string }[] };
    if (probe.streams[0]?.nb_read_frames !== String(frameCount)) throw new Error("Overlay frame count readback failed");
    const size = (await stat(temp)).size;
    await rename(temp, overlay.output_path);
    return {
      files: [{ path: overlay.output_path, size_bytes: size }],
      frame_count: Number(frameCount),
      subtitle_count: cues.length,
      warnings,
    };
  } finally {
    await rm(temp, { force: true });
    if (directory) await rm(directory, { recursive: true, force: true });
  }
}
