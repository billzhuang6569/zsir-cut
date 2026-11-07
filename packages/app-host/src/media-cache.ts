import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, readFile, realpath, rename, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { Media, Project, Rational } from "../../core/dist/index.js";

const {
  ceil,
  compare,
  sub,
  div,
  floor,
  mul,
  parseRational,
  printRational,
  rational,
}: typeof import("../../core/dist/index.js") = await import(
  new URL(import.meta.url.endsWith(".ts") ? "../../core/src/index.ts" : "../../core/dist/index.js", import.meta.url)
    .href
);
export const mediaKey = (media: Media) =>
  createHash("sha256").update(`${media.fingerprint.value}|media-v1`).digest("hex").slice(0, 32);
export const frameKey = (at: string) =>
  createHash("sha256")
    .update(printRational(parseRational(at, true), true))
    .digest("hex")
    .slice(0, 32);
export function thumbnailIndex(media: Media) {
  const interval =
    media.kind === "image"
      ? 0
      : compare(media.duration, rational(600n)) < 0
        ? 1
        : compare(media.duration, rational(3600n)) < 0
          ? 2
          : 5;
  return {
    version: 1,
    interval: `${interval}s`,
    tile_width: Math.max(2, Math.round((96 * (media.video?.width ?? 1)) / (media.video?.height ?? 1) / 2) * 2),
    tile_height: 96,
    columns: 10,
    rows: 10,
    count: interval ? Number(ceil(div(media.duration, rational(BigInt(interval))))) : 1,
    sheets: [] as string[],
  };
}
export function pcmPeaks(pcm: Buffer, duration: Rational, channels: number) {
  const peaks = Buffer.alloc(Number(ceil(mul(duration, rational(100n)))));
  for (let sample = 0; sample < Math.floor(pcm.length / (2 * channels)); sample++) {
    const bucket = Math.floor(sample / 100);
    if (bucket >= peaks.length) break;
    for (let channel = 0; channel < channels; channel++) {
      const value = Math.round((Math.abs(pcm.readInt16LE((sample * channels + channel) * 2)) / 32768) * 255);
      peaks[bucket] = Math.max(peaks[bucket] ?? 0, value);
    }
  }
  return peaks;
}
interface Meta {
  media_key: string;
  fingerprint: string;
  duration: string;
  bytes: number;
  last_used: string;
  peaks: "ready" | "missing";
  thumbs: "ready" | "missing";
}
async function atomic(file: string, data: string | Buffer) {
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, data);
    await rename(temp, file);
  } finally {
    await rm(temp, { force: true });
  }
}
async function size(dir: string): Promise<number> {
  let bytes = 0;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isSymbolicLink() || entry.name.startsWith(".") || entry.name.endsWith(".tmp")) continue;
    const path = join(dir, entry.name);
    bytes += entry.isDirectory() ? await size(path) : (await stat(path)).size;
  }
  return bytes;
}
async function saveMeta(dir: string, meta: Meta) {
  const file = join(dir, "meta.json");
  const contentBytes = (await size(dir)) - (await stat(file).catch(() => ({ size: 0 }))).size;
  let json = JSON.stringify(meta);
  while (meta.bytes !== contentBytes + Buffer.byteLength(json)) {
    meta.bytes = contentBytes + Buffer.byteLength(json);
    json = JSON.stringify(meta);
  }
  await atomic(file, json);
}
export class MediaCache {
  private project: Project | undefined;
  private path = "";
  readonly building = new Set<string>();
  readonly failed = new Set<string>();
  private pending = new Map<string, Promise<unknown>>();
  constructor(
    private directory: () => string,
    private available: () => Promise<boolean>,
    private run: (args: string[]) => Promise<Buffer>,
    private changed: (media: Media) => void,
  ) {}
  async open(project: Project | undefined, path: string) {
    this.project = project;
    this.path = path;
    this.failed.clear();
    if (await this.available()) await Promise.all((project?.media ?? []).map((media) => this.touch(mediaKey(media))));
  }
  refresh(project: Project | undefined) {
    this.project = project;
  }
  private async dir(key: string, fallback = false, create = false) {
    if (!/^[a-f0-9]{32}$/.test(key)) throw new Error("Invalid media key");
    const root = fallback ? join(dirname(this.path), ".zcut", this.project?.id ?? "", "cache") : this.directory();
    if (create) await mkdir(root, { recursive: true });
    const realRoot = await realpath(root);
    const media = join(realRoot, "media");
    const dir = join(media, key);
    for (const path of [media, dir]) {
      if (create)
        await mkdir(path).catch((e) => {
          if (e.code !== "EEXIST") throw e;
        });
      if ((await lstat(path)).isSymbolicLink() || dirname(await realpath(path)) !== (path === media ? realRoot : media))
        throw new Error("Invalid media cache directory");
    }
    return dir;
  }
  private async meta(key: string, fallback = false): Promise<Meta | undefined> {
    try {
      const dir = await this.dir(key, fallback);
      const meta = JSON.parse(await readFile(await this.safeFile(dir, "meta.json"), "utf8")) as Meta;
      if (
        meta.media_key !== key ||
        typeof meta.fingerprint !== "string" ||
        typeof meta.last_used !== "string" ||
        !Number.isSafeInteger(meta.bytes) ||
        meta.bytes < 0 ||
        !["ready", "missing"].includes(meta.peaks) ||
        !["ready", "missing"].includes(meta.thumbs)
      )
        return;
      if (meta.peaks === "ready") {
        const peaks = await this.safeFile(dir, "peaks.bin");
        if ((await stat(peaks)).size !== Number(ceil(mul(parseRational(meta.duration, true), rational(100n))))) return;
      }
      if (meta.thumbs === "ready") {
        const index = JSON.parse(await readFile(await this.safeFile(dir, "thumbs.json"), "utf8")) as ReturnType<
          typeof thumbnailIndex
        >;
        if (
          index.version !== 1 ||
          !["0s", "1s", "2s", "5s"].includes(index.interval) ||
          index.columns !== 10 ||
          index.rows !== 10 ||
          index.tile_height !== 96 ||
          !Number.isSafeInteger(index.tile_width) ||
          index.tile_width <= 0 ||
          index.tile_width % 2 ||
          !Number.isSafeInteger(index.count) ||
          index.count <= 0 ||
          !Array.isArray(index.sheets) ||
          index.sheets.length !== Math.ceil(index.count / 100)
        )
          return;
        for (const sheet of index.sheets) {
          if (!/^thumbs-\d{3,}\.jpg$/.test(sheet)) return;
          await this.safeFile(dir, sheet);
        }
      }
      return meta;
    } catch {
      return;
    }
  }
  private async safeFile(dir: string, name: string) {
    const path = join(dir, name);
    if (!(await lstat(path)).isFile() || dirname(await realpath(path)) !== dir)
      throw new Error("Invalid media cache file");
    return path;
  }
  async touch(key: string, fallback = false) {
    const meta = await this.meta(key, fallback);
    if (meta) await saveMeta(await this.dir(key, fallback), { ...meta, last_used: new Date().toISOString() });
  }
  private complete(media: Media, meta: Meta | undefined) {
    return Boolean(
      meta && (!media.audio || meta.peaks === "ready") && (media.kind === "audio" || meta.thumbs === "ready"),
    );
  }
  async needs(media: Media) {
    return !this.failed.has(mediaKey(media)) && !this.complete(media, await this.meta(mediaKey(media)));
  }
  async build(media: Media, fallback = false) {
    const key = mediaKey(media);
    const pendingKey = `${fallback}:${key}`;
    const existing = this.pending.get(pendingKey);
    if (existing) return existing;
    const path = this.path;
    let dir: string | undefined;
    const work = (async () => {
      if (this.complete(media, await this.meta(key, fallback))) return;
      this.building.add(key);
      this.changed(media);
      const source = resolve(dirname(path), media.path);
      const meta: Meta = {
        media_key: key,
        fingerprint: media.fingerprint.value,
        duration: printRational(media.duration, true),
        bytes: 0,
        last_used: new Date().toISOString(),
        peaks: "missing",
        thumbs: "missing",
      };
      if (media.audio) {
        const channels = media.audio.channels;
        const pcm = await this.run([
          "-i",
          source,
          "-vn",
          "-ac",
          String(channels),
          "-ar",
          "10000",
          "-f",
          "s16le",
          "pipe:1",
        ]);
        const peaks = pcmPeaks(pcm, media.duration, channels);
        dir = await this.dir(key, fallback, true);
        await atomic(join(dir, "peaks.bin"), peaks);
        meta.peaks = "ready";
      }
      if (media.kind !== "audio") {
        const index = thumbnailIndex(media);
        dir ??= await this.dir(key, fallback, true);
        const temp = join(dir, `.thumbs-${randomUUID()}`);
        await mkdir(temp);
        try {
          await this.run([
            "-y",
            "-i",
            source,
            "-vf",
            `${media.kind === "image" ? "" : `fps=1/${index.interval.slice(0, -1)}:start_time=0:round=up,`}scale=-2:96,tile=10x10`,
            "-frames:v",
            String(Math.ceil(index.count / 100)),
            "-start_number",
            "0",
            "-q:v",
            "3",
            "-f",
            "image2",
            join(temp, "thumbs-%03d.jpg"),
          ]);
          for (let n = 0; n < Math.ceil(index.count / 100); n++) {
            const name = `thumbs-${String(n).padStart(3, "0")}.jpg`;
            await rename(join(temp, name), join(dir, name));
            index.sheets.push(name);
          }
          await atomic(join(dir, "thumbs.json"), JSON.stringify(index));
          meta.thumbs = "ready";
        } finally {
          await rm(temp, { recursive: true, force: true });
        }
      }
      dir ??= await this.dir(key, fallback, true);
      await saveMeta(dir, meta);
      this.changed(media);
    })()
      .catch(async () => {
        this.failed.add(key);
        if (dir) await rmdir(dir).catch(() => {});
      })
      .finally(() => {
        this.building.delete(key);
        this.pending.delete(pendingKey);
        this.changed(media);
      });
    this.pending.set(pendingKey, work);
    return work;
  }
  async entries() {
    const entries: Meta[] = [];
    for (const key of await readdir(join(this.directory(), "media")).catch(() => [] as string[])) {
      const meta = await this.meta(key);
      if (meta) entries.push({ ...meta, bytes: await size(await this.dir(key)) });
    }
    return entries;
  }
  async status(available: boolean) {
    return Promise.all(
      (this.project?.media ?? []).map(async (media) => {
        const key = mediaKey(media);
        const meta = await this.meta(key, !available);
        const state = (kind: "peaks" | "thumbs") =>
          meta?.[kind] === "ready" ? "ready" : this.building.has(key) ? "building" : "missing";
        return { media_id: media.id, key, peaks: state("peaks"), thumbs: state("thumbs") };
      }),
    );
  }
  directoryOK() {
    return this.available();
  }
  async file(key: string, name: string, at?: string): Promise<string | undefined> {
    const media = this.project?.media.find((m) => mediaKey(m) === key);
    if (!media) return;
    if (!["peaks.bin", "thumbs.json", "frame"].includes(name) && !/^thumbs-\d{3,}\.jpg$/.test(name)) return;
    let time: Rational | undefined;
    if (name === "frame") {
      time = parseRational(at ?? "0s", true);
      if (compare(time, rational(0n)) < 0 || compare(time, media.duration) > 0 || media.kind === "audio") return;
    }
    const fallback = !(await this.available());
    if (fallback) await this.build(media, true);
    if (name === "frame") await this.build(media, fallback);
    const meta = await this.meta(key, fallback);
    if (!meta) return;
    const dir = await this.dir(key, fallback);
    if (name === "frame" && time) {
      const frames = join(dir, "frames");
      const canonical = printRational(time, true);
      const file = join(frames, `${frameKey(canonical)}.jpg`);
      try {
        const cached = await this.safeFile(frames, `${frameKey(canonical)}.jpg`);
        await this.touch(key, fallback);
        return cached;
      } catch {}
      let work = this.pending.get(file);
      if (!work) {
        const sampleAt =
          compare(time, media.duration) === 0 && media.kind !== "image"
            ? sub(time, div(rational(1n), media.video?.rate ?? rational(25n)))
            : time;
        const ns = floor(mul(compare(sampleAt, rational(0n)) < 0 ? rational(0n) : sampleAt, rational(1_000_000_000n)));
        work = (async () => {
          const bytes = await this.run([
            "-ss",
            `${ns / 1_000_000_000n}.${String(ns % 1_000_000_000n).padStart(9, "0")}`,
            "-i",
            resolve(dirname(this.path), media.path),
            "-frames:v",
            "1",
            "-vf",
            "scale=-2:96",
            "-f",
            "image2pipe",
            "-vcodec",
            "mjpeg",
            "pipe:1",
          ]);
          await mkdir(frames).catch((e) => {
            if (e.code !== "EEXIST") throw e;
          });
          if ((await lstat(frames)).isSymbolicLink() || dirname(await realpath(frames)) !== dir)
            throw new Error("Invalid media cache directory");
          await atomic(file, bytes);
          await saveMeta(dir, { ...meta, last_used: new Date().toISOString() });
          this.changed(media);
        })().finally(async () => {
          this.pending.delete(file);
          await rmdir(frames).catch(() => {});
        });
        this.pending.set(file, work);
      }
      await work;
      return this.safeFile(frames, `${frameKey(canonical)}.jpg`);
    }
    if (name === "peaks.bin" ? meta.peaks !== "ready" : meta.thumbs !== "ready") return;
    try {
      const file = await this.safeFile(dir, name);
      await this.touch(key, fallback);
      return file;
    } catch {
      return;
    }
  }
  async remove(key: string) {
    await rm(await this.dir(key), { recursive: true, force: true });
    this.failed.add(key);
  }
  async clear() {
    // Delete only validated cache directories, never legacy project-side files.
    for (const key of await readdir(join(this.directory(), "media")).catch(() => [] as string[])) {
      try {
        await this.remove(key);
      } catch {}
    }
  }
  async idle() {
    await Promise.allSettled(this.pending.values());
  }
}
