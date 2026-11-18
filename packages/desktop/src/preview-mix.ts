import type { Rational } from "../../core/src/rational.ts";
import type { GainPreview } from "./clipProperties.js";
import { reverseBuffer } from "./reverse-audio.js";
import { add, compare, div, floor, mul, numberOf, parseRational, rational, sub, type TrackView } from "./timeline.js";

const seconds = (value: string) => parseRational(value, true);
const ahead = rational(1n, 8n);

export function audioSpans(tracks: TrackView[], solo?: ReadonlySet<string>) {
  return tracks.flatMap((track) => {
    if (track.kind !== "audio" || !track.enabled || (solo?.size && !solo.has(track.id))) return [];
    return track.clips.flatMap((clip) => {
      if (!clip.enabled) return [];
      const points = clip.time_map ?? [
        { at: clip.timeline_in, source: clip.source_in, interp: "linear" },
        { at: clip.timeline_out, source: clip.source_out, interp: "linear" },
      ];
      return points.slice(0, -1).flatMap((point, index) => {
        const next = points[index + 1];
        if (!next || point.interp !== "linear") return [];
        const start = seconds(point.at.t);
        const end = seconds(next.at.t);
        const source = seconds(point.source.t);
        const rate = div(sub(seconds(next.source.t), source), sub(end, start));
        return rate.numerator === 0n ? [] : [{ clip, start, end, source, rate }];
      });
    });
  });
}

type Span = ReturnType<typeof audioSpans>[number];

export function mixWindow(spans: Span[], at: Rational, end: Rational, preview?: GainPreview | null) {
  return spans.flatMap((span) => {
    if (compare(span.end, at) <= 0 || compare(span.start, end) > 0) return [];
    const start = compare(span.start, at) < 0 ? at : span.start;
    const db = preview?.ids.includes(span.clip.id) ? preview.db : (span.clip.gain_db ?? 0);
    return [{ span, start, source: add(span.source, mul(sub(start, span.start), span.rate)), gain: 10 ** (db / 20) }];
  });
}

const chunkSeconds = 4n;
const chunkFrames = 192_000;
const chunkBytes = chunkFrames * 4;
// Six slots include pending requests and buffers pinned by scheduled nodes. At most 23.04 MB of PCM per asset.
const chunksPerAsset = 6;

function chunkWindow(spans: Span[], at: Rational, end: Rational, preview?: GainPreview | null) {
  return mixWindow(spans, at, end, preview)
    .flatMap(({ span, start, source, gain }) => {
      const chunks = [];
      const reverse = span.rate.numerator < 0n;
      const width = rational(chunkSeconds);
      let index = floor(div(source, width));
      if (reverse && compare(source, rational(index * chunkSeconds)) === 0) index--;
      for (let count = 0; count < chunksPerAsset && index >= 0n; count++, index += reverse ? -1n : 1n) {
        const base = rational(index * chunkSeconds);
        const boundary = reverse ? base : add(base, width);
        const chunkEnd = add(start, div(sub(boundary, source), span.rate));
        const capped = compare(chunkEnd, span.end) < 0 ? chunkEnd : span.end;
        chunks.push({ span, index, start, end: capped, offset: sub(source, base), gain });
        if (compare(capped, end) > 0 || compare(capped, span.end) >= 0) break;
        start = chunkEnd;
        source = boundary;
      }
      return chunks;
    })
    .sort((a, b) => compare(a.start, b.start));
}

type Chunk = { abort: AbortController; loading: boolean; users: number; buffer?: AudioBuffer; reversed?: AudioBuffer };
const chunkKey = (media: string, index: bigint) => `${media}/${index}`;

export class PreviewMix {
  private context: AudioContext | undefined;
  private assets = new Map<string, Chunk>();
  private active = new Map<string, { node: AudioBufferSourceNode; volume: GainNode; end: Rational }>();
  private lastAt: Rational | undefined;
  private anchor: { timeline: Rational; audio: number } | undefined;
  private retryAt = 0;

  constructor(private url: (mediaId: string, index: bigint) => string) {}

  warm(spans: Span[], at: Rational) {
    if (typeof AudioContext === "undefined") return;
    const wanted = new Map(
      chunkWindow(spans, at, add(at, rational(5n))).map(({ span, index }) => [
        chunkKey(span.clip.media_id, index),
        { media: span.clip.media_id, index },
      ]),
    );
    for (const [key, chunk] of this.assets) {
      if (wanted.has(key) && !chunk.abort.signal.aborted) continue;
      chunk.abort.abort();
      if (!chunk.loading && !chunk.users) this.assets.delete(key);
    }
    if (!spans.length) return;
    this.context ??= new AudioContext();
    const context = this.context;
    if (performance.now() < this.retryAt) return;
    for (const [key, { media, index }] of wanted) {
      if (
        this.assets.has(key) ||
        [...this.assets.keys()].filter((id) => id.startsWith(`${media}/`)).length >= chunksPerAsset
      )
        continue;
      const chunk: Chunk = { abort: new AbortController(), loading: true, users: 0 };
      this.assets.set(key, chunk);
      void fetch(this.url(media, index), { signal: chunk.abort.signal, cache: "no-store" })
        .then((response) => {
          if (!response.ok || Number(response.headers.get("Content-Length")) !== chunkBytes)
            throw new Error("Invalid preview audio chunk");
          return response.arrayBuffer();
        })
        .then((bytes) => {
          if (chunk.abort.signal.aborted) return;
          if (bytes.byteLength !== chunkBytes) throw new Error("Invalid preview audio chunk");
          const pcm = new DataView(bytes);
          const buffer = context.createBuffer(2, chunkFrames, 48_000);
          for (let channel = 0; channel < 2; channel++) {
            const samples = buffer.getChannelData(channel);
            for (let frame = 0; frame < chunkFrames; frame++)
              samples[frame] = pcm.getInt16(frame * 4 + channel * 2, true) / 32768;
          }
          chunk.buffer = buffer;
        })
        .catch(() => {
          if (!chunk.abort.signal.aborted) this.retryAt = performance.now() + 250;
        })
        .finally(() => {
          chunk.loading = false;
          if (!chunk.buffer && this.assets.get(key) === chunk) this.assets.delete(key);
        });
    }
  }

  resume() {
    if (this.context?.state === "suspended") void this.context.resume().catch(() => {});
  }

  stop() {
    for (const { node } of this.active.values()) node.stop();
    this.active.clear();
    this.anchor = undefined;
    this.lastAt = undefined;
  }

  sample(spans: Span[], at: Rational, limit: Rational, frame: number, preview?: GainPreview | null) {
    const context = this.context;
    if (!context || context.state !== "running") return;
    const now = context.currentTime;
    const { contextTime, performanceTime } = context.getOutputTimestamp?.() ?? {};
    const heard =
      contextTime !== undefined && performanceTime !== undefined && performanceTime > 0
        ? Math.min(now, contextTime + (performance.now() - performanceTime) / 1000)
        : now;
    if (!this.anchor || Math.abs(heard - this.anchor.audio - numberOf(sub(at, this.anchor.timeline))) >= frame / 2) {
      const stalled = this.lastAt && compare(at, this.lastAt) === 0;
      this.stop();
      this.lastAt = at;
      if (stalled) return;
      this.anchor = { timeline: at, audio: heard };
    }
    this.lastAt = at;
    const anchor = this.anchor;
    const audioTime = (time: Rational) => anchor.audio + numberOf(sub(time, anchor.timeline));
    for (const [key, { node, end }] of this.active) {
      if (now >= audioTime(end)) this.active.delete(key);
      else if (compare(end, limit) > 0) {
        node.stop();
        this.active.delete(key);
      }
    }
    for (const { span, index, start, end: chunkEnd, offset, gain } of chunkWindow(spans, at, add(at, ahead), preview)) {
      const media = chunkKey(span.clip.media_id, index);
      const key = `${span.clip.id}/${span.start.numerator}/${span.start.denominator}/${index}`;
      const playing = this.active.get(key);
      if (playing) {
        playing.volume.gain.value = gain;
        continue;
      }
      const chunk = this.assets.get(media);
      if (!chunk?.buffer || chunk.abort.signal.aborted) continue;
      const rate = numberOf(span.rate);
      if (rate < 0) chunk.reversed ??= reverseBuffer(context, chunk.buffer);
      const buffer = rate < 0 && chunk.reversed ? chunk.reversed : chunk.buffer;
      const when = audioTime(start);
      const end = compare(chunkEnd, limit) <= 0 ? chunkEnd : limit;
      if (audioTime(end) <= Math.max(now, when)) continue;
      const localTime = numberOf(offset);
      const startOffset =
        (rate < 0 ? buffer.duration - localTime : localTime) + Math.max(0, now - when) * Math.abs(rate);
      if (startOffset >= buffer.duration) continue;
      const node = context.createBufferSource();
      const volume = context.createGain();
      node.buffer = buffer;
      node.playbackRate.value = Math.abs(rate);
      volume.gain.value = gain;
      node.connect(volume).connect(context.destination);
      chunk.users++;
      node.onended = () => {
        chunk.users--;
        node.disconnect();
        volume.disconnect();
      };
      node.start(Math.max(now, when), Math.max(0, startOffset));
      node.stop(audioTime(end));
      this.active.set(key, { node, volume, end });
    }
  }

  dispose() {
    this.stop();
    for (const { abort } of this.assets.values()) abort.abort();
    this.assets.clear();
    void this.context?.close();
    this.context = undefined;
  }
}
