import { spawnSync } from "node:child_process";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { audioSpans, mixWindow, PreviewMix } from "../src/preview-mix.js";
import { parseRational, printRational, rational, type TrackView } from "../src/timeline.js";

const seconds = (value: string) => parseRational(value, true);
let tracks: TrackView[];
beforeAll(() => {
  const run = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import { dispatch } from './packages/core/src/index.ts';
       const reply = await dispatch('inspect', { project: 'fixtures/regressions/preview-mix.zcut.json', view: 'timeline' });
       console.log(JSON.stringify(reply.result?.tracks));`,
    ],
    { encoding: "utf8" },
  );
  expect(run.status, run.stderr).toBe(0);
  tracks = JSON.parse(run.stdout);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("keeps dialogue over the picture-only cutaway and mixes the J/L overlap", () => {
  const at = (value: string, solo?: ReadonlySet<string>) =>
    mixWindow(audioSpans(tracks, solo), seconds(value), seconds(value)).map(({ span, source, gain }) => [
      span.clip.id,
      printRational(source, true),
      gain,
    ]);
  expect(at("2s")).toEqual([["clp_dialogue", "12s", 10 ** (-6 / 20)]]);
  expect(at("3s")).toEqual([
    ["clp_dialogue", "13s", 10 ** (-6 / 20)],
    ["clp_incoming", "20s", 10 ** (3 / 20)],
  ]);
  expect(at("4s")).toEqual([
    ["clp_dialogue", "14s", 10 ** (-6 / 20)],
    ["clp_incoming", "21s", 10 ** (3 / 20)],
  ]);
  expect(at("5s")).toEqual([["clp_incoming", "22s", 10 ** (3 / 20)]]);
  expect(at("6s")).toEqual([]);
  expect(at("4s", new Set(["trk_incoming", "trk_muted"]))).toEqual([["clp_incoming", "21s", 10 ** (3 / 20)]]);
  expect(at("4s", new Set(["trk_muted"]))).toEqual([]);
  expect(at("4s", new Set())).toEqual(at("4s"));
  expect(mixWindow(audioSpans(tracks), seconds("2s"), seconds("2s"), { ids: ["clp_dialogue"], db: 0 })[0]?.gain).toBe(
    1,
  );
});

it("maps linear reverse and forward rates and silences smooth and hold intervals", () => {
  const track = tracks.find(({ id }) => id === "trk_dialogue");
  const clip = track?.clips[0];
  if (!track || !clip) throw new Error("Missing dialogue in fixture");
  const time_map = [
    { at: { t: "0s" }, source: { t: "10s" }, interp: "linear" },
    { at: { t: "1s" }, source: { t: "8s" }, interp: "smooth" },
    { at: { t: "2s" }, source: { t: "6s" }, interp: "hold" },
    { at: { t: "3s" }, source: { t: "6s" }, interp: "linear" },
    { at: { t: "5s" }, source: { t: "7s" }, interp: "linear" },
  ];
  const spans = audioSpans([{ ...track, clips: [{ ...clip, time_map }] }]);
  const at = (value: string) => mixWindow(spans, seconds(value), seconds(value));
  expect(at("1/2s")[0]).toMatchObject({ source: rational(9n), span: { rate: rational(-2n) } });
  expect(at("1s")).toEqual([]);
  expect(at("2s")).toEqual([]);
  expect(at("4s")[0]).toMatchObject({ source: rational(13n, 2n), span: { rate: rational(1n, 2n) } });
});

function mockAudio() {
  const nodes: { start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> }[] = [];
  const endings: { time: number; callback: () => void }[] = [];
  const makeNode = () => {
    const node = {
      start: vi.fn(),
      stop: vi.fn((time?: number) => {
        endings.push({
          time: time ?? 0,
          callback: () => {
            const end = node.onended;
            node.onended = undefined;
            end?.();
          },
        });
      }),
      connect: vi.fn(),
      disconnect: vi.fn(),
      playbackRate: { value: 1 },
      onended: undefined as (() => void) | undefined,
    };
    node.connect.mockImplementation((target) => target);
    nodes.push(node);
    return node;
  };
  class MockAudioContext {
    state = "running";
    currentTime = 1;
    createBufferSource = makeNode;
    createGain = () => ({ gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() });
    createBuffer = vi.fn((numberOfChannels: number, length: number, sampleRate: number) => {
      const channels = Array.from({ length: numberOfChannels }, () => new Float32Array(length));
      return {
        numberOfChannels,
        length,
        sampleRate,
        duration: length / sampleRate,
        getChannelData: (i: number) => channels[i],
      };
    });
    close = vi.fn().mockResolvedValue(undefined);
    getOutputTimestamp = vi.fn(() => ({ contextTime: 0, performanceTime: 0 }));
    static instance: MockAudioContext;
    constructor() {
      MockAudioContext.instance = this;
    }
  }
  vi.stubGlobal("AudioContext", MockAudioContext);
  const reply = {
    ok: true,
    headers: new Headers({ "Content-Length": "768000" }),
    arrayBuffer: async () => new ArrayBuffer(768_000),
  };
  const fetchChunk = vi.fn((_url: string, _options: RequestInit) => Promise.resolve(reply));
  vi.stubGlobal("fetch", fetchChunk);
  return {
    nodes,
    fetchChunk,
    reply,
    context: () => MockAudioContext.instance,
    advance(time: number) {
      MockAudioContext.instance.currentTime = time;
      for (const ending of endings) if (ending.time <= time) ending.callback();
    },
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function longDialogue() {
  const span = audioSpans(tracks).find(({ clip }) => clip.id === "clp_dialogue");
  if (!span) throw new Error("Missing dialogue span");
  return [{ ...span, source: seconds("1200s"), end: seconds("1800s") }];
}

it.each([false, true])("preloads local PCM and joins chunks on the same audio clock (reverse: %s)", async (reverse) => {
  const { nodes, fetchChunk, context } = mockAudio();
  const mix = new PreviewMix((id, index) => `${id}/${index}`);
  const spans = longDialogue().map((span) => (reverse ? { ...span, rate: rational(-1n) } : span));
  const at = seconds("39/10s");
  mix.warm(spans, at);
  await settle();
  expect(fetchChunk.mock.calls.map(([url]) => url)).toEqual(
    (reverse ? [299, 298, 297] : [300, 301, 302]).map((index) => `med_a/${index}`),
  );
  mix.sample(spans, at, seconds("1800s"), 1 / 30);
  expect(nodes[0]?.start).toHaveBeenCalledWith(1, 3.9);
  expect(nodes[0]?.stop).toHaveBeenCalledWith(1.1);
  expect(nodes[1]?.start).toHaveBeenCalledWith(1.1, 0);
  context().currentTime = 1.12;
  mix.sample(spans, seconds("201/50s"), seconds("1800s"), 1 / 30);
  expect(nodes).toHaveLength(2);
  mix.dispose();
});

it("corrects 60 seconds of drift and aligns a seek with the output timestamp", async () => {
  const { nodes, context, advance } = mockAudio();
  const mix = new PreviewMix((id, index) => `${id}/${index}`);
  const spans = longDialogue();
  const sample = (at: string) => mix.sample(spans, seconds(at), seconds("1800s"), 1 / 30);
  mix.warm(spans, seconds("0s"));
  await settle();
  sample("0s");
  expect(nodes[0]?.start).toHaveBeenCalledWith(1, 0);
  for (let second = 1; second <= 60; second++) {
    mix.warm(spans, rational(BigInt(second)));
    await settle();
    advance(1 + second * 1.0004);
    sample(`${second}s`);
  }
  context().currentTime = 62;
  const count = nodes.length;
  sample("60s");
  expect(nodes).toHaveLength(count);
  mix.stop();
  vi.spyOn(performance, "now").mockReturnValue(2000);
  context().currentTime = 80;
  context().getOutputTimestamp.mockReturnValue({ contextTime: 79.95, performanceTime: 2000 });
  sample("61s");
  expect(nodes.at(-1)?.start.mock.calls[0]?.[0]).toBe(80);
  expect(nodes.at(-1)?.start.mock.calls[0]?.[1]).toBeCloseTo(1.05);
  mix.dispose();
});

it("limits each asset to six slots even with rapid seeks and unacknowledged aborts", async () => {
  const { fetchChunk, reply, context } = mockAudio();
  const complete: (() => void)[] = [];
  fetchChunk.mockImplementation(() => new Promise((resolve) => complete.push(() => resolve(reply))));
  const mix = new PreviewMix((id, index) => `${id}/${index}`);
  const spans = longDialogue().map((span) => ({ ...span, rate: rational(16n) }));
  for (const at of ["0s", "60s", "1s"]) mix.warm(spans, seconds(at));
  expect(fetchChunk).toHaveBeenCalledTimes(6);
  expect(fetchChunk.mock.calls.every(([, options]) => options.signal?.aborted)).toBe(true);
  for (const resolve of complete.splice(0)) resolve();
  await settle();
  expect(context().createBuffer).not.toHaveBeenCalled();
  mix.warm(spans, seconds("1s"));
  for (const resolve of complete.splice(0)) resolve();
  await settle();
  expect(fetchChunk).toHaveBeenCalledTimes(12);
  expect(context().createBuffer).toHaveBeenCalledTimes(6);
  const retainedBytes = context().createBuffer.mock.calls.reduce(
    (bytes, [channels, frames]) => bytes + channels * frames * 4 * 2 + frames * 4,
    0,
  );
  expect(retainedBytes).toBe(23_040_000);
  expect(retainedBytes).toBeLessThan(50_000_000);
  mix.dispose();
});
