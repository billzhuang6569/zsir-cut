import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, symlink, truncate, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { parseProject, rational } from "../../core/src/index.ts";
import { mediaChannel } from "../src/media.js";
import { frameKey, MediaCache, mediaKey, pcmPeaks, thumbnailIndex } from "../src/media-cache.js";
import { DesktopPreferences } from "../src/preferences.js";
import { PreviewCache } from "../src/preview-cache.js";

let root: string;
let cache: PreviewCache;
let prefs: DesktopPreferences;
let project: Extract<ReturnType<typeof parseProject>, { ok: true }>["project"];
const run = vi.fn(async (args: string[]) => {
  const output = args.at(-1) ?? "";
  if (output.endsWith(".tmp")) await writeFile(output, "segment");
  if (args.includes("image2")) {
    const count = Number(args[args.indexOf("-frames:v") + 1]);
    for (let i = 0; i < count; i++) await writeFile(output.replace("%03d", String(i).padStart(3, "0")), "sheet");
  }
  if (args.includes("s16le")) {
    const bytes = Buffer.alloc(800);
    bytes.writeInt16LE(-32768, 2);
    bytes.writeInt16LE(16384, 400);
    return bytes;
  }
  return Buffer.from("jpeg");
});
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "zcut-media-cache-"));
  prefs = new DesktopPreferences(join(root, "prefs"));
  await prefs.set({ preview_cache: { directory: join(root, "cache"), auto: false, pause_on_battery: true } });
  const parsed = parseProject(await readFile(new URL("../../../examples/minimal.zcut.json", import.meta.url), "utf8"));
  if (!parsed.ok) throw new Error("fixture");
  project = parsed.project;
  run.mockClear();
  cache = new PreviewCache(
    prefs,
    () => {},
    async () => true,
    "/Volumes",
    run,
  );
});
afterEach(async () => {
  await cache.close();
  await rm(root, { recursive: true, force: true });
});
const path = () => join(root, "project.zcut.json");
const first = () => {
  const media = project.media[0];
  if (!media) throw new Error("fixture");
  return media;
};
const directory = () => join(root, "cache", "media", mediaKey(first()));

it("does not create media folders on open, status, reads or lookups of uncached keys", async () => {
  await mkdir(join(root, "cache"));
  const media = new MediaCache(
    () => join(root, "cache"),
    async () => true,
    run,
    () => {},
  );
  const base = first();
  const unused = ["unused-a", "unused-b", "unused-c"].map((value) => ({
    ...base,
    fingerprint: { ...base.fingerprint, value },
  }));
  await media.open({ ...project, media: [base, ...unused] }, path());
  await media.status(true);
  await media.status(false);
  await media.entries();
  for (const item of [base, ...unused]) {
    expect(await media.needs(item)).toBe(true);
    await media.touch(mediaKey(item));
    expect(await media.file(mediaKey(item), "peaks.bin")).toBeUndefined();
    expect(await media.file(mediaKey(item), "thumbs.json")).toBeUndefined();
  }
  expect(run).not.toHaveBeenCalled();
  await expect(stat(join(root, "cache", "media"))).rejects.toThrow();
  await media.build(base);
  await media.status(true);
  expect(await readdir(join(root, "cache", "media"))).toEqual([mediaKey(base)]);
});
it.each([true, false])("leaves no empty media folder after generation fails (audio: %s)", async (audio) => {
  await mkdir(join(root, "cache"));
  const item = { ...first() };
  if (!audio) delete item.audio;
  const directoriesDuringDecode: boolean[] = [];
  const media = new MediaCache(
    () => join(root, "cache"),
    async () => true,
    async (args) => {
      if (args.includes("s16le"))
        directoriesDuringDecode.push(
          await stat(directory()).then(
            () => true,
            () => false,
          ),
        );
      throw new Error("generation failed");
    },
    () => {},
  );
  await media.open(project, path());
  await media.build(item);
  expect(directoriesDuringDecode).toEqual(audio ? [false] : []);
  expect((await media.status(true))[0]).toMatchObject({ peaks: "missing", thumbs: "missing" });
  expect(media.failed.has(mediaKey(item))).toBe(true);
  await expect(stat(directory())).rejects.toThrow();
});
it("does not leave an empty frames folder when on-demand decoding fails", async () => {
  await mkdir(join(root, "cache"));
  const media = new MediaCache(
    () => join(root, "cache"),
    async () => true,
    async (args) => {
      if (args.includes("image2pipe")) throw new Error("frame failed");
      return run(args);
    },
    () => {},
  );
  await media.open(project, path());
  await media.build(first());
  await expect(media.file(mediaKey(first()), "frame", "1s")).rejects.toThrow("frame failed");
  await expect(stat(join(directory(), "frames"))).rejects.toThrow();
  expect((await media.status(true))[0]).toMatchObject({ peaks: "ready", thumbs: "ready" });
});

it("uses fingerprint-only keys, canonical frame times, exact 100Hz Uint8 peaks and maximum across channels", () => {
  const media = first();
  expect(mediaKey(media)).toBe(
    createHash("sha256").update(`${media.fingerprint.value}|media-v1`).digest("hex").slice(0, 32),
  );
  expect(mediaKey({ ...media, path: "elsewhere" })).toBe(mediaKey(media));
  expect(frameKey("1s")).toBe(createHash("sha256").update("1s").digest("hex").slice(0, 32));
  expect(() => frameKey("2/2s")).toThrow("Noncanonical");
  const pcm = Buffer.alloc(804);
  pcm.writeInt16LE(-32768, 2);
  pcm.writeInt16LE(16384, 400);
  pcm.writeInt16LE(32767, 800);
  expect([...pcmPeaks(pcm, rational(21n, 1000n), 2)]).toEqual([255, 128, 255]);
  expect([...pcmPeaks(pcm, rational(15n, 1000n), 2)]).toEqual([255, 128]);
});
it("indexes interval boundaries, padded sheet names and single stills", async () => {
  const media = first();
  for (const [seconds, interval, count] of [
    [599, "1s", 599],
    [600, "2s", 300],
    [3599, "2s", 1800],
    [3600, "5s", 720],
  ] as const) {
    expect(thumbnailIndex({ ...media, duration: rational(BigInt(seconds)) })).toMatchObject({
      interval,
      count,
      columns: 10,
      rows: 10,
      tile_height: 96,
    });
  }
  expect(thumbnailIndex({ ...media, kind: "image" })).toMatchObject({ interval: "0s", count: 1 });
  media.duration = rational(201n);
  await cache.open(project, path());
  await cache.idle();
  const index = JSON.parse(await readFile(join(directory(), "thumbs.json"), "utf8"));
  expect(index).toMatchObject({ count: 201, sheets: ["thumbs-000.jpg", "thumbs-001.jpg", "thumbs-002.jpg"] });
  expect(run.mock.calls.filter(([args]) => args.includes("image2"))).toHaveLength(1);
  expect(run.mock.calls.some(([args]) => args.includes("fps=1/1:start_time=0:round=up,scale=-2:96,tile=10x10"))).toBe(
    true,
  );
});
it("builds once on battery with auto off, reuses across projects, reports bytes and emits ready", async () => {
  const pushes: unknown[] = [];
  await cache.close();
  cache = new PreviewCache(
    prefs,
    (status) => pushes.push(status),
    async () => true,
    "/Volumes",
    run,
  );
  await cache.open(project, path());
  await cache.idle();
  const status = await cache.status();
  expect(status.media).toEqual([{ media_id: first().id, key: mediaKey(first()), peaks: "ready", thumbs: "ready" }]);
  expect(status.segments.every((item) => item.state === "missing")).toBe(true);
  expect(status.used_bytes).toBeGreaterThan(0);
  expect(status.used_bytes).toBe(status.media_bytes);
  const meta = JSON.parse(await readFile(join(directory(), "meta.json"), "utf8"));
  expect(meta.bytes).toBe(status.media_bytes);
  expect((await readdir(directory())).some((name) => name.endsWith(".tmp"))).toBe(false);
  expect((await readFile(join(directory(), "peaks.bin"))).length).toBe(
    Number((first().duration.numerator * 100n) / first().duration.denominator),
  );
  await vi.waitFor(() =>
    expect(pushes).toContainEqual(
      expect.objectContaining({ media_ready: [{ media_id: first().id, key: mediaKey(first()) }] }),
    ),
  );
  const count = run.mock.calls.length;
  await cache.open({ ...project, id: "prj_another" }, path());
  await cache.idle();
  expect(run).toHaveBeenCalledTimes(count);
});
it("runs at most two media tasks, timeline media first, before preview segments and new imports", async () => {
  let active = 0,
    maximum = 0;
  const order: string[] = [];
  await cache.close();
  const encode = async (args: string[]) => {
    const isSegment = args.includes("mp4");
    if (isSegment) expect(order.filter((item) => item === "sheet")).toHaveLength(3);
    order.push(isSegment ? "segment" : args.includes("image2") ? "sheet" : "peaks");
    maximum = Math.max(maximum, ++active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    try {
      return await run(args);
    } finally {
      active--;
    }
  };
  cache = new PreviewCache(
    prefs,
    () => {},
    async () => false,
    "/Volumes",
    encode,
    async () => ({
      streams: [{ index: 0, codec_type: "video", r_frame_rate: "25", width: 1280, height: 720, time_base: "1/25" }],
      summaries: new Map([[0, { count: 2, first300: [{ pts: 0n, duration: 1n }], last: { pts: 1n, duration: 1n } }]]),
    }),
  );
  const base = first();
  project.media.unshift({ ...base, id: "med_unused", fingerprint: { ...base.fingerprint, value: "unused" } });
  project.media.push({ ...base, id: "med_other", fingerprint: { ...base.fingerprint, value: "other" } });
  await prefs.set({ preview_cache: { auto: true } });
  await cache.open(project, path());
  await cache.idle();
  expect(maximum).toBe(2);
  expect((await cache.status()).segments[0]).toMatchObject({ state: "ready", duration: "2/25s" });
  expect(run.mock.calls[0]?.[0]).toContain(join(root, base.path));
  const before = run.mock.calls.length;
  project.media.push({ ...base, id: "med_new", fingerprint: { ...base.fingerprint, value: "new" } });
  await cache.refresh(project);
  await cache.idle();
  expect(run.mock.calls.length).toBe(before + 2);
});
it("keeps material on project clear, clears it globally, and evicts previews before old then current media", async () => {
  await cache.open(project, path());
  await cache.idle();
  await cache.clear(project.id);
  expect((await stat(join(directory(), "meta.json"))).isFile()).toBe(true);
  await prefs.set({ preview_cache: { limit_gb: 1 } });
  const oldMedia = { ...first(), fingerprint: { ...first().fingerprint, value: "old" } };
  project.media.push(oldMedia);
  await cache.refresh(project);
  await cache.idle();
  const old = join(root, "cache", "media", mediaKey(oldMedia));
  for (const dir of [old, directory()]) {
    const meta = JSON.parse(await readFile(join(dir, "meta.json"), "utf8"));
    await writeFile(join(dir, "padding"), "");
    await truncate(join(dir, "padding"), 600_000_000);
    await writeFile(join(dir, "meta.json"), JSON.stringify({ ...meta, last_used: dir === old ? "2020" : "2026" }));
  }
  project.media.pop();
  await cache.refresh(project);
  await cache.idle();
  const preview = join(root, "cache", "prj_old");
  await mkdir(preview);
  await writeFile(
    join(preview, "index.json"),
    JSON.stringify({
      project_path: "old",
      last_opened: "2000",
      segments: { ["a".repeat(32)]: { bytes: 900_000_000 } },
    }),
  );
  await cache.enforceLimit();
  await expect(stat(preview)).rejects.toThrow();
  await expect(stat(old)).rejects.toThrow();
  expect((await stat(directory())).isDirectory()).toBe(true);
  await cache.clear();
  await expect(stat(directory())).rejects.toThrow();
});
it("does not mark partial outputs ready and does not follow cache symlinks", async () => {
  await cache.close();
  cache = new PreviewCache(
    prefs,
    () => {},
    async () => false,
    "/Volumes",
    async (args) => {
      if (args.includes("image2")) throw new Error("interrupted");
      return run(args);
    },
  );
  await cache.open(project, path());
  await cache.idle();
  expect((await cache.status()).media[0]).toMatchObject({ peaks: "missing", thumbs: "missing" });
  await expect(stat(join(directory(), "meta.json"))).rejects.toThrow();
  await rm(directory(), { recursive: true });
  await mkdir(join(root, "outside"));
  await symlink(join(root, "outside"), directory());
  expect(await cache.media.file(mediaKey(first()), "peaks.bin")).toBeUndefined();
});
class Response extends Writable {
  status = 0;
  headersSent = false;
  chunks: Buffer[] = [];
  setHeader() {}
  writeHead(status: number) {
    this.status = status;
    this.headersSent = true;
    return this;
  }
  _write(chunk: Buffer, _encoding: string, done: () => void) {
    this.chunks.push(Buffer.from(chunk));
    done();
  }
}
it("authenticates media routes, returns 404 before ready then 200, and reuses exact frames and legacy reads", async () => {
  await cache.open(project, path());
  await cache.idle();
  const key = mediaKey(first());
  const serve = mediaChannel(path(), "secret", async () => project, run, undefined, cache.media);
  const request = async (url: string, method = "GET") => {
    const response = new Response();
    const finished = new Promise((resolve) => response.on("finish", resolve));
    await serve({ url, method, headers: {} } as IncomingMessage, response as unknown as ServerResponse);
    await finished;
    return { status: response.status, bytes: Buffer.concat(response.chunks) };
  };
  expect((await request(`/media-cache/${key}/peaks.bin`)).status).toBe(401);
  expect((await request(`/media-cache/${"0".repeat(32)}/peaks.bin?token=secret`)).status).toBe(404);
  expect((await request(`/media-cache/${key}/thumbs.json?token=secret&path=x`)).status).toBe(404);
  expect((await request(`/media-cache/${key}/peaks.bin?token=secret`)).status).toBe(200);
  expect((await request(`/media-cache/${key}/thumbs.json?token=secret`, "HEAD")).bytes.length).toBe(0);
  const count = run.mock.calls.length;
  for (const at of ["1s", "1s"])
    expect((await request(`/media-cache/${key}/frame?token=secret&at=${at}`)).bytes.toString()).toBe("jpeg");
  expect(run).toHaveBeenCalledTimes(count + 1);
  expect((await request(`/thumb?token=secret&media_id=${first().id}&at=1s`)).bytes.toString()).toBe("jpeg");
  const binary = (await request(`/media-cache/${key}/peaks.bin?token=secret`)).bytes;
  expect(JSON.parse((await request(`/peaks?token=secret&media_id=${first().id}`)).bytes.toString())).toEqual(
    [...binary].map((value) => value / 255),
  );
  await cache.clear();
  expect((await request(`/media-cache/${key}/peaks.bin?token=secret`)).status).toBe(404);
});

it("only generates applicable files for audio and still images", async () => {
  const base = first();
  const audio = {
    ...base,
    id: "med_audio",
    kind: "audio" as const,
    fingerprint: { ...base.fingerprint, value: "audio" },
  };
  const image = {
    ...base,
    id: "med_image",
    kind: "image" as const,
    fingerprint: { ...base.fingerprint, value: "image" },
  };
  delete image.audio;
  project.media = [audio, image];
  await cache.open(project, path());
  await cache.idle();
  const status = await cache.status();
  expect(status.media).toEqual([
    { media_id: audio.id, key: mediaKey(audio), peaks: "ready", thumbs: "missing" },
    { media_id: image.id, key: mediaKey(image), peaks: "missing", thumbs: "ready" },
  ]);
  const index = JSON.parse(await readFile(join(root, "cache", "media", mediaKey(image), "thumbs.json"), "utf8"));
  expect(index).toMatchObject({ count: 1, interval: "0s", sheets: ["thumbs-000.jpg"] });
  expect(run).toHaveBeenCalledTimes(2);
});
it("falls back on demand when the configured directory cannot be used and leaves legacy files on clear", async () => {
  await writeFile(join(root, "not-directory"), "source");
  await prefs.set({ preview_cache: { directory: join(root, "not-directory", "cache") } });
  await cache.open(project, path());
  await cache.idle();
  expect((await cache.status()).directory_ok).toBe(false);
  expect(run).not.toHaveBeenCalled();
  const key = mediaKey(first());
  const file = await cache.media.file(key, "peaks.bin");
  expect(file).toBe(await realpath(join(root, ".zcut", project.id, "cache", "media", key, "peaks.bin")));
  expect((await readFile(file ?? "")).length).toBeGreaterThan(0);
  await cache.clear();
  expect((await stat(file ?? "")).isFile()).toBe(true);
  expect(await readFile(join(root, "not-directory"), "utf8")).toBe("source");
});
