import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
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
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import type { Clip, Media, Project, Rational } from "../../core/dist/index.js";
import { runFfmpeg } from "./media.js";
import type { DesktopPreferences } from "./preferences.js";

const { add, sub, div, mul, rational, compare, floor, printRational }: typeof import("../../core/dist/index.js") =
  await import(
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
        "v1",
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
  audio.push(`atempo=${decimal(tempo)}`);
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
    "-f",
    "mp4",
    output,
  ];
}
interface Index {
  project_path: string;
  last_opened: string;
  segments: Record<string, { bytes: number }>;
}
type Segment = { clip: Clip; media: Media; key: string };
export class PreviewCache {
  private project: Project | undefined;
  private path = "";
  private playhead = rational(0n);
  private needed: Segment[] = [];
  private building: string | undefined;
  private failed = new Set<string>();
  private opened = new Date().toISOString();
  private work: Promise<void> | undefined;
  private stopped = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private poll: ReturnType<typeof setInterval>;
  private controls = Promise.resolve();
  private statusVersion = 0;
  private lastPush = 0;
  private lastStatus = "";
  constructor(
    private prefs: DesktopPreferences,
    private emit: (status: Awaited<ReturnType<PreviewCache["status"]>>) => void,
    private battery = async () => {
      try {
        return /Now drawing from 'Battery Power'/.test(
          (await promisify(execFile)("pmset", ["-g", "batt"], { timeout: 3000 })).stdout,
        );
      } catch {
        return false;
      }
    },
  ) {
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
    for (const [key, value] of Object.entries(data.segments))
      if (!keyPattern.test(key) || !Number.isSafeInteger(value.bytes) || value.bytes < 0)
        throw new Error("Invalid cache segment");
    return data;
  }
  private async save(id: string, index: Index) {
    const dir = await this.projectDir(id, true);
    const temp = join(dir, "index.json.tmp");
    await writeFile(temp, `${canonical(index)}\n`);
    await rename(temp, join(dir, "index.json"));
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
    const quality = this.settings().quality;
    this.needed =
      project?.timelines[0]?.tracks.flatMap((track) =>
        track.kind !== "video" || !track.enabled
          ? []
          : track.clips.flatMap((clip) => {
              const media = project.media.find((media) => media.id === clip.media_id);
              return clip.enabled === false || media?.kind !== "video"
                ? []
                : [{ clip, media, key: segmentKey(clip, media, quality) }];
            }),
      ) ?? [];
    this.kick();
    await this.push();
  }
  hint(at: Rational) {
    this.playhead = at;
    this.kick();
  }
  private kick() {
    if (this.work || this.stopped || !this.project || !this.settings().auto) return;
    this.work = this.run()
      .catch(() => {})
      .finally(() => {
        this.work = undefined;
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
    await this.save(project.id, index);
    while (!this.stopped && this.project?.id === project.id && this.settings().auto) {
      if (this.settings().pause_on_battery && (await this.battery())) break;
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
          if (!index.segments[segment.key]) {
            index.segments[segment.key] = { bytes: file.size };
            await this.save(project.id, index);
          }
        } catch {
          next = segment;
          break;
        }
      }
      if (!next) break;
      const { clip, media, key } = next;
      const dir = await this.projectDir(project.id);
      const temp = join(dir, `${key}.tmp`);
      const args = segmentArgs(clip, media, this.settings().quality, resolve(dirname(this.path), media.path), temp);
      if (!args) {
        this.failed.add(key);
        continue;
      }
      this.building = key;
      await this.push();
      try {
        try {
          await runFfmpeg(args);
        } catch {
          await runFfmpeg(
            segmentArgs(clip, media, this.settings().quality, resolve(dirname(this.path), media.path), temp, false) ??
              [],
          );
        }
        if (this.stopped) {
          await rm(temp, { force: true });
          break;
        }
        const file = join(dir, `${key}.mp4`);
        await rename(temp, file);
        index.segments[key] = { bytes: (await stat(file)).size };
        await this.save(project.id, index);
        await this.enforceLimit();
        index = await this.index(project.id);
      } catch {
        this.failed.add(key);
        await rm(temp, { force: true }).catch(() => {});
      } finally {
        this.building = undefined;
        await this.push();
      }
    }
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
  async enforceLimit() {
    const projects = await this.projects();
    let total = projects.reduce((sum, p) => sum + p.bytes, 0);
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
  }
  async status() {
    const directory_ok = await this.directoryOK();
    const projects = directory_ok ? await this.projects() : [];
    const fs = directory_ok ? await statfs(this.settings().directory).catch(() => null) : null;
    const segments = await Promise.all(
      this.needed.map(async ({ clip, key }) => {
        let state = "missing";
        if (directory_ok) {
          if (this.building === key) state = "building";
          else
            try {
              await stat(join(await this.projectDir(this.project?.id ?? ""), `${key}.mp4`));
              state = "ready";
            } catch {}
        }
        return { clip_id: clip.id, key, state };
      }),
    );
    return {
      segments,
      directory: this.settings().directory,
      directory_ok,
      free_bytes: fs ? fs.bavail * fs.bsize : 0,
      used_bytes: projects.reduce((sum, p) => sum + p.bytes, 0),
      limit_bytes: this.settings().limit_gb * 1_000_000_000,
      projects,
    };
  }
  private async push() {
    this.statusVersion++;
    if (this.stopped || this.timer) return;
    this.timer = setTimeout(
      () => {
        const version = this.statusVersion;
        void this.status()
          .then((status) => {
            const value = JSON.stringify(status);
            if (value !== this.lastStatus && !this.stopped) {
              this.lastStatus = value;
              this.lastPush = Date.now();
              this.emit(status);
            }
          })
          .catch(() => {})
          .finally(() => {
            this.timer = undefined;
            if (version !== this.statusVersion) void this.push();
          });
      },
      Math.max(0, this.lastPush + 500 - Date.now()),
    );
    this.timer.unref();
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
    await this.work;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }
  clear(id?: string) {
    return this.control(async () => {
      await this.stopWork();
      try {
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
        await this.refresh();
      }
    });
  }
  close() {
    clearInterval(this.poll);
    return this.control(() => this.stopWork());
  }
  async idle() {
    await this.work;
  }
}
