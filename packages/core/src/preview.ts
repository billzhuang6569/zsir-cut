import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { subtitleFiles } from "./export-framework.js";
import { clipTimeMap, sourceFrameAt } from "./project/time-map.js";
import type { Clip, Media, MediaTrack, Project, Timeline } from "./project/types.js";
import { add, ceil, compare, div, floor, mul, printRational, type Rational, rational, sub } from "./rational.js";

const zero = rational(0n);
const endOf = (clip: Clip) => add(clip.timeline_start, clip.duration);
const seconds = (value: Rational) => {
  const scaled = floor(mul(value, rational(1_000_000_000n)));
  return `${scaled / 1_000_000_000n}.${String(scaled % 1_000_000_000n).padStart(9, "0")}`;
};
const fileHash = (data: Buffer) => createHash("sha256").update(data).digest("hex");

async function ffmpeg(args: string[], input?: AsyncIterable<Buffer>): Promise<void> {
  const child = spawn("ffmpeg", ["-hide_banner", "-loglevel", "error", "-nostdin", ...args], {
    stdio: [input ? "pipe" : "ignore", "ignore", "pipe"],
  });
  let errors = "";
  child.on("error", (error) => {
    errors += error.message;
  });
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (part: string) => {
    errors += part;
  });
  const exit = new Promise<number | null>((done) => child.once("close", done));
  if (input) {
    const stdin = child.stdin;
    if (!stdin) throw new Error("ffmpeg input pipe missing");
    stdin.on("error", (error) => {
      errors += error.message;
    });
    try {
      for await (const frame of input) if (!stdin.write(frame)) await once(stdin, "drain");
      stdin.end();
    } catch (error) {
      child.kill();
      throw error;
    }
  }
  const code = await exit;
  if (code !== 0) throw new Error(`ffmpeg exited ${code}: ${errors.trim()}`);
}

export function timelineFrames(timeline: Timeline): bigint {
  const end = timeline.tracks
    .flatMap((track) => (track.kind === "subtitle" ? [] : track.clips))
    .reduce((best, clip) => (compare(endOf(clip), best) > 0 ? endOf(clip) : best), zero);
  return ceil(mul(end, timeline.edit_rate));
}

function videoLayers(project: Project, timeline: Timeline, frame: bigint) {
  const at = div(rational(frame), timeline.edit_rate);
  const tracks = timeline.tracks.filter((track): track is MediaTrack => track.kind === "video" && track.enabled);
  const layers = [];
  for (const track of tracks) {
    const clip = track.clips.find(
      (item) => item.enabled !== false && compare(at, item.timeline_start) >= 0 && compare(at, endOf(item)) < 0,
    );
    if (!clip) continue;
    const media = project.media.find((item) => item.id === clip.media_id);
    if (!media) throw new Error(`Missing media ${clip.media_id}`);
    const rate = media.kind === "image" ? rational(25n) : media.video?.rate;
    if (!rate) throw new Error(`Media ${media.id} has no video rate`);
    layers.push({
      clip_id: clip.id,
      media_id: media.id,
      source_frame: media.kind === "image" ? 0n : sourceFrameAt(clip, sub(at, clip.timeline_start), rate),
    });
  }
  return layers;
}

export function visibleFrame(project: Project, timeline: Timeline, frame: bigint) {
  return videoLayers(project, timeline, frame).at(-1) ?? null;
}

function cuts(timeline: Timeline): bigint[] {
  const end = timelineFrames(timeline);
  const points = new Set<bigint>();
  for (const track of timeline.tracks) {
    if (track.kind !== "video" || !track.enabled) continue;
    for (const clip of track.clips) {
      if (clip.enabled === false) continue;
      points.add(floor(mul(clip.timeline_start, timeline.edit_rate)));
      points.add(floor(mul(endOf(clip), timeline.edit_rate)));
    }
  }
  return [...points].filter((point) => point > 0n && point < end).sort((a, b) => compare(rational(a), rational(b)));
}

async function sourceFrames(project: Project, timeline: Timeline, projectPath: string, directory: string) {
  const paths = new Map<string, { directory: string; extension: string; alpha: boolean }>();
  const used = new Set(
    timeline.tracks.flatMap((track) =>
      track.kind === "video" && track.enabled
        ? track.clips.filter((clip) => clip.enabled !== false).map((clip) => clip.media_id)
        : [],
    ),
  );
  for (const media of project.media.filter((item) => used.has(item.id) && item.kind !== "audio")) {
    const source = resolve(dirname(projectPath), media.path);
    const target = join(directory, media.id);
    await mkdir(target);
    const { stdout } = await promisify(execFile)("ffprobe", [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=pix_fmt",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      source,
    ]);
    const alpha = /^(?:yuva|rgba|bgra|argb|abgr|gbrap)/.test(stdout.trim());
    const extension = alpha ? "png" : "jpg";
    await ffmpeg([
      "-i",
      source,
      "-map",
      "0:v:0",
      "-vf",
      `scale=640:360:force_original_aspect_ratio=decrease,pad=640:360:(ow-iw)/2:(oh-ih)/2:color=black@${alpha ? "0" : "1"}${alpha ? ",format=rgba" : ""}`,
      "-q:v",
      "2",
      "-fps_mode",
      "passthrough",
      "-start_number",
      "0",
      join(target, `%08d.${extension}`),
    ]);
    paths.set(media.id, { directory: target, extension, alpha });
  }
  return paths;
}

function framePath(
  paths: Awaited<ReturnType<typeof sourceFrames>>,
  frame: ReturnType<typeof visibleFrame>,
  blank: string,
) {
  if (!frame) return blank;
  const source = paths.get(frame.media_id);
  if (!source || frame.source_frame < 0n)
    throw new Error(`Invalid source frame ${frame.media_id}:${frame.source_frame}`);
  return join(source.directory, `${String(frame.source_frame).padStart(8, "0")}.${source.extension}`);
}

async function frameImage(
  project: Project,
  timeline: Timeline,
  frame: bigint,
  paths: Awaited<ReturnType<typeof sourceFrames>>,
  blank: string,
  directory: string,
) {
  let picture = blank;
  for (const [index, layer] of videoLayers(project, timeline, frame).entries()) {
    const source = framePath(paths, layer, blank);
    if (!paths.get(layer.media_id)?.alpha) {
      picture = source;
      continue;
    }
    const composited = join(directory, `composite-${frame}-${index}.jpg`);
    await ffmpeg([
      "-i",
      picture,
      "-i",
      source,
      "-filter_complex",
      "[0:v][1:v]overlay=0:0:format=auto[out]",
      "-map",
      "[out]",
      "-frames:v",
      "1",
      "-q:v",
      "2",
      "-y",
      composited,
    ]);
    picture = composited;
  }
  return picture;
}

async function blankFrame(directory: string) {
  const path = join(directory, "blank.jpg");
  await ffmpeg(["-f", "lavfi", "-i", "color=c=black:s=640x360", "-frames:v", "1", "-q:v", "2", path]);
  return path;
}

async function audioClip(media: Media, clip: Clip, projectPath: string, path: string) {
  const points = clipTimeMap(clip);
  const filters: string[] = [];
  const inputs: string[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const first = points[i];
    const last = points[i + 1];
    if (!first || !last) throw new Error("Invalid time map");
    const duration = sub(last.at, first.at);
    if (first.interp === "hold" || compare(first.source, last.source) === 0) {
      inputs.push("-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo");
      filters.push(`[${i}:a]atrim=duration=${seconds(duration)},asetpts=PTS-STARTPTS[s${i}]`);
    } else {
      inputs.push("-i", resolve(dirname(projectPath), media.path));
      const reverse = compare(first.source, last.source) > 0;
      const start = reverse ? last.source : first.source;
      const end = reverse ? first.source : last.source;
      const speed = div(sub(end, start), duration);
      const channels = clip.source_channels;
      const pan = channels?.length
        ? `pan=${channels.length === 1 ? "mono" : "stereo"}|${[0, ...(channels.length === 1 ? [] : [1])]
            .map((output) => {
              const selected = channels.filter((_, index) => index % 2 === output);
              return `c${output}=${selected.map((channel) => `${1 / selected.length}*c${channel}`).join("+")}`;
            })
            .join("|")},`
        : "";
      filters.push(
        `[${i}:a]${pan}atrim=start=${seconds(start)}:end=${seconds(end)},asetpts=PTS-STARTPTS${reverse ? ",areverse" : ""},atempo=${seconds(speed)},aresample=48000[s${i}]`,
      );
    }
  }
  const concat =
    points.length > 2
      ? `${filters.map((_, i) => `[s${i}]`).join("")}concat=n=${filters.length}:v=0:a=1[a]`
      : "[s0]anull[a]";
  await ffmpeg([
    ...inputs,
    "-filter_complex",
    `${filters.join(";")};${concat};[a]${clip.gain_db === undefined ? "anull" : `volume=${clip.gain_db}dB`},apad,atrim=duration=${seconds(clip.duration)}[out]`,
    "-map",
    "[out]",
    "-ar",
    "48000",
    "-ac",
    "2",
    "-c:a",
    "pcm_s16le",
    "-y",
    path,
  ]);
}

async function soundFiles(project: Project, timeline: Timeline, projectPath: string, directory: string) {
  const sounds: { path: string; delay: bigint }[] = [];
  for (const track of timeline.tracks) {
    if (track.kind !== "audio" || !track.enabled) continue;
    for (const clip of track.clips) {
      if (clip.enabled === false) continue;
      const media = project.media.find((item) => item.id === clip.media_id);
      if (!media?.audio) continue;
      const path = join(directory, `audio-${sounds.length}.wav`);
      await audioClip(media, clip, projectPath, path);
      sounds.push({ path, delay: floor(mul(clip.timeline_start, rational(48_000n))) });
    }
  }
  return sounds;
}

export interface PreviewOptions {
  output: string;
  profile: string;
  exportId: string;
  subtitleLanguages?: string[];
}

export async function renderPreview(
  project: Project,
  timeline: Timeline,
  projectPath: string,
  options: PreviewOptions,
) {
  const directory = await mkdtemp(join(tmpdir(), "zcut-preview-"));
  try {
    const paths = await sourceFrames(project, timeline, projectPath, directory);
    const blank = await blankFrame(directory);
    const sounds = await soundFiles(project, timeline, projectPath, directory);
    const subtitles = subtitleFiles(project, timeline).filter(
      (file) =>
        file.role === "subtitle" && (!options.subtitleLanguages || options.subtitleLanguages.includes(file.language)),
    );
    const subtitlePaths: string[] = [];
    for (const file of subtitles) {
      const path = join(directory, file.name);
      await writeFile(path, file.data);
      subtitlePaths.push(path);
    }
    const count = timelineFrames(timeline);
    if (count <= 0n) throw new Error("Timeline has no frames");
    await mkdir(dirname(options.output), { recursive: true });
    const inputs = [
      "-f",
      "image2pipe",
      "-framerate",
      printRational(timeline.edit_rate),
      "-c:v",
      "mjpeg",
      "-i",
      "pipe:0",
    ];
    for (const sound of sounds) inputs.push("-i", sound.path);
    if (!sounds.length) inputs.push("-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo");
    for (const path of subtitlePaths) inputs.push("-i", path);
    const audioIndex = sounds.length ? undefined : 1;
    const filters = sounds.map((sound, i) => `[${i + 1}:a]adelay=${sound.delay}S:all=1[a${i}]`);
    if (sounds.length)
      filters.push(
        `${sounds.map((_, i) => `[a${i}]`).join("")}amix=inputs=${sounds.length}:normalize=0,apad,atrim=duration=${seconds(div(rational(count), timeline.edit_rate))}[aout]`,
      );
    const subtitleStart = 1 + Math.max(1, sounds.length);
    const args = [
      ...inputs,
      ...(filters.length ? ["-filter_complex", filters.join(";")] : []),
      "-map",
      "0:v",
      "-map",
      sounds.length ? "[aout]" : `${audioIndex}:a`,
      ...subtitlePaths.flatMap((_, i) => ["-map", `${subtitleStart + i}:s:0`]),
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-pix_fmt",
      "yuv420p",
      "-crf",
      "25",
      "-c:a",
      "aac",
      "-b:a",
      "128k",
      "-c:s",
      "mov_text",
      ...subtitles.flatMap((file, i) => [`-metadata:s:s:${i}`, `handler_name=${file.language}`]),
      "-metadata",
      `title=${project.name}`,
      "-metadata",
      `comment=revision=${project.revision.seq};profile=${options.profile};export_id=${options.exportId}`,
      "-metadata",
      `description=${project.name};revision=${project.revision.seq};profile=${options.profile};export_id=${options.exportId}`,
      "-timecode",
      timeline.start_timecode,
      "-frames:v",
      String(count),
      "-t",
      seconds(div(rational(count), timeline.edit_rate)),
      "-movflags",
      "+faststart",
      "-y",
      options.output,
    ];
    async function* pictures() {
      for (let frame = 0n; frame < count; frame++)
        yield await readFile(await frameImage(project, timeline, frame, paths, blank, directory));
    }
    await ffmpeg(args, pictures());
    return { path: options.output, sha256: fileHash(await readFile(options.output)), frames: String(count) };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function viewTimeline(project: Project, timeline: Timeline, projectPath: string, output: string) {
  const directory = await mkdtemp(join(tmpdir(), "zcut-filmstrip-"));
  try {
    await mkdir(output, { recursive: true });
    const paths = await sourceFrames(project, timeline, projectPath, directory);
    const blank = await blankFrame(directory);
    const items = [];
    for (const [index, cut] of cuts(timeline).entries()) {
      const before = visibleFrame(project, timeline, cut - 1n);
      const after = visibleFrame(project, timeline, cut);
      const path = join(output, `cut-${String(index + 1).padStart(4, "0")}.png`);
      await ffmpeg([
        "-i",
        await frameImage(project, timeline, cut - 1n, paths, blank, directory),
        "-i",
        await frameImage(project, timeline, cut, paths, blank, directory),
        "-filter_complex",
        "[0:v][1:v]hstack=inputs=2[out]",
        "-map",
        "[out]",
        "-frames:v",
        "1",
        "-y",
        path,
      ]);
      items.push({
        at_frame: String(cut),
        before: before && { ...before, source_frame: String(before.source_frame) },
        after: after && { ...after, source_frame: String(after.source_frame) },
        file: basename(path),
      });
    }
    const sounds = await soundFiles(project, timeline, projectPath, directory);
    const waveform = join(output, "waveform.png");
    if (sounds.length) {
      const filters = sounds.map((sound, i) => `[${i}:a]adelay=${sound.delay}S:all=1[a${i}]`);
      filters.push(
        `${sounds.map((_, i) => `[a${i}]`).join("")}amix=inputs=${sounds.length}:normalize=0,apad,atrim=duration=${seconds(div(rational(timelineFrames(timeline)), timeline.edit_rate))},showwavespic=s=1600x240:colors=white[wave]`,
      );
      await ffmpeg([
        ...sounds.flatMap((sound) => ["-i", sound.path]),
        "-filter_complex",
        filters.join(";"),
        "-map",
        "[wave]",
        "-frames:v",
        "1",
        "-y",
        waveform,
      ]);
    } else
      await ffmpeg([
        "-f",
        "lavfi",
        "-i",
        "anullsrc=r=48000:cl=stereo",
        "-t",
        seconds(div(rational(timelineFrames(timeline)), timeline.edit_rate)),
        "-filter_complex",
        "showwavespic=s=1600x240:colors=white",
        "-frames:v",
        "1",
        "-y",
        waveform,
      ]);
    const manifest = {
      timeline_id: timeline.id,
      revision: project.revision.id,
      cuts: items,
      waveform: basename(waveform),
    };
    await writeFile(join(output, "view.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    return { directory: output, cuts: items.length, waveform };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
