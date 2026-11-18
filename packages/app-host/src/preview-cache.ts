import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  statfs,
  utimes,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { Clip, Media, Probe, Project, Rational } from "../../core/dist/index.js";
import { runFfmpeg, thumbnailTask } from "./media.js";
import { MediaCache, mediaKey } from "./media-cache.js";
import type { DesktopPreferences } from "./preferences.js";

const {
  add,
  sub,
  div,
  mul,
  rational,
  compare,
  floor,
  ceil,
  clipTimeMap,
  mapClipTimeToSource,
  printRational,
  parseRational,
  ffprobe,
}: typeof import("../../core/dist/index.js") = await import(
  new URL(import.meta.url.endsWith(".ts") ? "../../core/src/index.ts" : "../../core/dist/index.js", import.meta.url)
    .href
);
const projectPattern = /^prj_[a-zA-Z0-9_-]+$/;
const keyPattern = /^[a-f0-9]{32}$/;
const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, item) =>
    item !== null && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : item,
  );
const sourceEnd = (clip: Clip) => clip.time_map?.at(-1)?.source ?? add(clip.source_start, clip.duration);
export function segmentKey(clip: Clip, media: Media, quality: string) {
  const speed = clip.time_map
    ? canonical(
        clip.time_map.map((point) => ({
          at: printRational(point.at, true),
          source: printRational(point.source, true),
          interp: point.interp,
        })),
      )
    : "1";
  return createHash("sha256")
    .update(
      [
        media.fingerprint.value,
        printRational(clip.source_start, true),
        printRational(sourceEnd(clip), true),
        speed,
        quality,
        "v2",
      ].join("|"),
    )
    .digest("hex")
    .slice(0, 32);
}
function decimal(value: Rational) {
  const ns = floor(mul(value, rational(1_000_000_000n)));
  return `${ns / 1_000_000_000n}.${String(ns % 1_000_000_000n).padStart(9, "0")}`;
}
export function segmentArgs(
  clip: Clip,
  media: Media,
  quality: string,
  source: string,
  output: string,
  hardware = true,
) {
  const end = sourceEnd(clip);
  const reverse = compare(end, clip.source_start) < 0;
  const span = reverse ? sub(clip.source_start, end) : sub(end, clip.source_start);
  if (span.numerator === 0n || !media.video) return null;
  const speed = div(span, clip.duration);
  // shortcut: varying speed and holds remain missing; extend when piecewise rendering is required.
  const signedSpeed = div(sub(end, clip.source_start), clip.duration);
  if (
    clip.time_map?.some(
      (point, index, points) =>
        compare(point.source, add(clip.source_start, mul(point.at, signedSpeed))) !== 0 ||
        (index < points.length - 1 && point.interp !== "linear"),
    )
  )
    return null;
  const short = quality.slice(0, -1);
  const scale = `scale=w='if(gte(iw,ih),-2,${short})':h='if(gte(iw,ih),${short},-2)'`;
  const video = [
    reverse ? "reverse" : "",
    `setpts=(PTS-STARTPTS)*${speed.denominator}/${speed.numerator}`,
    scale,
  ].filter(Boolean);
  const audio = reverse ? ["areverse"] : [];
  let tempo = speed;
  while (compare(tempo, rational(2n)) > 0) {
    audio.push("atempo=2");
    tempo = div(tempo, rational(2n));
  }
  while (compare(tempo, rational(1n, 2n)) < 0) {
    audio.push("atempo=0.5");
    tempo = mul(tempo, rational(2n));
  }
  audio.push(`atempo=${decimal(tempo)}`, "apad");
  const gop = floor(add(div(media.video.rate, rational(2n)), rational(1n, 2n)));
  return [
    "-y",
    "-ss",
    decimal(reverse ? end : clip.source_start),
    "-t",
    decimal(span),
    "-i",
    source,
    "-map",
    "0:v:0",
    "-map",
    "0:a:0?",
    "-vf",
    video.join(","),
    "-af",
    audio.join(","),
    "-c:v",
    hardware ? "h264_videotoolbox" : "libx264",
    ...(hardware ? [] : ["-preset", "veryfast"]),
    "-pix_fmt",
    "yuv420p",
    "-g",
    String(gop > 0n ? gop : 1n),
    "-c:a",
    "aac",
    "-ar",
    "48000",
    "-ac",
    "1",
    "-movflags",
    "+frag_keyframe+empty_moov+default_base_moof",
    "-map_metadata",
    "-1",
    "-fflags",
    "+bitexact",
    "-flags:v",
    "+bitexact",
    "-flags:a",
    "+bitexact",
    "-t",
    decimal(clip.duration),
    "-f",
    "mp4",
    output,
  ];
}
interface Index {
  project_path: string;
  last_opened: string;
  segments: Record<string, { bytes: number; duration?: string }>;
}
type Layer = { clip: Clip; media: Media };
type Segment = {
  clip: Clip;
  key: string;
  quality: string;
  layers: Layer[];
  audio: boolean;
  canvas?: { width: number; height: number; rate: Rational };
};

export function previewSegments(project: Project, quality: string): Segment[] {
  const timeline = project.timelines[0];
  if (!timeline) return [];
  const mediaById = new Map(project.media.map((media) => [media.id, media]));
  const cuts = new Map<string, { at: Rational; starts: Layer[]; ends: Layer[] }>();
  const layerOrder = new Map<Layer, number>();
  function cut(at: Rational) {
    const key = printRational(at, true);
    const entry = cuts.get(key) ?? { at, starts: [], ends: [] };
    cuts.set(key, entry);
    return entry;
  }
  for (const track of timeline.tracks) {
    if (track.kind !== "video" || !track.enabled) continue;
    for (const clip of track.clips) {
      const media = mediaById.get(clip.media_id);
      if (clip.enabled === false || (media?.kind !== "video" && media?.kind !== "image")) continue;
      const layer = { clip, media };
      layerOrder.set(layer, layerOrder.size);
      cut(clip.timeline_start).starts.push(layer);
      cut(add(clip.timeline_start, clip.duration)).ends.push(layer);
    }
  }
  const ordered = [...cuts.values()].sort((a, b) => compare(a.at, b.at));
  const active = new Set<Layer>();
  const result: Segment[] = [];
  const short = Number(quality.slice(0, -1));
  const { width, height, pixel_aspect } = timeline.format;
  const aspect = (width * Number(pixel_aspect?.numerator ?? 1n)) / (height * Number(pixel_aspect?.denominator ?? 1n));
  const canvas = {
    width: Math.round((short * Math.max(1, aspect)) / 2) * 2,
    height: Math.round((short * Math.max(1, 1 / aspect)) / 2) * 2,
    rate: timeline.edit_rate,
  };
  for (const [index, { at, starts, ends }] of ordered.entries()) {
    for (const id of ends) active.delete(id);
    for (const id of starts) active.add(id);
    const next = ordered[index + 1]?.at;
    if (!active.size || !next) continue;
    const visible = [...active].sort((a, b) => (layerOrder.get(a) ?? 0) - (layerOrder.get(b) ?? 0));
    const top = visible.at(-1);
    if (!top) continue;
    const duration = sub(next, at);
    const audio = visible[0]?.media.audio !== undefined;
    const t = top.clip.transform;
    const transformed =
      (t?.scale ?? 1) !== 1 ||
      !!t?.rotation_deg ||
      !!t?.position?.some(Boolean) ||
      Object.values(t?.crop ?? {}).some(Boolean);
    if (
      visible.length === 1 &&
      !transformed &&
      compare(at, top.clip.timeline_start) === 0 &&
      compare(duration, top.clip.duration) === 0
    ) {
      if (top.media.kind === "video")
        result.push({ clip: top.clip, layers: visible, quality, audio, key: segmentKey(top.clip, top.media, quality) });
      continue;
    }
    const key = createHash("sha256")
      .update(
        canonical({
          version: "layers-v1",
          quality,
          audio,
          canvas: [canvas.width, canvas.height, printRational(canvas.rate)],
          duration: printRational(duration, true),
          layers: visible.map(({ clip, media }) => [
            media.kind,
            media.video && printRational(media.video.rate),
            segmentKey(clip, media, quality),
            printRational(sub(at, clip.timeline_start), true),
            clip.transform ?? {},
          ]),
        }),
      )
      .digest("hex")
      .slice(0, 32);
    result.push({ clip: { ...top.clip, timeline_start: at, duration }, key, quality, layers: visible, audio, canvas });
  }
  return result;
}

export function previewSegmentArgs(segment: Segment, projectPath: string, output: string, hardware = true) {
  const { audio, canvas, clip, layers, quality } = segment;
  const path = (media: Media) => resolve(dirname(projectPath), media.path);
  if (!canvas) {
    const layer = layers[0];
    return layer ? segmentArgs(clip, layer.media, quality, path(layer.media), output, hardware) : null;
  }
  const { width, height, rate } = canvas;
  const fps = printRational(rate);
  const duration = decimal(clip.duration);
  const inputs: string[] = [];
  const frames = ceil(mul(clip.duration, rate));
  const filters = [`color=black:s=${width}x${height}:r=${fps},trim=end_frame=${frames},format=yuv444p[base0]`];
  let input = 0;
  for (const [index, layer] of layers.entries()) {
    const { clip: item, media } = layer;
    const t = item.transform;
    const crop = t?.crop;
    const left = crop?.left ?? 0,
      right = crop?.right ?? 0,
      top = crop?.top ?? 0,
      bottom = crop?.bottom ?? 0;
    if (left + right >= 1 || top + bottom >= 1) {
      filters.push(`[base${index}]null[base${index + 1}]`);
      continue;
    }
    const offset = sub(clip.timeline_start, item.timeline_start);
    const end = add(offset, clip.duration);
    const map = clipTimeMap(item);
    const parts: string[] = [];
    for (const [part, first] of map.entries()) {
      const last = map[part + 1];
      if (!last) break;
      const from = compare(offset, first.at) > 0 ? offset : first.at;
      const to = compare(end, last.at) < 0 ? end : last.at;
      if (compare(from, to) >= 0) continue;
      const source = mapClipTimeToSource(item, from);
      const out = first.interp === "hold" ? source : mapClipTimeToSource(item, to);
      const sign = compare(out, source);
      const frame = media.video ? div(rational(1n), media.video.rate) : div(rational(1n), rate);
      const length = sub(to, from);
      const speed = sign === 0 ? rational(1n) : div(length, sign < 0 ? sub(source, out) : sub(out, source));
      // On a mixed-rate cut, include the source frame already covering the in-point.
      const lower = sign < 0 ? out : source;
      const upper = sign < 0 ? source : out;
      const sourceIn = mul(rational(floor(div(lower, frame))), frame);
      const sourceOut = sign === 0 ? add(sourceIn, frame) : mul(rational(ceil(div(upper, frame))), frame);
      const firstFrame = ceil(mul(sub(from, offset), rate));
      const frameCount = ceil(mul(sub(to, offset), rate)) - firstFrame;
      if (frameCount <= 0n) continue;
      if (media.kind === "image") inputs.push("-framerate", fps, "-i", path(media));
      else inputs.push("-ss", decimal(sourceIn), "-t", decimal(sub(sourceOut, sourceIn)), "-i", path(media));
      const label = `part${input}`;
      filters.push(
        `[${input++}:v:0]${sign < 0 ? "reverse," : ""}setpts=(PTS-STARTPTS)*${speed.numerator}/${speed.denominator},` +
          `tpad=stop_mode=clone:stop_duration=${decimal(add(length, div(rational(1n), rate)))},fps=fps=${fps}:start_time=0,` +
          `trim=end_frame=${frameCount},setpts=PTS+${firstFrame}[${label}]`,
      );
      parts.push(`[${label}]`);
    }
    const scale = t?.scale ?? 1;
    const angle = (t?.rotation_deg ?? 0) % 360;
    const [x, y] = t?.position ?? [0, 0];
    const prefix = parts.length > 1 ? `interleave=n=${parts.length},settb=expr=1/(${fps}),setpts=N,` : "";
    // Crop in source coordinates while retaining the original centre of rotation.
    filters.push(
      `${parts.join("")}${prefix}scale=w='max(1,round(min(${width},${height}*dar)*${scale}))':` +
        `h='max(1,round(min(${height},${width}/dar)*${scale}))',setsar=1,format=yuva444p,` +
        `crop=w='max(1,iw*${1 - left - right})':h='max(1,ih*${1 - top - bottom})':x='iw*${left}':y='ih*${top}',` +
        `pad=w='iw/(1-${left}-${right})':h='ih/(1-${top}-${bottom})':x='ow*${left}':y='oh*${top}':color=black@0,` +
        `rotate=${-angle}*PI/180:ow=rotw(${-angle}*PI/180):oh=roth(${-angle}*PI/180):c=black@0[layer${index}]`,
      `[base${index}][layer${index}]overlay=x='(W-w)/2+${x}*W':y='(H-h)/2-${y}*H':format=yuv444[base${index + 1}]`,
    );
  }
  return [
    "-y",
    ...inputs,
    ...(audio ? ["-f", "lavfi", "-i", "anullsrc=r=48000:cl=mono"] : []),
    "-filter_complex_threads",
    "1",
    "-filter_complex",
    filters.join(";"),
    "-map",
    `[base${layers.length}]`,
    ...(audio ? ["-map", `${input}:a:0`] : []),
    "-c:v",
    hardware ? "h264_videotoolbox" : "libx264",
    ...(hardware ? [] : ["-preset", "veryfast"]),
    "-pix_fmt",
    "yuv420p",
    "-bf",
    "0",
    "-g",
    String(floor(add(div(rate, rational(2n)), rational(1n, 2n)))),
    // Offset AAC priming so MP4 muxing does not stretch the first video packet.
    ...(audio ? ["-c:a", "aac", "-af", "asetpts=PTS+1024/SR/TB", "-flags:a", "+bitexact"] : []),
    "-movflags",
    "+frag_keyframe+empty_moov+default_base_moof",
    "-map_metadata",
    "-1",
    "-fflags",
    "+bitexact",
    "-flags:v",
    "+bitexact",
    "-t",
    duration,
    "-f",
    "mp4",
    output,
  ];
}

export class PreviewCache {
  readonly media: MediaCache;
  private project: Project | undefined;
  private path = "";
  private playhead = rational(0n);
  private needed: Segment[] = [];
  private building: string | undefined;
  private controller: AbortController | undefined;
  private failed = new Set<string>();
  private opened = new Date().toISOString();
  private work: Promise<void> | undefined;
  private rerun = false;
  private eviction = Promise.resolve();
  private stopped = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private poll: ReturnType<typeof setInterval>;
  private controls = Promise.resolve();
  private statusVersion = 0;
  private lastPush = 0;
  private lastStatus = "";
  private lastMedia = new Map<string, { peaks: string; thumbs: string }>();
  constructor(
    private prefs: DesktopPreferences,
    private emit: (
      status: Awaited<ReturnType<PreviewCache["status"]>> & { media_ready: { media_id: string; key: string }[] },
    ) => void,
    private battery = async () => {
      try {
        return /Now drawing from 'Battery Power'/.test(
          (await promisify(execFile)("pmset", ["-g", "batt"], { timeout: 3000 })).stdout,
        );
      } catch {
        return false;
      }
    },
    private volumesRoot = "/Volumes",
    private encode = runFfmpeg,
    private probe: Probe = ffprobe,
  ) {
    this.media = new MediaCache(
      () => this.settings().directory,
      () => this.directoryOK(),
      (args) => thumbnailTask(() => this.encode(args), new AbortController().signal),
      () => {
        void this.push();
      },
      (args, signal) => this.encode(args, signal),
      () => {
        void this.enforceLimit()
          .then(() => this.push())
          .catch(() => {});
      },
    );
    this.poll = setInterval(() => {
      this.kick();
      void this.push();
    }, 5000);
    this.poll.unref();
  }
  private settings() {
    const p = this.prefs.get();
    return { ...p.prefs.preview_cache, directory: p.preview_cache_directory };
  }
  private async directoryOK() {
    try {
      const directory = this.settings().directory;
      const withinVolumes = relative(this.volumesRoot, directory);
      const volume = withinVolumes.split(sep)[0];
      if (volume && volume !== ".." && !isAbsolute(withinVolumes)) {
        // Never create an absent volume's mount point on the startup disk.
        if (!(await stat(join(this.volumesRoot, volume))).isDirectory()) return false;
      }
      await mkdir(directory, { recursive: true });
      await access(directory, constants.W_OK);
      return (await stat(directory)).isDirectory();
    } catch {
      return false;
    }
  }
  private async projectDir(id: string, create = false) {
    if (!projectPattern.test(id)) throw new Error("Invalid cache project");
    const root = await realpath(this.settings().directory);
    const path = join(root, id);
    if (create)
      await mkdir(path, { recursive: false }).catch((error) => {
        if (error.code !== "EEXIST") throw error;
      });
    if ((await lstat(path)).isSymbolicLink() || dirname(await realpath(path)) !== root)
      throw new Error("Invalid cache directory");
    return path;
  }
  private async index(id: string): Promise<Index> {
    const data = JSON.parse(await readFile(join(await this.projectDir(id), "index.json"), "utf8")) as Index;
    if (
      typeof data.project_path !== "string" ||
      typeof data.last_opened !== "string" ||
      !data.segments ||
      typeof data.segments !== "object"
    )
      throw new Error("Invalid cache index");
    for (const [key, value] of Object.entries(data.segments)) {
      if (!keyPattern.test(key) || !Number.isSafeInteger(value.bytes) || value.bytes < 0)
        throw new Error("Invalid cache segment");
      if (value.duration !== undefined) {
        if (parseRational(value.duration, true).numerator <= 0n) throw new Error("Invalid cache duration");
      }
    }
    return data;
  }
  private async save(id: string, index: Index) {
    const dir = await this.projectDir(id, true);
    const temp = join(dir, `index.json.${randomUUID()}.tmp`);
    try {
      await writeFile(temp, `${canonical(index)}\n`);
      await rename(temp, join(dir, "index.json"));
    } finally {
      await rm(temp, { force: true });
    }
  }
  private async duration(path: string) {
    const data = await this.probe(path);
    const video = data.streams.find(
      (stream) => stream.codec_type === "video" && stream.disposition?.attached_pic !== 1,
    );
    const packets = video && data.summaries?.get(video.index);
    const first = packets?.first300[0],
      last = packets?.last;
    if (!video?.time_base || !first || !last) throw new Error("Video packet timing unavailable");
    // Cache cuts can be a single frame, which the media import classifier rejects.
    const ticks = last.pts - first.pts + last.duration;
    const duration = mul(rational(ticks), parseRational(video.time_base, false, false));
    if (duration.numerator <= 0n) throw new Error("Invalid cache duration");
    return printRational(duration, true);
  }
  private control<T>(action: () => Promise<T>) {
    const next = this.controls.then(action);
    this.controls = next.then(
      () => {},
      () => {},
    );
    return next;
  }
  open(project: Project | undefined, path = "") {
    return this.control(async () => {
      await this.stopWork();
      this.project = project;
      this.path = path ? resolve(path) : "";
      await this.media.open(project, this.path);
      this.playhead = rational(0n);
      this.opened = new Date().toISOString();
      this.failed.clear();
      if (project && (await this.directoryOK())) {
        let index: Index;
        try {
          index = await this.index(project.id);
        } catch {
          index = { project_path: this.path, last_opened: this.opened, segments: {} };
        }
        index.last_opened = this.opened;
        index.project_path = this.path;
        await this.save(project.id, index).catch(() => {});
      }
      this.stopped = false;
      await this.refresh(project);
    });
  }
  async refresh(project = this.project) {
    this.project = project;
    this.media.refresh(project);
    this.needed = project ? previewSegments(project, this.settings().quality) : [];
    if (this.building && !this.needed.some((segment) => segment.key === this.building)) this.controller?.abort();
    this.rerun = true;
    this.kick();
    await this.push();
  }
  hint(at: Rational) {
    this.playhead = at;
    this.rerun = true;
    this.kick();
  }
  private kick() {
    if (this.work || this.stopped || !this.project) return;
    this.rerun = false;
    this.work = this.run()
      .catch(() => {})
      .finally(() => {
        this.work = undefined;
        if (this.rerun) this.kick();
      });
  }
  private async run() {
    if (!(await this.directoryOK())) return;
    const project = this.project;
    if (!project) return;
    let index: Index;
    try {
      index = await this.index(project.id);
    } catch {
      index = { project_path: this.path, last_opened: this.opened, segments: {} };
    }
    index.last_opened = this.opened;
    index.project_path = this.path;
    if (this.settings().auto) await this.save(project.id, index);
    while (!this.stopped && this.project?.id === project.id) {
      const orderedMedia = this.orderedMedia();
      const missing = [];
      for (const item of orderedMedia) if (await this.media.needs(item)) missing.push(item);
      if (missing.length) {
        await Promise.all(missing.slice(0, 2).map((item) => this.media.build(item)));
        await this.enforceLimit();
        continue;
      }
      if (!this.settings().auto || (this.settings().pause_on_battery && (await this.battery()))) break;
      if (!(await this.directoryOK())) break;
      const ordered = [...this.needed].sort((a, b) => {
        const rank = (s: Segment) =>
          compare(add(s.clip.timeline_start, s.clip.duration), this.playhead) <= 0
            ? 2
            : compare(s.clip.timeline_start, this.playhead) <= 0
              ? 0
              : 1;
        const ar = rank(a),
          br = rank(b);
        return ar - br || (ar === 2 ? -1 : 1) * compare(a.clip.timeline_start, b.clip.timeline_start);
      });
      let next: Segment | undefined;
      for (const segment of ordered) {
        if (this.failed.has(segment.key)) continue;
        try {
          const file = await stat(join(await this.projectDir(project.id), `${segment.key}.mp4`));
          if (!index.segments[segment.key]?.duration) {
            const path = join(await this.projectDir(project.id), `${segment.key}.mp4`);
            const duration = await this.duration(path);
            index.segments[segment.key] = { bytes: file.size, duration };
            await this.save(project.id, index);
          }
        } catch {
          next = segment;
          break;
        }
      }
      if (!next) break;
      const { key } = next;
      const dir = await this.projectDir(project.id);
      const temp = join(dir, `${key}.tmp`);
      const args = previewSegmentArgs(next, this.path, temp);
      if (!args) {
        this.failed.add(key);
        continue;
      }
      if (this.stopped || !this.needed.some((segment) => segment.key === key)) continue;
      const controller = new AbortController();
      this.controller = controller;
      this.building = key;
      await this.push();
      try {
        try {
          await thumbnailTask(() => this.encode(args, controller.signal), controller.signal);
        } catch {
          controller.signal.throwIfAborted();
          await thumbnailTask(
            () => this.encode(previewSegmentArgs(next, this.path, temp, false) ?? [], controller.signal),
            controller.signal,
          );
        }
        controller.signal.throwIfAborted();
        const duration = await this.duration(temp);
        controller.signal.throwIfAborted();
        const file = join(dir, `${key}.mp4`);
        await rename(temp, file);
        index.segments[key] = { bytes: (await stat(file)).size, duration };
        await this.save(project.id, index);
        await this.enforceLimit();
        index = await this.index(project.id);
      } catch {
        if (!controller.signal.aborted) this.failed.add(key);
        await rm(temp, { force: true }).catch(() => {});
      } finally {
        this.building = undefined;
        this.controller = undefined;
        await this.push();
      }
    }
    await this.enforceLimit();
  }
  private orderedMedia() {
    const clips =
      this.project?.timelines[0]?.tracks.flatMap((track) => (track.kind === "subtitle" ? [] : track.clips)) ?? [];
    const distance = (id: string) => {
      const uses = clips.filter((clip) => clip.media_id === id);
      if (!uses.length) return undefined;
      return uses
        .map((clip) => {
          const end = add(clip.timeline_start, clip.duration);
          return compare(this.playhead, clip.timeline_start) < 0
            ? sub(clip.timeline_start, this.playhead)
            : compare(this.playhead, end) >= 0
              ? sub(this.playhead, end)
              : rational(0n);
        })
        .sort(compare)[0];
    };
    return [...(this.project?.media ?? [])].sort((a, b) => {
      const da = distance(a.id),
        db = distance(b.id);
      return da && db ? compare(da, db) : da ? -1 : db ? 1 : 0;
    });
  }
  private async projects() {
    const projects: { project_id: string; name: string; path: string; bytes: number; last_opened: string }[] = [];
    for (const id of await readdir(this.settings().directory).catch(() => [] as string[])) {
      if (!projectPattern.test(id)) continue;
      try {
        const index = await this.index(id);
        let name = basename(index.project_path, ".zcut.json");
        if (id === this.project?.id) name = this.project.name;
        else {
          try {
            const stored = JSON.parse(await readFile(index.project_path, "utf8"));
            if (typeof stored.name === "string") name = stored.name;
          } catch {}
        }
        projects.push({
          project_id: id,
          name,
          path: index.project_path,
          bytes: Object.values(index.segments).reduce((sum, segment) => sum + segment.bytes, 0),
          last_opened: index.last_opened,
        });
      } catch {}
    }
    return projects;
  }
  enforceLimit() {
    const next = this.eviction.then(() => this.evict());
    this.eviction = next.catch(() => {});
    return next;
  }
  private async evict() {
    const projects = await this.projects();
    const media = await this.media.entries();
    let total = projects.reduce((sum, p) => sum + p.bytes, 0) + media.reduce((sum, m) => sum + m.bytes, 0);
    const limit = this.settings().limit_gb * 1_000_000_000;
    projects.sort(
      (a, b) =>
        Number(a.project_id === this.project?.id) - Number(b.project_id === this.project?.id) ||
        a.last_opened.localeCompare(b.last_opened),
    );
    for (const project of projects) {
      if (total <= limit) break;
      const dir = await this.projectDir(project.project_id);
      if (project.project_id !== this.project?.id) {
        await rm(dir, { recursive: true });
        total -= project.bytes;
        continue;
      }
      const index = await this.index(project.project_id);
      const segments = await Promise.all(
        Object.entries(index.segments).map(async ([key, segment]) => ({
          key,
          ...segment,
          time: (await stat(join(dir, `${key}.mp4`)).catch(() => ({ mtimeMs: 0 }))).mtimeMs,
        })),
      );
      for (const segment of segments.sort((a, b) => a.time - b.time)) {
        if (total <= limit) break;
        await rm(join(dir, `${segment.key}.mp4`), { force: true });
        delete index.segments[segment.key];
        total -= segment.bytes;
        this.failed.add(segment.key); // Do not immediately rebuild an evicted segment in this session.
      }
      await this.save(project.project_id, index);
    }
    const current = new Set(this.project?.media.map(mediaKey));
    media.sort(
      (a, b) =>
        Number(current.has(a.media_key)) - Number(current.has(b.media_key)) || a.last_used.localeCompare(b.last_used),
    );
    for (const entry of media) {
      if (total <= limit) break;
      await this.media.remove(entry.media_key);
      total -= entry.bytes;
    }
  }
  async status() {
    const directory_ok = await this.directoryOK();
    if (directory_ok) this.kick();
    const projects = directory_ok ? await this.projects() : [];
    const fs = directory_ok ? await statfs(this.settings().directory).catch(() => null) : null;
    const project = this.project;
    const needed = this.needed;
    const index = directory_ok && project ? await this.index(project.id).catch(() => null) : null;
    const revision = project?.revision.id;
    const segments = await Promise.all(
      needed.map(async ({ clip, key, canvas, audio }) => {
        let state = "missing";
        let duration: string | undefined;
        if (directory_ok) {
          if (this.building === key) state = "building";
          else
            try {
              await stat(join(await this.projectDir(project?.id ?? ""), `${key}.mp4`));
              state = "ready";
              duration = index?.segments[key]?.duration;
            } catch {}
        }
        return {
          clip_id: clip.id,
          key,
          state,
          start: printRational(clip.timeline_start, true),
          end: printRational(add(clip.timeline_start, clip.duration), true),
          composite: !!canvas,
          audio,
          ...(duration ? { duration } : {}),
        };
      }),
    );
    const mediaEntries = directory_ok ? await this.media.entries() : [];
    const media_bytes = mediaEntries.reduce((sum, entry) => sum + entry.bytes, 0);
    const paused = this.settings().pause_on_battery && (await this.battery());
    return {
      ...(paused ? { paused: "battery" as const } : {}),
      media: await this.media.status(directory_ok),
      media_bytes,
      segments,
      revision,
      directory: this.settings().directory,
      directory_ok,
      free_bytes: fs ? fs.bavail * fs.bsize : 0,
      used_bytes: projects.reduce((sum, p) => sum + p.bytes, 0) + media_bytes,
      limit_bytes: this.settings().limit_gb * 1_000_000_000,
      projects,
    };
  }
  private async push() {
    this.statusVersion++;
    if (this.stopped || this.timer) return;
    const timer = setTimeout(
      () => {
        const version = this.statusVersion;
        void this.status()
          .then((status) => {
            const value = JSON.stringify(status);
            if (this.timer === timer && value !== this.lastStatus && !this.stopped) {
              this.lastStatus = value;
              this.lastPush = Date.now();
              const previous = this.lastMedia;
              const media_ready = status.media
                .filter((item) => {
                  const before = previous.get(item.key);
                  return (
                    (item.peaks === "ready" && before?.peaks !== "ready") ||
                    (item.thumbs === "ready" && before?.thumbs !== "ready")
                  );
                })
                .map(({ media_id, key }) => ({ media_id, key }));
              this.lastMedia = new Map(status.media.map((item) => [item.key, item]));
              this.emit({ ...status, media_ready });
            }
          })
          .catch(() => {})
          .finally(() => {
            if (this.timer !== timer) return;
            this.timer = undefined;
            if (version !== this.statusVersion) void this.push();
          });
      },
      Math.max(0, this.lastPush + 500 - Date.now()),
    );
    this.timer = timer;
    timer.unref();
  }
  async file(id: string, key: string) {
    if (!keyPattern.test(key)) return undefined;
    try {
      const index = await this.index(id);
      if (!index.segments[key]) return undefined;
      const file = join(await this.projectDir(id), `${key}.mp4`);
      if ((await lstat(file)).isSymbolicLink()) return undefined;
      const now = new Date();
      await utimes(file, now, now);
      return file;
    } catch {
      return undefined;
    }
  }
  private async stopWork() {
    this.stopped = true;
    this.controller?.abort();
    await this.work;
    await this.media.idle();
    await this.eviction;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }
  clear(id?: string) {
    return this.control(async () => {
      await this.stopWork();
      try {
        if (!id) await this.media.clear();
        for (const project of await this.projects()) {
          if (!id || project.project_id === id)
            await rm(await this.projectDir(project.project_id), { recursive: true });
        }
      } finally {
        this.stopped = false;
        await this.push();
      }
    });
  }
  updatePreferences(patch: unknown) {
    return this.control(async () => {
      await this.stopWork();
      try {
        return await this.prefs.set(patch);
      } finally {
        this.stopped = false;
        this.failed.clear();
        this.media.failed.clear();
        await this.refresh();
      }
    });
  }
  close() {
    clearInterval(this.poll);
    return this.control(() => this.stopWork());
  }
  async idle() {
    while (this.work) await this.work;
  }
}
