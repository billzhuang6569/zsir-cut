import { type CSSProperties, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ProjectChanged } from "../../app-host/src/revision-events.js";
import type { EntityChange } from "../../core/dist/index.js";
import { Button, ReviewValue } from "./ai-components.js";
import { chapterTime } from "./chapters.js";
import { Clip, Icon, IconButton } from "./components.js";
import type { ProjectView, useTimelinePreferences } from "./connection.js";
import type { UiState } from "./state.js";
import { mediaUrl, TimelinePreview, Wave } from "./TimelinePreview.js";
import {
  compare,
  div,
  mul,
  numberOf,
  parseRational,
  printRational,
  rational,
  sub,
  type TimelineView,
  timecode,
} from "./timeline.js";
import "./review.css";

// Shared entry point for the AI panel and the history popover.
export function openReview(sessionId: string) {
  window.dispatchEvent(new CustomEvent("desktop-open-review", { detail: sessionId }));
}

interface ReviewStep {
  revision: { id: string; seq: number };
  label: string | null;
  reason: string | null;
  summary: Record<string, { added: number; removed: number; changed: number }>;
  keys: string[];
}
export interface ReviewSummary {
  base_revision: string;
  draft_revision: string;
  timeline_changes: EntityChange[];
  subtitle_changes: EntityChange[];
  steps: ReviewStep[];
  pending_count: number;
}
interface ReviewData {
  summary: ReviewSummary;
  original: ProjectView;
  plan: ProjectView;
  session: { state: string; intent: string };
}
type Mode = "compare" | "plan" | "original";
type Position = { track: string; start: string; end: string };
const entityNames: Record<string, string> = {
  clip: "片段",
  track: "轨道",
  marker: "标记",
  timeline: "时间线",
  media: "素材",
  project: "工程",
  transcript: "母稿",
  token: "字词",
  cue: "字幕",
  override: "字幕覆盖",
  free_cue: "独立字幕",
  style: "样式",
  run: "识别",
};
const changeKind = (change: EntityChange) =>
  change.before === null ? "added" : change.after === null ? "removed" : "changed";
const kindLabels = { added: "新增", removed: "删除", changed: "修改" };

// Locate host-supplied keys in host-supplied views; never compare the two timelines.
function positions(change: EntityChange, view: ProjectView, before: boolean): Position[] {
  const value = before ? change.before : change.after;
  const parent = before ? change.before_parent : change.after_parent;
  if (!value) return [];
  if (change.entity === "clip") {
    const track = view.tracks.find((track) => track.id === parent);
    const clip = track?.clips.find((clip) => clip.id === change.key);
    return clip && track ? [{ track: track.id, start: clip.timeline_in.t, end: clip.timeline_out.t }] : [];
  }
  if (change.entity === "track")
    return view.tracks.some((track) => track.id === change.key)
      ? [{ track: change.key, start: "0s", end: view.duration.t }]
      : [];
  if (change.entity === "marker") {
    const marker = view.markers.find((marker) => marker.id === change.key);
    return marker && view.tracks[0] ? [{ track: view.tracks[0].id, start: marker.at.t, end: marker.at.t }] : [];
  }
  const cueId = typeof value.cue_id === "string" ? value.cue_id : change.key;
  return view.cues
    .filter(
      (cue) =>
        (!parent || change.entity === "cue" || change.entity === "token" || cue.track_id === parent) &&
        (cue.cue_id === cueId || cue.token_ids?.includes(change.key)) &&
        (change.entity !== "override" || cue.occurrence_id === value.occurrence_id),
    )
    .map((cue) => ({ track: cue.track_id, start: cue.start, end: cue.end }));
}
const percentage = (at: string, duration: string) =>
  `${numberOf(div(parseRational(at, true), parseRational(duration, true))) * 100}%`;
const geometry = (start: string, end: string, duration: string): CSSProperties => ({
  left: percentage(start, duration),
  width: percentage(printRational(sub(parseRational(end, true), parseRational(start, true)), true), duration),
});

export function ReviewView({
  preferences,
  sessionId,
  revision,
  project,
  state,
  update,
  call,
  change,
  actions,
  parametersTarget,
  viewerTarget,
  config,
  dragging,
  close,
  committed,
}: {
  preferences: ReturnType<typeof useTimelinePreferences>;
  sessionId: string;
  revision: number;
  project: ProjectView;
  state: UiState;
  update: (state: UiState) => void;
  call: (verb: string, request: Record<string, unknown>) => Promise<unknown>;
  change: ProjectChanged | null;
  actions: {
    approve: (id: string, pendingCount: number) => Promise<boolean>;
    reject: (id: string) => Promise<boolean>;
    confirming: string | undefined;
    busy: boolean;
    error: string;
  };
  parametersTarget: HTMLElement | null;
  viewerTarget: HTMLElement | null;
  config: { port: number; token: string } | undefined;
  dragging: React.MutableRefObject<boolean>;
  close: () => void;
  committed: (view: ProjectView) => void;
}) {
  const [data, setData] = useState<ReviewData | null>(null);
  const [mode, setMode] = useState<Mode>("compare");
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const [loading, setLoading] = useState(true);
  const [phase, setPhase] = useState("loading");
  const [freshSteps, setFreshSteps] = useState<string[]>([]);
  const [settled, setSettled] = useState<ProjectView | null>(null);
  const [finishing, setFinishing] = useState(false);
  const [ruler, setRuler] = useState<HTMLDivElement | null>(null);
  const [timelineWidth, setTimelineWidth] = useState(1);
  useEffect(() => {
    if (!ruler) return;
    const measure = () => setTimelineWidth(Math.max(1, ruler.clientWidth));
    measure();
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(measure);
    observer?.observe(ruler);
    return () => observer?.disconnect();
  }, [ruler]);
  const [reduced, setReduced] = useState(
    () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false,
  );
  const latest = useRef({ state, update, project, close, committed });
  latest.current = { state, update, project, close, committed };
  const previousSteps = useRef(new Set<string>());
  const unmounted = useRef(false);
  const closingTimer = useRef<ReturnType<typeof setTimeout>>();
  const [sessionRevision, setSessionRevision] = useState(0);
  useEffect(() => {
    if (change?.target === "session" && change.session_id === sessionId) setSessionRevision((value) => value + 1);
  }, [change, sessionId]);
  useEffect(() => {
    const media = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (!media) return;
    const changed = () => setReduced(media.matches);
    media.addEventListener("change", changed);
    return () => media.removeEventListener("change", changed);
  }, []);
  useEffect(() => {
    unmounted.current = false;
    return () => {
      unmounted.current = true;
      clearTimeout(closingTimer.current);
    };
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Session pushes and explicit retries invalidate the host snapshots.
  useEffect(() => {
    if (finishing) return;
    let cancelled = false;
    setLoading(true);
    const request = { project: state.project };
    void (async () => {
      const summary = (await call("inspect", { ...request, view: "review", session_id: sessionId })) as ReviewSummary;
      const [original, plan, preview, draftPreview, session] = await Promise.all([
        call("inspect", { ...request, view: "timeline", at_revision: summary.base_revision }),
        call("inspect", { ...request, view: "timeline", session_id: sessionId, at_revision: summary.draft_revision }),
        call("preview_data", { at_revision: summary.base_revision }),
        call("preview_data", { session_id: sessionId, at_revision: summary.draft_revision }),
        call("inspect", { ...request, view: "session", session_id: sessionId }),
      ]);
      if (cancelled) return;
      const firstRead = previousSteps.current.size === 0;
      const added = summary.steps.filter((step) => !previousSteps.current.has(step.revision.id));
      previousSteps.current = new Set(summary.steps.map((step) => step.revision.id));
      setFreshSteps(added.map((step) => step.revision.id));
      if (firstRead) setPhase("expanding");
      else if (added.length) setPhase("updating");
      setData({
        summary,
        original: {
          ...latest.current.project,
          ...(original as TimelineView),
          ...(preview as ProjectView),
          duration: (original as TimelineView).duration,
        },
        plan: {
          ...latest.current.project,
          ...(plan as TimelineView),
          ...(draftPreview as ProjectView),
          duration: (plan as TimelineView).duration,
        },
        session: session as ReviewData["session"],
      });
      setError("");
      setLoading(false);
    })().catch((cause: Error) => {
      if (!cancelled) {
        setError(cause.message);
        setLoading(false);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [call, sessionId, state.project, sessionRevision, revision, retry, finishing]);
  useEffect(() => {
    if (phase !== "expanding" && phase !== "updating") return;
    const timer = setTimeout(() => setPhase("ready"), reduced ? 150 : 320 + Math.max(0, freshSteps.length - 1) * 80);
    return () => clearTimeout(timer);
  }, [phase, freshSteps, reduced]);
  const seek = (at: string) => {
    const { state, update } = latest.current;
    update({ ...state, playhead: { at }, preview: "timeline", playing: false });
  };
  const changes = data ? [...data.summary.timeline_changes, ...data.summary.subtitle_changes] : [];
  const located = changes.map((change) => {
    const before = change.after === null;
    return { change, before, positions: data ? positions(change, before ? data.original : data.plan, before) : [] };
  });
  const jumps = located
    .flatMap((item) => item.positions.map((position) => position.start))
    .sort((a, b) => compare(parseRational(a, true), parseRational(b, true)));
  const jump = (direction: -1 | 1) => {
    const at = "at" in latest.current.state.playhead ? latest.current.state.playhead.at : "0s";
    const candidates = jumps.filter(
      (point) => compare(parseRational(point, true), parseRational(at, true)) === direction,
    );
    const next = direction === -1 ? candidates.at(-1) : candidates[0];
    if (next) seek(next);
  };
  const jumpRef = useRef(jump);
  jumpRef.current = jump;
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.isComposing ||
        latest.current.state.export?.open ||
        (event.target instanceof Element &&
          event.target.closest('input,textarea,select,[contenteditable=true],[role="dialog"]'))
      )
        return;
      if (event.key === "Escape" && phase !== "collapsing") {
        event.preventDefault();
        latest.current.close();
      }
      if (event.key === "ArrowUp" || event.key === "ArrowDown") {
        event.preventDefault();
        jumpRef.current(event.key === "ArrowUp" ? -1 : 1);
      }
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, [phase]);
  const finish = async (approve: boolean) => {
    if (!data || finishing || actions.busy || loading || error) return;
    const succeeded = approve
      ? await actions.approve(sessionId, data.summary.pending_count)
      : await actions.reject(sessionId);
    if (!succeeded || unmounted.current) return;
    setFinishing(true);
    try {
      const brief = (await call("inspect", { project: state.project, view: "brief" })) as {
        project: Pick<ProjectView, "name" | "revision">;
      };
      const [timeline, preview] = await Promise.all([
        call("inspect", { project: state.project, view: "timeline", at_revision: brief.project.revision.id }),
        call("preview_data", { at_revision: brief.project.revision.id }),
      ]);
      if (unmounted.current) return;
      const view = {
        ...latest.current.project,
        ...(timeline as TimelineView),
        ...(preview as ProjectView),
        duration: (timeline as TimelineView).duration,
        ...brief.project,
      };
      setSettled(view);
      setPhase("collapsing");
      closingTimer.current = setTimeout(
        () => {
          latest.current.committed(view);
          latest.current.close();
        },
        reduced ? 150 : 300,
      );
    } catch (cause) {
      if (!unmounted.current)
        setError(`方案已${approve ? "批准" : "拒绝"}，主工程读取失败，请退出对比后重试：${String(cause)}`);
    }
  };
  const duration =
    data && compare(parseRational(data.original.duration.t, true), parseRational(data.plan.duration.t, true)) > 0
      ? data.original.duration.t
      : data?.plan.duration.t;
  const visibleDuration =
    mode === "original" ? data?.original.duration.t : mode === "plan" ? data?.plan.duration.t : duration;
  const span =
    visibleDuration && compare(parseRational(visibleDuration, true), parseRational("0s", true)) > 0
      ? visibleDuration
      : "1s";
  const scale = div(rational(BigInt(timelineWidth)), parseRational(span, true));
  const view = settled ?? (mode === "original" ? data?.original : data?.plan) ?? null;
  const tracks = data
    ? mode === "original"
      ? data.original.tracks
      : mode === "plan"
        ? data.plan.tracks
        : [...new Map([...data.original.tracks, ...data.plan.tracks].map((track) => [track.id, track])).values()]
    : [];
  const delayFor = (key: string) => {
    const index =
      data?.summary.steps
        .filter((step) => freshSteps.includes(step.revision.id))
        .findIndex((step) => step.keys.includes(key)) ?? -1;
    return reduced ? "0ms" : `${Math.max(0, index) * 80}ms`;
  };
  const freshKeys = new Set(
    data?.summary.steps.filter((step) => freshSteps.includes(step.revision.id)).flatMap((step) => step.keys),
  );
  const appear = (key: string): CSSProperties =>
    freshKeys.has(key) && ["expanding", "updating"].includes(phase)
      ? {
          animation: `${reduced ? "zc-review-fade-in 150ms" : "zc-review-appear 320ms"} ease-out both`,
          animationDelay: delayFor(key),
        }
      : {};
  const panel = (
    <>
      <div className="zc-review-heading">
        <h2>审方案</h2>
        <Button icon="close" disabled={phase === "collapsing"} onClick={close}>
          退出对比
        </Button>
      </div>
      {(error || actions.error) && <p role="alert">{error || actions.error}</p>}
      {(!data || error) && <Button onClick={() => setRetry((value) => value + 1)}>重新读取</Button>}
      {data && (
        <>
          <section className="zc-draft" aria-label="审阅方案">
            <strong>方案 · {data.session.intent}</strong>
            {data.session.state === "open" && <p className="zc-meta">AI 正在写草稿</p>}
            {actions.confirming === sessionId && (
              <p role="alert">还有 {data.summary.pending_count} 件决定未答，仍要批准吗？</p>
            )}
            <div className="zc-review-actions">
              <Button
                variant="approve"
                icon="check"
                disabled={actions.busy || finishing || loading || Boolean(error) || data.session.state !== "in_review"}
                onClick={() => void finish(true)}
              >
                {actions.confirming === sessionId ? "仍然批准" : "全部批准"}
              </Button>
              <Button
                icon="close"
                disabled={
                  actions.busy ||
                  finishing ||
                  loading ||
                  Boolean(error) ||
                  !["open", "in_review"].includes(data.session.state)
                }
                onClick={() => void finish(false)}
              >
                拒绝
              </Button>
            </div>
          </section>
          <p className="zc-meta">改动 · 点一行，时间线跳过去</p>
          <section className="zc-review-steps" aria-label="方案步骤">
            {data.summary.steps.map((step) => {
              const point = located.find((item) => step.keys.includes(item.change.key) && item.positions.length)
                ?.positions[0];
              return (
                <button
                  type="button"
                  className={`zc-review-step${freshSteps.includes(step.revision.id) ? " is-new" : ""}`}
                  data-step={step.revision.id}
                  key={step.revision.id}
                  style={{ animationDelay: reduced ? "0ms" : `${freshSteps.indexOf(step.revision.id) * 80}ms` }}
                  onClick={() => {
                    if (point) seek(point.start);
                  }}
                >
                  <span className="zc-review-step-label">
                    {step.label || "工程修改"}
                    {point && <time>{timecode(point.start, data.plan)}</time>}
                  </span>
                  {step.reason && <span className="zc-review-reason">{step.reason}</span>}
                  <span className="zc-review-chips">
                    {Object.entries(step.summary).flatMap(([entity, counts]) =>
                      (["removed", "added", "changed"] as const)
                        .filter((kind) => counts[kind])
                        .map((kind) => (
                          <span className={`zc-chip is-sm is-${kind}`} key={`${entity}-${kind}`}>
                            {kindLabels[kind]} {counts[kind]} {entityNames[entity] ?? "内容"}
                          </span>
                        )),
                    )}
                  </span>
                </button>
              );
            })}
          </section>
          {located
            .filter((item) => !item.positions.length)
            .map(({ change }) => (
              <details key={change.key}>
                <summary>
                  {kindLabels[changeKind(change)]} · {entityNames[change.entity] ?? "工程内容"}
                </summary>
                <ReviewValue label="原来" value={change.before} />
                <ReviewValue label="方案" value={change.after} />
              </details>
            ))}
        </>
      )}
    </>
  );
  return (
    <>
      {parametersTarget && createPortal(panel, parametersTarget)}
      <TimelinePreview
        preferences={preferences}
        hideTimeline
        readOnly
        viewerTarget={viewerTarget}
        project={view}
        state={state}
        update={update}
        config={config}
        call={call}
        dragging={dragging}
        error={null}
      />
      <section
        aria-label="时间线对比"
        className="zc-review-timeline zc-panel"
        data-mode={mode}
        data-phase={phase}
        data-reduced-motion={reduced}
      >
        <div className="zc-toolbar">
          <fieldset className="zc-seg" aria-label="时间线显示">
            {(
              [
                ["compare", "对比"],
                ["plan", "只看方案"],
                ["original", "只看原来"],
              ] as const
            ).map(([value, label]) => (
              <button
                type="button"
                aria-pressed={mode === value}
                className={mode === value ? "is-active" : ""}
                key={value}
                disabled={finishing}
                onClick={() => {
                  setMode(value);
                  if (value === "compare") setPhase("expanding");
                }}
              >
                {label}
              </button>
            ))}
          </fieldset>
          {mode === "compare" && <span className="zc-meta">上半：原来　下半：AI 方案</span>}
          <span className="zc-grow" />
          {data && (
            <span className="zc-meta">
              {chapterTime(data.original.duration.t)} → {chapterTime(data.plan.duration.t)}
            </span>
          )}
          <IconButton icon="up" label="上一处改动 ↑" onClick={() => jump(-1)} disabled={!jumps.length || finishing} />
          <IconButton icon="down" label="下一处改动 ↓" onClick={() => jump(1)} disabled={!jumps.length || finishing} />
        </div>
        {data ? (
          <div className="zc-review-scroll">
            <div className="zc-review-ruler" ref={setRuler}>
              <span>{timecode("0s", data.original)}</span>
              <span>{timecode(span, data.original)}</span>
            </div>
            <div className="zc-review-tracks">
              {tracks.map((track) => (
                <div className="zc-review-track" key={track.id} data-track={track.id}>
                  <span className="zc-review-track-head" role="img" aria-label={track.name} title={track.name}>
                    <Icon name={track.kind === "video" ? "eye" : track.kind === "audio" ? "audio" : "subtitle"} />
                  </span>
                  <div className="zc-review-lanes">
                    {(["original", "plan"] as const)
                      .filter((side) => mode === "compare" || side === mode)
                      .map((side) => {
                        const source = side === "plan" && settled ? settled : data[side];
                        const row = source.tracks.find((item) => item.id === track.id);
                        return (
                          <section
                            className={`zc-review-lane is-${side}`}
                            key={side}
                            aria-label={`${track.name} · ${side === "original" ? "原来" : "方案"}`}
                          >
                            {row?.clips.map((clip) => (
                              <Clip
                                key={clip.id}
                                selectionId={clip.id}
                                kind={track.kind}
                                label={clip.label ?? source.media.find((m) => m.id === clip.media_id)?.name ?? "片段"}
                                dimmed={!clip.enabled}
                                selected={false}
                                onClick={() => seek(clip.timeline_in.t)}
                                style={{
                                  ...geometry(clip.timeline_in.t, clip.timeline_out.t, span),
                                  ...appear(clip.id),
                                }}
                              >
                                {track.kind === "audio" && (
                                  <Wave
                                    clip={clip}
                                    width={numberOf(
                                      mul(
                                        sub(
                                          parseRational(clip.timeline_out.t, true),
                                          parseRational(clip.timeline_in.t, true),
                                        ),
                                        scale,
                                      ),
                                    )}
                                    scale={scale}
                                    config={config}
                                    hasAudio={source.media.some(
                                      (media) =>
                                        media.id === clip.media_id && (media.kind === "audio" || !!media.audio),
                                    )}
                                  />
                                )}
                                {track.kind === "video" && (
                                  <span
                                    className="zc-film"
                                    aria-hidden="true"
                                    style={
                                      config
                                        ? {
                                            // shortcut: repeat the source-in thumbnail; share Film when review needs time-sampled thumbnails.
                                            backgroundImage: `url("${mediaUrl(config, "thumb", clip.media_id, clip.source_in.t)}")`,
                                            backgroundSize: "auto 100%",
                                            backgroundRepeat: "repeat-x",
                                          }
                                        : {}
                                    }
                                  />
                                )}
                              </Clip>
                            ))}
                            {source.cues
                              .filter((cue) => cue.track_id === track.id)
                              .map((cue) => (
                                <Clip
                                  key={`${cue.cue_id}-${cue.piece}`}
                                  kind="subtitle"
                                  label={cue.text}
                                  selected={false}
                                  dimmed={false}
                                  onClick={() => seek(cue.start)}
                                  style={{
                                    ...geometry(cue.start, cue.end, span),
                                    ...appear(
                                      located.find(
                                        (item) =>
                                          freshKeys.has(item.change.key) &&
                                          item.positions.some(
                                            (position) =>
                                              position.track === cue.track_id &&
                                              position.start === cue.start &&
                                              position.end === cue.end,
                                          ),
                                      )?.change.key ?? cue.cue_id,
                                    ),
                                  }}
                                />
                              ))}
                          </section>
                        );
                      })}
                    {mode === "compare" &&
                      located.flatMap(({ change, before, positions }) =>
                        positions
                          .filter((position) => position.track === track.id)
                          .map((position, index) => (
                            <button
                              type="button"
                              aria-label={`${kindLabels[changeKind(change)]} · ${entityNames[change.entity] ?? "内容"}`}
                              title={`${kindLabels[changeKind(change)]} · ${entityNames[change.entity] ?? "内容"}`}
                              key={`${change.key}-${index}`}
                              data-change-key={change.key}
                              data-start={position.start}
                              data-end={position.end}
                              className={`zc-review-outline is-${changeKind(change)} is-${before ? "original" : "plan"}`}
                              style={{
                                ...geometry(position.start, position.end, span),
                                ...appear(change.key),
                              }}
                              onClick={() => seek(position.start)}
                            >
                              {changeKind(change) === "added" ? "+" : changeKind(change) === "removed" ? "−" : ""}
                            </button>
                          )),
                      )}
                  </div>
                </div>
              ))}
              <span
                className="zc-review-playhead"
                style={{
                  left: `calc(var(--track-label-w) + (100% - var(--track-label-w)) * ${numberOf(div(parseRational("at" in state.playhead ? state.playhead.at : "0s", true), parseRational(span, true)))})`,
                }}
              />
            </div>
          </div>
        ) : (
          <output className="zc-pad">{error || "正在读取方案…"}</output>
        )}
      </section>
    </>
  );
}
