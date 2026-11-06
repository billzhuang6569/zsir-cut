import { useCallback, useEffect, useRef, useState } from "react";
import type { ProjectView } from "./connection.js";
import {
  add,
  type ClipView,
  compare,
  contains,
  div,
  mul,
  numberOf,
  parseRational,
  printRational,
  rational,
  sub,
  type TrackView,
} from "./timeline.js";

export interface CacheStatus {
  segments: { clip_id: string; key: string; state: "ready" | "building" | "missing" }[];
  projects: { project_id: string; path: string }[];
  directory_ok: boolean;
}
export interface StreamSegment {
  clip: ClipView;
  url: string;
}
const seconds = (value: number) => rational(BigInt(Math.round(value * 1_000_000)), 1_000_000n);
const mime = 'video/mp4; codecs="avc1.64001f, mp4a.40.2"';
export const streamSupported = () => globalThis.MediaSource?.isTypeSupported(mime) ?? false;

/** One append queue owns the SourceBuffer, including eviction. */
export class PreviewStream {
  readonly table: { segment: StreamSegment; start: string; end: string }[] = [];
  private media = new MediaSource();
  private url = URL.createObjectURL(this.media);
  private abort = new AbortController();
  private buffer: SourceBuffer | undefined;
  private busy = false;
  private disposed = false;
  private started = false;
  private failed = false;
  private unavailable: string | undefined;
  constructor(
    private video: HTMLVideoElement,
    private first: StreamSegment,
    private next: (clip: ClipView) => StreamSegment | undefined,
    private getAt: () => string,
    private activate: () => void,
    private fail: () => void,
    private timelineEnd?: string,
  ) {
    video.src = this.url;
    this.media.addEventListener("sourceopen", this.open, { once: true });
    video.addEventListener("error", this.error);
  }
  private error = () => {
    if (this.disposed || this.failed) return;
    this.failed = true;
    this.fail();
  };
  private open = () => {
    try {
      this.buffer = this.media.addSourceBuffer(mime);
      this.buffer.mode = "sequence";
      void this.pump();
    } catch {
      this.error();
    }
  };
  private operation(action: () => void) {
    return new Promise<void>((resolve, reject) => {
      const buffer = this.buffer;
      if (!buffer || this.disposed) return reject(new Error("Stream closed"));
      const clean = () => {
        buffer.removeEventListener("updateend", done);
        buffer.removeEventListener("error", error);
        this.abort.signal.removeEventListener("abort", error);
      };
      const done = () => {
        clean();
        resolve();
      };
      const error = () => {
        clean();
        reject(new Error("Buffer failed"));
      };
      buffer.addEventListener("updateend", done, { once: true });
      buffer.addEventListener("error", error, { once: true });
      this.abort.signal.addEventListener("abort", error, { once: true });
      try {
        action();
      } catch (cause) {
        clean();
        reject(cause);
      }
    });
  }
  private async pump() {
    if (this.busy || !this.buffer || this.disposed || this.failed) return;
    this.busy = true;
    try {
      const current = this.table.findIndex((row) => this.video.currentTime < numberOf(parseRational(row.end, true)));
      const wanted = Math.max(2, (current < 0 ? this.table.length : current) + 3);
      while (!this.disposed && this.table.length < wanted) {
        const previous = this.table.at(-1);
        const segment = previous ? this.next(previous.segment.clip) : this.first;
        if (!segment || segment.url === this.unavailable) break;
        let bytes: ArrayBuffer;
        try {
          const response = await fetch(segment.url, { signal: this.abort.signal });
          if (!response.ok) throw new Error("Cache unavailable");
          bytes = await response.arrayBuffer();
        } catch (cause) {
          if (!this.started) throw cause;
          this.unavailable = segment.url;
          break;
        }
        if (this.disposed) return;
        const start = previous?.end ?? "0s";
        await this.operation(() => this.buffer?.appendBuffer(bytes));
        if (this.disposed) return;
        const end = printRational(seconds(this.buffer.buffered.end(this.buffer.buffered.length - 1)), true);
        if (compare(parseRational(end, true), parseRational(start, true)) <= 0) throw new Error("Empty segment");
        this.table.push({ segment, start, end });
        if (!this.started && this.table.length === 2) {
          const at = this.getAt();
          const row = this.table.find((row) =>
            contains(row.segment.clip.timeline_in.t, row.segment.clip.timeline_out.t, at),
          );
          if (!row) throw new Error("Playhead moved");
          this.video.currentTime = numberOf(
            add(
              parseRational(row.start, true),
              mul(
                div(
                  sub(parseRational(at, true), parseRational(row.segment.clip.timeline_in.t, true)),
                  sub(
                    parseRational(row.segment.clip.timeline_out.t, true),
                    parseRational(row.segment.clip.timeline_in.t, true),
                  ),
                ),
                sub(parseRational(row.end, true), parseRational(row.start, true)),
              ),
            ),
          );
          this.video.volume = Math.min(1, 10 ** ((row.segment.clip.gain_db ?? 0) / 20));
          this.video.playbackRate = 1;
          await this.video.play();
          if (this.disposed) return;
          this.started = true;
          this.activate();
        }
      }
      if (!this.started && !this.disposed) throw new Error("Startup needs two segments");
      if (this.table.at(-1)?.segment.clip.timeline_out.t === this.timelineEnd && this.media.readyState === "open")
        this.media.endOfStream();
      const old = this.table[Math.max(0, current - 2)];
      if (
        old &&
        this.buffer.buffered.length &&
        this.buffer.buffered.start(0) < numberOf(parseRational(old.start, true))
      )
        await this.operation(() => this.buffer?.remove(0, numberOf(parseRational(old.start, true))));
    } catch {
      if (!this.disposed) this.error();
    } finally {
      this.busy = false;
    }
  }
  time(): { at: string; ended: boolean } | null {
    if (!this.started || this.disposed || this.failed) return null;
    void this.pump();
    const decoded = seconds(this.video.currentTime);
    const row = this.table.find((row) => compare(decoded, parseRational(row.end, true)) < 0) ?? this.table.at(-1);
    if (!row) return null;
    const ended = this.video.ended || compare(decoded, parseRational(row.end, true)) >= 0;
    const clip = row.segment.clip;
    this.video.volume = Math.min(1, 10 ** ((clip.gain_db ?? 0) / 20));
    const at = ended
      ? clip.timeline_out.t
      : printRational(
          add(
            parseRational(clip.timeline_in.t, true),
            mul(
              div(
                sub(decoded, parseRational(row.start, true)),
                sub(parseRational(row.end, true), parseRational(row.start, true)),
              ),
              sub(parseRational(clip.timeline_out.t, true), parseRational(clip.timeline_in.t, true)),
            ),
          ),
          true,
        );
    return { at, ended };
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.abort.abort();
    this.media.removeEventListener("sourceopen", this.open);
    this.video.removeEventListener("error", this.error);
    this.video.pause();
    this.video.removeAttribute("src");
    this.video.load();
    URL.revokeObjectURL(this.url);
  }
}

export function usePreviewStream({
  project,
  top,
  path,
  config,
  call,
  enabled,
  at,
  playbackAt,
}: {
  project: ProjectView | null;
  top: TrackView | undefined;
  path: string | null;
  config: { port: number; token: string } | undefined;
  call: (verb: string, request: Record<string, unknown>) => Promise<unknown>;
  enabled: boolean;
  at: string;
  playbackAt: React.MutableRefObject<string | null>;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const engine = useRef<PreviewStream>();
  const cache = useRef<CacheStatus>();
  const attempted = useRef<string>();
  const active = useRef(false);
  const [visible, setVisible] = useState(false);
  const latestAt = useRef(at);
  latestAt.current = at;
  const stop = useCallback(() => {
    engine.current?.dispose();
    engine.current = undefined;
    active.current = false;
    setVisible(false);
  }, []);
  useEffect(() => {
    if (!config || !path) return;
    let live = true;
    cache.current = undefined;
    const receive = (event: Event) => {
      cache.current = (event as CustomEvent<CacheStatus>).detail;
    };
    const refresh = () => {
      void call("preview_cache_status", {})
        .then((reply) => {
          if (live) cache.current = (reply as { result?: CacheStatus })?.result;
        })
        .catch(() => {});
    };
    refresh();
    window.addEventListener("desktop-preview-cache", receive);
    window.addEventListener("desktop-host-ready", refresh);
    return () => {
      live = false;
      window.removeEventListener("desktop-preview-cache", receive);
      window.removeEventListener("desktop-host-ready", refresh);
    };
  }, [config, path, call]);
  useEffect(() => {
    if (config && path) void call("preview_cache_playhead", { at }).catch(() => {});
  }, [at, config, path, call]);
  useEffect(() => {
    if (!enabled || at !== playbackAt.current) {
      stop();
      attempted.current = undefined;
    }
  }, [enabled, at, playbackAt, stop]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Project identity changes invalidate all appended segments.
  useEffect(() => {
    stop();
    attempted.current = undefined;
    return stop;
  }, [project, top, config, stop]);
  const sample = useCallback(
    (target: string) => {
      latestAt.current = target;
      if (!enabled) return null;
      const mapped = engine.current?.time();
      if (mapped && !mapped.ended) return mapped.at;
      if (mapped?.ended) {
        stop();
        target = mapped.at;
      }
      const clip = top?.clips.find((clip) => clip.enabled && contains(clip.timeline_in.t, clip.timeline_out.t, target));
      if (!engine.current && clip && attempted.current !== clip.id && config && streamSupported() && video.current) {
        attempted.current = clip.id;
        const segment = (clip: ClipView): StreamSegment | undefined => {
          const status = cache.current;
          const item = status?.segments?.find((item) => item.clip_id === clip.id && item.state === "ready");
          const projectId = status?.projects?.find((item) => item.path === path)?.project_id;
          if (
            !status?.directory_ok ||
            !item ||
            !projectId ||
            clip.speed === "map" ||
            compare(parseRational(clip.speed), rational(0n)) <= 0 ||
            project?.media.find((item) => item.id === clip.media_id)?.kind !== "video"
          )
            return;
          const rate = parseRational(clip.speed);
          if (
            clip.time_map?.some(
              (point, index, points) =>
                (index < points.length - 1 && point.interp !== "linear") ||
                compare(
                  parseRational(point.source.t, true),
                  add(
                    parseRational(clip.source_in.t, true),
                    mul(sub(parseRational(point.at.t, true), parseRational(clip.timeline_in.t, true)), rate),
                  ),
                ) !== 0,
            )
          )
            return;
          return {
            clip,
            url: `http://127.0.0.1:${config.port}/cache/${encodeURIComponent(projectId)}/${encodeURIComponent(item.key)}.mp4?token=${encodeURIComponent(config.token)}`,
          };
        };
        const next = (clip: ClipView) => {
          const incoming = top?.clips.find(
            (item) => item.enabled && item.id !== clip.id && item.timeline_in.t === clip.timeline_out.t,
          );
          return incoming ? segment(incoming) : undefined;
        };
        const first = segment(clip);
        if (first && next(clip))
          engine.current = new PreviewStream(
            video.current,
            first,
            next,
            () => latestAt.current,
            () => {
              active.current = true;
              setVisible(true);
            },
            stop,
            project?.duration.t,
          );
      }
      return mapped?.ended ? mapped.at : null;
    },
    [enabled, top, config, path, project, stop],
  );
  return { video, visible, active, sample };
}
