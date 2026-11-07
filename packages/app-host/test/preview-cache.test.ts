import { createHash } from "node:crypto";
import { on, once } from "node:events";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { parseProject, rational } from "../../core/src/index.ts";
import { DesktopPreferences } from "../src/preferences.js";
import { PreviewCache, segmentArgs, segmentKey } from "../src/preview-cache.js";

let root: string;
let prefs: DesktopPreferences;
let cache: PreviewCache;
let originalPath: string | undefined;
let pushes: { at: number; value: unknown }[];
async function fixture() {
  const parsed = parseProject(
    await readFile(new URL("../../../examples/interview.zcut.json", import.meta.url), "utf8"),
  );
  if (!parsed.ok) throw new Error("fixture");
  return parsed.project;
}
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "zcut-cache-"));
  await mkdir(join(root, "cache"));
  prefs = new DesktopPreferences(join(root, "prefs"));
  await prefs.set({ preview_cache: { directory: join(root, "cache"), pause_on_battery: false } });
  await writeFile(
    join(root, "ffmpeg"),
    `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(join(root, "calls"))}, JSON.stringify(args)+'\\n');
if (args.includes('h264_videotoolbox') && fs.existsSync(${JSON.stringify(join(root, "fallback"))})) process.exit(1);
if (args.includes('image2')) {
  const count = Number(args[args.indexOf('-frames:v')+1]);
  for (let i=0; i<count; i++) fs.writeFileSync(args.at(-1).replace('%03d', String(i).padStart(3, '0')), 'sheet');
} else if (args.at(-1) === 'pipe:1') process.stdout.write(Buffer.alloc(400));
else if (fs.existsSync(${JSON.stringify(join(root, "hold"))})) {
  fs.writeFileSync(args.at(-1), 'partial');
  process.on('SIGTERM', () => {
    fs.appendFileSync(${JSON.stringify(join(root, "killed"))}, args.at(-1)+'\\n');
    process.exit(0);
  });
  const timer = setInterval(() => {
    if (!fs.existsSync(${JSON.stringify(join(root, "hold"))})) {
      clearInterval(timer);
      fs.writeFileSync(args.at(-1), '0123456789');
    }
  }, 10);
} else setTimeout(() => fs.writeFileSync(args.at(-1), '0123456789'), 15);
`,
  );
  await chmod(join(root, "ffmpeg"), 0o755);
  await writeFile(
    join(root, "ffprobe"),
    `#!/usr/bin/env node
const fs = require('node:fs');
if (fs.existsSync(${JSON.stringify(join(root, "probe-fail"))})) process.exit(1);
fs.appendFileSync(${JSON.stringify(join(root, "probes"))}, process.argv.at(-1)+'\\n');
console.log(process.argv.includes('-show_packets')
  ? (fs.existsSync(${JSON.stringify(join(root, "one-frame"))}) ? 'stream_index=0|pts=0|duration=1001' : 'stream_index=0|pts=0|duration=1001\\nstream_index=0|pts=1001|duration=1001')
  : JSON.stringify({streams:[{index:0,codec_type:'video',r_frame_rate:'30000/1001',width:1280,height:720,time_base:'1/30000'}]}));
`,
  );
  await chmod(join(root, "ffprobe"), 0o755);
  originalPath = process.env.PATH;
  process.env.PATH = `${root}:${originalPath}`;
  pushes = [];
  cache = new PreviewCache(prefs, (value) => pushes.push({ at: Date.now(), value }));
});
afterEach(async () => {
  vi.useRealTimers();
  await cache.close();
  process.env.PATH = originalPath;
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});
const calls = async () =>
  (await readFile(join(root, "calls"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as string[])
    .filter((args) => args.includes("mp4"));

describe("preview cache", () => {
  it("creates the default cache directory under a fresh HOME and starts encoding", async () => {
    await cache.close();
    vi.stubEnv("HOME", join(root, "home"));
    prefs = new DesktopPreferences(join(root, "fresh-prefs"));
    cache = new PreviewCache(
      prefs,
      () => {},
      async () => true,
    );
    expect(prefs.get().prefs).toMatchObject({ version: 2, preview_cache: { pause_on_battery: false } });
    const directory = join(root, "home", "Movies", "庄Sir剪辑助手", "预览缓存");
    expect(prefs.get().preview_cache_directory).toBe(directory);
    await expect(stat(directory)).rejects.toMatchObject({ code: "ENOENT" });
    await cache.open(await fixture(), join(root, "test.zcut.json"));
    await cache.idle();
    expect((await stat(directory)).isDirectory()).toBe(true);
    expect(await cache.status()).toMatchObject({ directory_ok: true });
    expect((await cache.status()).segments.some((s) => s.state === "ready")).toBe(true);
    expect((await calls()).length).toBeGreaterThan(0);
  });
  it("does not create an unmounted volume and resumes encoding on a later status check", async () => {
    await cache.close();
    const volumes = join(root, "Volumes");
    const volume = join(volumes, "External");
    const directory = join(volume, "nested", "cache");
    await prefs.set({ preview_cache: { directory } });
    cache = new PreviewCache(
      prefs,
      () => {},
      async () => false,
      volumes,
    );
    await cache.open(await fixture(), join(root, "test.zcut.json"));
    await cache.idle();
    expect(await cache.status()).toMatchObject({ directory_ok: false, projects: [] });
    expect((await cache.status()).segments.every((s) => s.state === "missing")).toBe(true);
    await expect(stat(volumes)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(join(root, "calls"))).rejects.toMatchObject({ code: "ENOENT" });
    await mkdir(volumes);
    expect((await cache.status()).directory_ok).toBe(false);
    await expect(stat(volume)).rejects.toMatchObject({ code: "ENOENT" });
    await mkdir(volume);
    expect((await cache.status()).directory_ok).toBe(true);
    await cache.idle();
    expect((await cache.status()).segments.some((s) => s.state === "ready")).toBe(true);
  });
  it("creates paths outside the volume root and keeps non-directory paths unavailable", async () => {
    await cache.close();
    const volumes = join(root, "Volumes");
    const directory = join(root, "Volumes-other", "cache");
    await prefs.set({ preview_cache: { directory } });
    cache = new PreviewCache(
      prefs,
      () => {},
      async () => false,
      volumes,
    );
    expect((await cache.status()).directory_ok).toBe(true);
    await expect(stat(volumes)).rejects.toMatchObject({ code: "ENOENT" });
    const file = join(root, "file");
    await writeFile(file, "original");
    await cache.updatePreferences({ preview_cache: { directory: join(file, "cache") } });
    await cache.open(await fixture(), join(root, "test.zcut.json"));
    await cache.idle();
    expect(await cache.status()).toMatchObject({ directory_ok: false, projects: [] });
    expect((await cache.status()).segments.every((s) => s.state === "missing")).toBe(true);
    expect(await readFile(file, "utf8")).toBe("original");
  });
  it("uses exact canonical keys, filters disabled/audio/images, and re-encodes only an edited source range", async () => {
    const project = await fixture();
    const track = project.timelines[0]?.tracks.find((t) => t.kind === "video");
    if (!track || track.kind !== "video") throw new Error("video");
    const clip = track.clips[0];
    const media = project.media.find((m) => m.id === clip?.media_id);
    if (!clip || !media) throw new Error("media");
    expect(segmentKey(clip, media, "720p")).toBe(
      createHash("sha256")
        .update(`${media.fingerprint.value}|1001/100s|3003/200s|1|720p|v2`)
        .digest("hex")
        .slice(0, 32),
    );
    expect(segmentKey({ ...clip, source_start: rational(2002n, 200n) }, media, "720p")).toBe(
      segmentKey(clip, media, "720p"),
    );
    await cache.open(project, join(root, "test.zcut.json"));
    await cache.idle();
    const initial = await cache.status();
    expect(initial.segments.length).toBe(track.clips.length + 1);
    expect(initial.segments.filter((s) => s.state === "ready")).toHaveLength(track.clips.length);
    const count = (await calls()).length;
    clip.timeline_start = rational(20n);
    project.subtitle_styles = [];
    await cache.refresh(project);
    await cache.idle();
    expect((await calls()).length).toBe(count);
    clip.duration = rational(3n);
    await cache.refresh(project);
    await cache.idle();
    expect((await calls()).length).toBe(count + 1);
    const ready = (await cache.status()).segments[0];
    if (!ready) throw new Error("segment");
    const file = await cache.file(project.id, ready.key);
    expect(await readFile(file ?? "", "utf8")).toBe("0123456789");
    await cache.clear(project.id);
    await cache.refresh(project);
    await cache.idle();
    expect((await cache.status()).segments[0]).toEqual(ready);
    track.clips.push({ ...clip, id: "disabled", enabled: false });
    const image = structuredClone(media);
    image.id = "image";
    image.kind = "image";
    project.media.push(image);
    track.clips.push({ ...clip, id: "image", media_id: "image" });
    await cache.refresh(project);
    await cache.idle();
    expect((await cache.status()).segments).toHaveLength(initial.segments.length);
  });
  it("encodes constant speed and reverse with rational GOP and deterministic metadata flags; skips nonlinear maps", async () => {
    const project = await fixture();
    const track = project.timelines[0]?.tracks.find((t) => t.kind === "video");
    const clip = track?.kind === "video" ? track.clips[0] : undefined;
    const media = project.media.find((m) => m.id === clip?.media_id);
    if (!clip || !media?.video) throw new Error("fixture");
    media.video.rate = rational(30000n, 1001n);
    clip.duration = rational(2n);
    clip.source_start = rational(4n);
    clip.time_map = [
      { at: rational(0n), source: rational(4n), interp: "linear" },
      { at: rational(2n), source: rational(0n), interp: "linear" },
    ];
    const args = segmentArgs(clip, media, "540p", "source", "out");
    expect(args).toContain(
      "reverse,setpts=(PTS-STARTPTS)*1/2,scale=w='if(gte(iw,ih),-2,540)':h='if(gte(iw,ih),540,-2)'",
    );
    expect(args).toContain("areverse,atempo=2.000000000,apad");
    expect(args?.slice(args.indexOf("-t"), args.indexOf("-t") + 2)).toEqual(["-t", "4.000000000"]);
    expect(args?.slice(args.lastIndexOf("-t"), args.lastIndexOf("-t") + 2)).toEqual(["-t", "2.000000000"]);
    expect(args?.slice(args.indexOf("-g"), args.indexOf("-g") + 2)).toEqual(["-g", "15"]);
    const key = segmentKey(clip, media, "540p");
    clip.time_map = clip.time_map.map((p) => ({ source: p.source, interp: p.interp, at: p.at }));
    expect(segmentKey(clip, media, "540p")).toBe(key);
    clip.time_map.splice(1, 0, { at: rational(1n), source: rational(2n), interp: "linear" });
    expect(segmentArgs(clip, media, "540p", "source", "out")).not.toBeNull();
    const first = clip.time_map[0];
    if (first) first.interp = "smooth";
    expect(segmentArgs(clip, media, "540p", "source", "out")).toBeNull();
    await cache.open(project, join(root, "project.zcut.json"));
    await cache.idle();
    expect((await cache.status()).segments[0]?.state).toBe("missing");
    delete clip.time_map;
    await writeFile(join(root, "fallback"), "");
    await cache.refresh(project);
    await cache.idle();
    const recorded = await calls();
    expect(recorded.some((args) => args.includes("libx264") && args.includes("veryfast"))).toBe(true);
    expect(
      recorded.every(
        (args) => args.includes("+frag_keyframe+empty_moov+default_base_moof") && args.includes("+bitexact"),
      ),
    ).toBe(true);
  });
  it("changes directory without moving old files and serializes clear with preference writes", async () => {
    const project = await fixture();
    await cache.open(project, join(root, "test.zcut.json"));
    await cache.idle();
    const first = (await cache.status()).segments[0];
    if (!first) throw new Error("segment");
    const old = join(root, "cache", project.id, `${first.key}.mp4`);
    const next = join(root, "next");
    await mkdir(next);
    await cache.updatePreferences({ preview_cache: { auto: false, directory: next } });
    expect(await readFile(old, "utf8")).toBe("0123456789");
    expect((await cache.status()).segments.every((s) => s.state === "missing")).toBe(true);
    const unrelated = join(next, "prj_unrelated");
    await mkdir(unrelated);
    await writeFile(join(unrelated, "material.bin"), "original");
    await Promise.all([
      cache.clear(),
      cache.updatePreferences({ preview_cache: { directory: join(root, "missing") } }),
    ]);
    expect(await readFile(join(unrelated, "material.bin"), "utf8")).toBe("original");
    expect((await cache.status()).directory_ok).toBe(true);
    await expect(cache.clear()).resolves.toBeUndefined();
    await expect(cache.updatePreferences({ preview_cache: { directory: "relative" } })).rejects.toThrow();
    expect(prefs.get().preview_cache_directory).toBe(join(root, "missing"));
  });
  it("evicts the least recently opened project at 1 GB and then current segments by use time", async () => {
    const project = await fixture();
    await prefs.set({ preview_cache: { limit_gb: 1, auto: false } });
    project.media = [];
    const key = "a".repeat(32);
    for (const [id, date] of [
      ["prj_old", "2025-01-01"],
      [project.id, "2026-01-01"],
    ]) {
      const dir = join(root, "cache", id ?? "");
      await mkdir(dir);
      await writeFile(join(dir, `${key}.mp4`), "");
      await truncate(join(dir, `${key}.mp4`), 750_000_000);
      await writeFile(
        join(dir, "index.json"),
        JSON.stringify({
          project_path: `${id}.zcut.json`,
          last_opened: date,
          segments: { [key]: { bytes: 750_000_000 } },
        }),
      );
    }
    await cache.open(project, join(root, "current.zcut.json"));
    await cache.enforceLimit();
    await expect(stat(join(root, "cache", "prj_old"))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await cache.status()).used_bytes).toBe(750_000_000);
    await truncate(join(root, "cache", project.id, `${key}.mp4`), 1_500_000_000);
    await writeFile(
      join(root, "cache", project.id, "index.json"),
      JSON.stringify({ project_path: "current", last_opened: "2026", segments: { [key]: { bytes: 1_500_000_000 } } }),
    );
    await cache.enforceLimit();
    expect((await cache.status()).used_bytes).toBe(0);
  });
  it("prioritizes playhead then forward then backward, pauses on battery, and throttles pushes", async () => {
    const project = await fixture();
    await prefs.set({ preview_cache: { auto: false, pause_on_battery: true } });
    await cache.close();
    const battery = vi.fn(async () => true);
    cache = new PreviewCache(prefs, (value) => pushes.push({ at: Date.now(), value }), battery);
    await cache.open(project, join(root, "project.zcut.json"));
    cache.hint(rational(6n));
    await prefs.set({ preview_cache: { auto: true } });
    await cache.refresh();
    await cache.idle();
    expect((await cache.status()).segments.every((s) => s.state === "missing")).toBe(true);
    expect(await cache.status()).toMatchObject({ paused: "battery" });
    battery.mockResolvedValue(false);
    await cache.refresh();
    await cache.idle();
    expect(await cache.status()).not.toHaveProperty("paused");
    const segments = (await cache.status()).segments;
    const recorded = await calls();
    expect(recorded.map((args) => args.at(-1)?.split("/").at(-1)?.replace(".tmp", ""))).toEqual([
      segments[1]?.key,
      segments[2]?.key,
      segments[0]?.key,
    ]);
    await new Promise((resolve) => setTimeout(resolve, 600));
    for (let i = 1; i < pushes.length; i++)
      expect((pushes[i]?.at ?? 0) - (pushes[i - 1]?.at ?? 0)).toBeGreaterThanOrEqual(500);
    expect(pushes.length).toBeGreaterThan(1);
  });
});

it("persists the probed picture duration and includes it only for ready segments, including pushes", async () => {
  const parsed = parseProject(
    await readFile(new URL("../../../fixtures/regressions/preview-cache-seam.zcut.json", import.meta.url), "utf8"),
  );
  if (!parsed.ok) throw new Error("fixture");
  const project = parsed.project;
  await prefs.set({ preview_cache: { auto: false } });
  await cache.open(project, join(root, "seam.zcut.json"));
  await cache.idle();
  expect((await cache.status()).segments.every((item) => !("duration" in item))).toBe(true);
  await cache.updatePreferences({ preview_cache: { auto: true } });
  await cache.idle();
  const status = await cache.status();
  expect(status.segments).toHaveLength(2);
  expect(status.segments.every((item) => item.state === "ready" && item.duration === "1001/15000s")).toBe(true);
  const index = JSON.parse(await readFile(join(root, "cache", project.id, "index.json"), "utf8"));
  for (const segment of status.segments)
    expect(index.segments[segment.key]).toEqual({ bytes: 10, duration: "1001/15000s" });
  const probes = await readFile(join(root, "probes"), "utf8");
  await cache.open(project, join(root, "seam.zcut.json"));
  await cache.idle();
  expect(await readFile(join(root, "probes"), "utf8")).toBe(probes);
  expect((await cache.status()).segments).toEqual(status.segments);
  await vi.waitFor(() =>
    expect(pushes).toContainEqual(
      expect.objectContaining({ value: expect.objectContaining({ segments: status.segments }) }),
    ),
  );
});

it("keeps a segment missing and removes the temporary output when duration probing fails", async () => {
  await writeFile(join(root, "probe-fail"), "");
  const project = await fixture();
  await cache.open(project, join(root, "test.zcut.json"));
  await cache.idle();
  const status = await cache.status();
  for (const item of status.segments) {
    expect(item.state).toBe("missing");
    expect(item).not.toHaveProperty("duration");
    await expect(stat(join(root, "cache", project.id, `${item.key}.tmp`))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await cache.file(project.id, item.key)).toBeUndefined();
  }
});

it("keeps a one-frame cut ready with its exact packet duration", async () => {
  await writeFile(join(root, "one-frame"), "");
  const parsed = parseProject(
    await readFile(new URL("../../../fixtures/regressions/preview-cache-seam.zcut.json", import.meta.url), "utf8"),
  );
  if (!parsed.ok) throw new Error("fixture");
  const project = parsed.project;
  const track = project.timelines[0]?.tracks[0];
  if (track?.kind !== "video" || !track.clips[0]) throw new Error("video");
  track.clips = [{ ...track.clips[0], duration: rational(1n, 25n) }];
  await cache.open(project, join(root, "frame.zcut.json"));
  await cache.idle();
  expect((await cache.status()).segments[0]).toMatchObject({ state: "ready", duration: "1001/30000s" });
});

it("starts split keys immediately, aborts obsolete ffmpeg and removes its temporary file", async () => {
  const project = await fixture();
  const track = project.timelines[0]?.tracks.find((track) => track.kind === "video");
  if (!track || track.kind !== "video" || !track.clips[0]) throw new Error("video");
  const clip = track.clips[0];
  track.clips = [clip];
  const timeline = project.timelines[0];
  if (!timeline) throw new Error("timeline");
  timeline.tracks = [track];
  await cache.open(project, join(root, "test.zcut.json"));
  await cache.idle();
  const before = await calls();
  await writeFile(join(root, "hold"), "");
  const changed = structuredClone(project);
  const video = changed.timelines[0]?.tracks[0];
  if (video?.kind !== "video" || !video.clips[0]) throw new Error("video");
  video.clips[0].duration = rational(1n);
  video.clips.push({
    ...clip,
    id: "clp_split",
    source_start: rational(15n),
    timeline_start: rational(1n),
    duration: rational(2n),
  });
  await cache.refresh(changed);
  await vi.waitFor(async () => expect((await cache.status()).segments[0]?.state).toBe("building"));
  await vi.waitFor(async () => expect(await calls()).toHaveLength(before.length + 1));
  const abandoned = (await cache.status()).segments[0]?.key;
  const temp = (await calls()).at(-1)?.at(-1);
  if (!temp || !abandoned) throw new Error("encoding");
  expect(temp.endsWith(`${abandoned}.tmp`)).toBe(true);
  await vi.waitFor(async () => expect(await readFile(temp, "utf8")).toBe("partial"));
  video.clips.shift();
  await cache.refresh(changed);
  await vi.waitFor(async () => expect(await readFile(join(root, "killed"), "utf8")).toContain(temp));
  await vi.waitFor(async () =>
    expect((await cache.status()).segments[0]).toMatchObject({ clip_id: "clp_split", state: "building" }),
  );
  await expect(stat(temp)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(stat(temp.replace(".tmp", ".mp4"))).rejects.toMatchObject({ code: "ENOENT" });
  expect((await calls()).filter((args) => args.at(-1) === temp)).toHaveLength(1);
  await rm(join(root, "hold"));
  await cache.idle();
  expect((await cache.status()).segments[0]?.state).toBe("ready");
});

it("puts the hinted segment and its next two ahead of the remaining queue", async () => {
  const project = await fixture();
  const track = project.timelines[0]?.tracks.find((track) => track.kind === "video");
  if (!track || track.kind !== "video" || !track.clips[0]) throw new Error("video");
  const template = track.clips[0];
  track.clips = Array.from({ length: 7 }, (_, i) => ({
    ...template,
    id: `clp_${i}`,
    source_start: rational(BigInt(i)),
    timeline_start: rational(BigInt(i)),
    duration: rational(1n),
  }));
  const timeline = project.timelines[0];
  if (!timeline) throw new Error("timeline");
  timeline.tracks = [track];
  await writeFile(join(root, "hold"), "");
  await cache.open(project, join(root, "test.zcut.json"));
  await vi.waitFor(async () => expect((await calls()).length).toBe(1));
  cache.hint(rational(4n));
  await rm(join(root, "hold"));
  await cache.idle();
  const media = project.media.find((media) => media.id === template.media_id);
  if (!media) throw new Error("media");
  const keys = track.clips.map((clip) => segmentKey(clip, media, "720p"));
  expect((await calls()).map((args) => args.at(-1)?.split("/").at(-1)?.replace(".tmp", ""))).toEqual([
    keys[0],
    keys[4],
    keys[5],
    keys[6],
    keys[3],
    keys[2],
    keys[1],
  ]);
});

it("rebuilds split keys on the host project_changed path without waiting for a poll", async () => {
  const { startHost } = await import("../src/index.js");
  const { Agents } = await import("../src/agents.js");
  const spy = vi.spyOn(Agents.prototype, "detect").mockResolvedValue([]);
  const path = join(root, "project.zcut.json");
  const source = JSON.parse(await readFile(new URL("../../../examples/minimal.zcut.json", import.meta.url), "utf8"));
  await writeFile(path, JSON.stringify(source));
  await writeFile(join(root, "hold"), "");
  let host: Awaited<ReturnType<typeof startHost>> | undefined;
  let socket: WebSocket | undefined;
  try {
    host = await startHost({ project: path, appDataDir: join(root, "prefs") });
    socket = new WebSocket(`ws://127.0.0.1:${host.port}/?token=${host.token}`);
    await once(socket, "open");
    let sequence = 0;
    const send = async (verb: string, request: Record<string, unknown> = {}) => {
      const id = `render-${sequence++}`;
      if (!socket) throw new Error("socket");
      const replies = on(socket, "message", { signal: AbortSignal.timeout(3000) });
      socket.send(JSON.stringify({ id, verb, request }));
      for await (const [raw] of replies) {
        const message = JSON.parse(raw.toString());
        if (message.id === id) return message.envelope;
      }
      throw new Error("Missing response");
    };
    const messages = on(socket, "message", { signal: AbortSignal.timeout(3000) });
    socket.send(JSON.stringify({ type: "ui_ready" }));
    for await (const [raw] of messages) if (JSON.parse(raw.toString()).type === "bootstrap") break;
    await vi.waitFor(async () =>
      expect((await send("preview_cache_status")).result.segments[0].state).toBe("building"),
    );
    const previous = (await send("preview_cache_status")).result.segments[0].key;
    const changes: unknown[] = [];
    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.type === "project_changed") changes.push(message);
    });
    expect(
      await send("edit", {
        project: path,
        base_revision: source.revision.id,
        idempotency_key: "split",
        author: { kind: "human", name: "test" },
        ops: [{ op: "split", clip_id: source.timelines[0].tracks[0].clips[0].id, at: "1s" }],
      }),
    ).toMatchObject({ status: "applied" });
    expect(changes).toHaveLength(1);
    await vi.waitFor(async () => {
      const status = (await send("preview_cache_status")).result;
      expect(status.segments).toHaveLength(2);
      expect(
        status.segments.some(
          (segment: { key: string; state: string }) => segment.key !== previous && segment.state === "building",
        ),
      ).toBe(true);
    });
    expect(await send("preview_cache_hint", { at: "1s" })).toMatchObject({ ok: true });
  } finally {
    socket?.terminate();
    await host?.close();
    spy.mockRestore();
  }
});
