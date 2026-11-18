import { useEffect, useRef, useState } from "react";
import type { ProjectChanged } from "../../app-host/src/revision-events.js";
import { mapSourceTimeToClip } from "../../core/src/project/time-map.ts";
import { Button, type Decision } from "./ai-components.js";
import { DESKTOP_AUTHOR, type ProjectView } from "./connection.js";
import type { HistoryEntry } from "./HistoryPanel.js";
import { add, compare, div, parseRational, printRational, rational, sub, type Time } from "./timeline.js";

type Call = (verb: string, request: Record<string, unknown>) => Promise<unknown>;
type Answer = { option_id: string } | { text: string };
type Ref = (
  | { kind: "time"; at: Time }
  | { kind: "entity"; id: string }
  | { kind: "source"; occurrence_id: string; media_id: string; source_start: Time; duration: Time }
) & { missing?: boolean };
interface ProjectDecision extends Decision {
  refs?: Ref[];
  options: (Decision["options"][number] & { label_after?: string })[];
  execution?: { state: "applied" | "stale" | "failed" | "none"; revision?: string; error?: { message: string } | null };
}
type Result = { decision?: ProjectDecision };
type Location = { start: string; end?: string; ids: string[] };
const parse = (value: string) => parseRational(value, true);
const print = (value: ReturnType<typeof parse>) => printRational(value, true);
const clipsOf = (project: ProjectView) => project.tracks.flatMap((track) => track.clips);

function refLocations(project: ProjectView, ref: Ref): Location[] {
  if (ref.missing) return [];
  const clips = clipsOf(project);
  if (ref.kind === "entity") {
    const clip = clips.find(({ id }) => id === ref.id);
    if (clip) return [{ start: clip.timeline_in.t, end: clip.timeline_out.t, ids: [clip.id] }];
    const cue = project.cues.find(({ cue_id }) => cue_id === ref.id);
    if (cue) return [{ start: cue.start, end: cue.end, ids: cue.clip_ids ?? [] }];
  }
  if (ref.kind !== "source") {
    const at = ref.kind === "time" ? ref.at.t : project.markers.find(({ id }) => id === ref.id)?.at.t;
    if (!at) return [];
    const clip = clips.find(
      (item) =>
        compare(parse(item.timeline_in.t), parse(at)) <= 0 && compare(parse(at), parse(item.timeline_out.t)) < 0,
    );
    const end = clip ? parse(clip.timeline_out.t) : add(parse(at), div(rational(1n), parse(project.edit_rate)));
    return [
      {
        start: at,
        end: compare(end, parse(project.duration.t)) <= 0 ? print(end) : project.duration.t,
        ids: clip ? [clip.id] : [],
      },
    ];
  }
  const start = parse(ref.source_start.t);
  const end = add(start, parse(ref.duration.t));
  const ranges: Location[] = [];
  for (const clip of clips) {
    if (!clip.enabled || clip.occurrence_id !== ref.occurrence_id || clip.media_id !== ref.media_id) continue;
    const points = (
      clip.time_map ?? [
        { at: clip.timeline_in, source: clip.source_in, interp: "linear" },
        { at: clip.timeline_out, source: clip.source_out, interp: "linear" },
      ]
    ).map((point) => ({
      at: parse(point.at.t),
      source: parse(point.source.t),
      interp: point.interp as "linear" | "hold" | "smooth",
    }));
    for (const [index, first] of points.entries()) {
      const last = points[index + 1];
      if (!last) break;
      const direction = compare(last.source, first.source);
      let from = first.at;
      let to = last.at;
      if (first.interp === "hold" || direction === 0) {
        if (compare(first.source, start) < 0 || compare(first.source, end) >= 0) continue;
      } else {
        const [low, high] = direction > 0 ? [first, last] : [last, first];
        if (compare(high.source, start) <= 0 || compare(low.source, end) >= 0) continue;
        const a = mapSourceTimeToClip(start, low, high);
        const b = mapSourceTimeToClip(end, low, high);
        if (!a || !b) continue;
        [from, to] = direction > 0 ? [a, b] : [b, a];
      }
      const previous = ranges.at(-1);
      if (previous?.ids.includes(clip.id) && previous.end === print(from)) previous.end = print(to);
      else ranges.push({ start: print(from), end: print(to), ids: [clip.id] });
    }
  }
  const merged = new Map<string, Location>();
  for (const range of ranges) {
    const key = `${range.start}/${range.end}`;
    const previous = merged.get(key);
    if (previous) previous.ids.push(...range.ids);
    else merged.set(key, range);
  }
  return [...merged.values()].sort((a, b) => compare(parse(a.start), parse(b.start)));
}

async function jump(call: Call, location: Location, play = false) {
  await call("ui_seek", { at: location.start });
  await call("ui_select", { ids: location.ids, keepParameters: true });
  if (play && location.end && compare(parse(location.start), parse(location.end)) < 0)
    await call("ui_play", {
      range: { start: location.start, duration: print(sub(parse(location.end), parse(location.start))) },
    });
}

function sourceQuote(project: ProjectView, ref: Extract<Ref, { kind: "source" }>) {
  const start = parse(ref.source_start.t);
  const end = add(start, parse(ref.duration.t));
  return project.transcripts
    ?.filter(({ media_id }) => media_id === ref.media_id)
    .map(({ tokens }) =>
      tokens
        .filter(({ align }) => compare(parse(align.end), start) > 0 && compare(parse(align.start), end) < 0)
        .map(({ heard, text }) => heard ?? text)
        .join("")
        .trim(),
    )
    .find(Boolean);
}

function ProjectDecisionCard({
  decision,
  project,
  call,
  submit,
}: {
  decision: ProjectDecision;
  project: ProjectView | null;
  call: Call;
  submit: (answer: Answer) => Promise<ProjectDecision | undefined>;
}) {
  const [later, setLater] = useState(false);
  const [other, setOther] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const lock = useRef(false);
  const respond = async (answer: Answer) => {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      await submit(answer);
    } catch (e) {
      setError(String(e));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };
  const execution = decision.execution;
  return (
    <section className="zc-q" aria-label={decision.question}>
      <h4 className="zc-q-question">{decision.question}</h4>
      {decision.state !== "pending" ? (
        <output>
          {execution?.state === "applied"
            ? "已按你的选择改好"
            : execution?.state === "stale"
              ? "这一段已经改过，已转给 AI 按最新工程重做"
              : execution?.state === "failed"
                ? `没能改好：${execution.error?.message ?? "执行失败"}`
                : "已记录你的选择"}
        </output>
      ) : later ? (
        <Button onClick={() => setLater(false)}>继续回答</Button>
      ) : (
        <>
          {decision.tag && <p className="zc-q-context">{decision.tag}</p>}
          {project &&
            decision.refs?.map((ref) => {
              const locations = refLocations(project, ref);
              const original = ref.kind === "source" ? sourceQuote(project, ref) : undefined;
              const label =
                ref.kind === "source"
                  ? `源素材 ${ref.source_start.tc ?? ref.source_start.t}`
                  : ref.kind === "time"
                    ? (ref.at.tc ?? ref.at.t)
                    : "引用位置";
              return (
                <div key={JSON.stringify(ref)}>
                  {original && <p className="zc-q-context">「{original}」</p>}
                  {locations.length ? (
                    locations.map((location, part) => {
                      const quote =
                        !original &&
                        project.cues.find(
                          (cue) =>
                            compare(parse(cue.end), parse(location.start)) > 0 &&
                            compare(parse(cue.start), parse(location.end ?? location.start)) < 0,
                        )?.text;
                      return (
                        <div key={`${location.start}/${location.end}`}>
                          {quote && <p className="zc-q-context">「{quote}」</p>}
                          <Button
                            icon="play"
                            onClick={() => void jump(call, location, true).catch((e) => setError(String(e)))}
                          >
                            {label}
                            {locations.length > 1 ? ` · 第 ${part + 1} 段` : ""}
                          </Button>
                        </div>
                      );
                    })
                  ) : (
                    <p className="zc-muted">{label} · 当前时间线上找不到</p>
                  )}
                </div>
              );
            })}
          <div className="zc-q-options">
            {[...decision.options]
              .sort((a, b) => Number(Boolean(b.recommended)) - Number(Boolean(a.recommended)))
              .map((option) => (
                <button
                  key={option.id}
                  type="button"
                  className="zc-q-option"
                  disabled={busy}
                  onClick={() => void respond({ option_id: option.id })}
                >
                  <span className="zc-q-label">
                    {option.label}
                    {option.recommended && " · 推荐"}
                    {option.note && <span className="zc-q-note">{option.note}</span>}
                    {option.label_after &&
                      option.label_after !== option.note &&
                      option.label_after !== option.label && <span className="zc-q-note">{option.label_after}</span>}
                  </span>
                </button>
              ))}
          </div>
          {decision.allow_other !== false && (
            <form
              className="zc-activity-heading"
              onSubmit={(event) => {
                event.preventDefault();
                if (other.trim()) void respond({ text: other.trim() });
              }}
            >
              <input
                className="zc-q-other-input"
                aria-label="其他想法"
                placeholder="其他想法…"
                value={other}
                disabled={busy}
                onChange={(event) => setOther(event.target.value)}
              />
              <Button type="submit" disabled={busy || !other.trim()}>
                提交
              </Button>
            </form>
          )}
          <Button variant="text" disabled={busy} onClick={() => setLater(true)}>
            稍后
          </Button>
        </>
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}

export function useProjectDecisions(
  call: Call,
  path: string | null,
  epoch: number,
  revision: number,
  project: ProjectView | null,
) {
  const scope = useRef({ path, epoch });
  if (scope.current.path !== path || scope.current.epoch !== epoch) scope.current = { path, epoch };
  const generation = scope.current;
  const [pending, setPending] = useState<ProjectDecision[]>([]);
  const [completed, setCompleted] = useState<ProjectDecision[]>([]);
  const [error, setError] = useState("");
  const answerQueue = useRef(Promise.resolve());
  // biome-ignore lint/correctness/useExhaustiveDependencies: Decision state belongs to the current project connection.
  useEffect(() => {
    setPending([]);
    setCompleted([]);
    setError("");
    answerQueue.current = Promise.resolve();
  }, [generation]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: The host revision counter invalidates the decision queue.
  useEffect(() => {
    if (!path) return;
    let active = true;
    void call("inspect", { project: path, view: "decisions" })
      .then((value) => {
        if (!active || scope.current !== generation) return;
        const result = value as { decisions?: ProjectDecision[] };
        setPending((result?.decisions ?? []).filter(({ state }) => state === "pending").sort((a, b) => a.seq - b.seq));
        setError("");
      })
      .catch((e: Error) => {
        if (active && scope.current === generation) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [call, path, generation, revision]);

  const baseRevision = useRef(project?.revision.id);
  baseRevision.current = project?.revision.id;
  const answer = (decision: ProjectDecision, value: Answer) => {
    const run = answerQueue.current.then(async () => {
      if (scope.current !== generation) return;
      if (!baseRevision.current) throw new Error("工程还在打开，请稍后再试");
      const idempotency_key = crypto.randomUUID();
      let result: Result;
      try {
        result = (await call("answer", {
          project: path,
          base_revision: baseRevision.current,
          author: DESKTOP_AUTHOR,
          idempotency_key,
          decision_id: decision.id,
          ...value,
        })) as Result;
      } catch (e) {
        const failure = (e as { result?: Result }).result;
        if (!failure?.decision) throw e;
        result = failure;
      }
      if (scope.current !== generation) return;
      const updated = result.decision;
      if (!updated || updated.state === "pending") throw new Error("回答未保存，请重试");
      setPending((items) => items.filter(({ id }) => id !== updated.id));
      setCompleted((items) => [...items, updated]);
      return updated;
    });
    answerQueue.current = run.then(
      () => {},
      () => {},
    );
    return run;
  };
  return { pending: pending.filter(({ id }) => !completed.some((item) => item.id === id)), completed, error, answer };
}

export function ProjectDecisions({
  decisions,
  call,
  project,
  answered,
}: {
  decisions: ReturnType<typeof useProjectDecisions>;
  call: Call;
  project: ProjectView | null;
  answered: (id: string, line: string) => void;
}) {
  return (
    <section className="zc-activity-section" aria-label="待你决定">
      <h3>待你决定{decisions.pending.length > 0 ? ` · ${decisions.pending.length}` : ""}</h3>
      {decisions.error && <p role="alert">{decisions.error}</p>}
      {!decisions.pending.length && !decisions.completed.length && !decisions.error && (
        <p className="zc-muted">暂无待定事项</p>
      )}
      {[...decisions.pending, ...decisions.completed].map((decision) => (
        <ProjectDecisionCard
          key={decision.id}
          decision={decision}
          project={project}
          call={call}
          submit={async (value) => {
            const result = await decisions.answer(decision, value);
            if (result?.execution?.state === "applied" || result?.execution?.state === "none") {
              const label =
                "text" in value ? value.text : decision.options.find(({ id }) => id === value.option_id)?.label;
              answered(decision.id, `已回答：${decision.question} → ${label ?? ""}`);
            }
            return result;
          }}
        />
      ))}
    </section>
  );
}

interface ActivityStep {
  id: string;
  seq: number;
  turn: string;
  label: string | null;
  reason: string | null | undefined;
  author: { name: string } | undefined;
  locations: Location[];
  keys: string[];
}

function historyStep(entry: HistoryEntry): ActivityStep[] {
  if (!entry.turn) return [];
  return [
    {
      id: entry.revision,
      seq: entry.seq,
      turn: entry.turn.id,
      label: entry.label,
      reason: entry.reason,
      author: entry.author,
      keys: (entry.changes ?? []).map(({ key }) => key),
      locations: (entry.changes ?? []).flatMap((change) => {
        const value = change.after ?? change.before;
        if (change.entity !== "clip" || typeof value?.timeline_start !== "string" || typeof value.duration !== "string")
          return [];
        return [
          {
            ids: [change.key],
            start: value.timeline_start,
            end: print(add(parse(value.timeline_start), parse(value.duration))),
          },
        ];
      }),
    },
  ];
}

function liveStep(event: ProjectChanged): ActivityStep[] {
  if (
    !event.turn ||
    event.target !== "main" ||
    (event.author?.kind !== "agent" && ["undo", "redo"].includes(event.verb ?? ""))
  )
    return [];
  return [
    {
      id: event.revision.id,
      seq: event.revision.seq,
      turn: event.turn,
      label: event.label,
      reason: event.reason,
      author: event.author,
      keys: event.changes.map(({ key }) => key),
      locations: event.changes.flatMap((change) => {
        const position = change.after ?? change.before;
        return change.entity === "clip" && position
          ? [{ ids: [change.key], start: position.start, end: position.end }]
          : [];
      }),
    },
  ];
}

const pageSize = 100;
export function TurnActivity({
  call,
  path,
  project,
  turn,
  changes,
  acknowledge,
}: {
  call: Call;
  path: string;
  project: ProjectView | null;
  turn: string | undefined;
  changes: ProjectChanged[];
  acknowledge?: (() => void) | undefined;
}) {
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [more, setMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [undoing, setUndoing] = useState(false);
  const [undone, setUndone] = useState<{ turn: string; seq: number }[]>([]);
  const [conflict, setConflict] = useState<{ turn: string; names: { key: string; label: string }[] }>();
  const [error, setError] = useState("");
  const readPage = (before?: string) =>
    call("inspect", {
      project: path,
      view: "history",
      limit: pageSize,
      ...(before ? { before } : {}),
    }) as Promise<{ entries?: HistoryEntry[] }>;
  // biome-ignore lint/correctness/useExhaustiveDependencies: Fetch the first page for each mounted project.
  useEffect(() => {
    let active = true;
    void readPage()
      .then(({ entries = [] } = {}) => {
        if (!active) return;
        setHistory(entries);
        setMore(entries.length === pageSize);
      })
      .catch((e: Error) => {
        if (active) setError(e.message);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [path, call]);
  const steps = [
    ...new Map([...changes.flatMap(liveStep), ...history.flatMap(historyStep)].map((step) => [step.id, step])).values(),
  ].sort((a, b) => a.seq - b.seq);
  const groups = new Map<string, ActivityStep[]>();
  for (const step of steps) {
    const group = groups.get(step.turn) ?? [];
    group.push(step);
    groups.set(step.turn, group);
  }
  const current = turn ?? steps.at(-1)?.turn;
  const currentSteps = current ? (groups.get(current) ?? []) : [];
  const latestToggle = history.find((entry) => entry.turn_id === current && ["undo", "redo"].includes(entry.kind));
  const liveToggle = changes.findLast(
    (event) =>
      event.turn === current && event.author?.kind !== "agent" && (event.verb === "undo" || event.verb === "redo"),
  );
  const undoSeq = Math.max(
    -1,
    ...undone.filter((item) => item.turn === current).map(({ seq }) => seq),
    liveToggle?.verb === "undo" ? liveToggle.revision.seq : latestToggle?.kind === "undo" ? latestToggle.seq : -1,
  );
  const withdrawn = undoSeq >= 0 && undoSeq >= (currentSteps.at(-1)?.seq ?? 0);
  const undo = async () => {
    if (!current || !project || undoing) return;
    setUndoing(true);
    setError("");
    setConflict(undefined);
    try {
      await call("undo", {
        project: path,
        base_revision: project.revision.id,
        turn_id: current,
        author: DESKTOP_AUTHOR,
        idempotency_key: crypto.randomUUID(),
      });
      setUndone((items) => [...items, { turn: current, seq: currentSteps.at(-1)?.seq ?? 0 }]);
    } catch (e) {
      const failure = e as { code?: string; details?: { keys?: string[] }; message: string };
      if (failure.code === "E_UNDO_CONFLICT") {
        const names = (failure.details?.keys ?? []).map((key) => {
          const clip = clipsOf(project).find(({ id }) => id === key);
          const change = history.flatMap((entry) => entry.changes ?? []).find((entry) => entry.key === key);
          const label = String(
            clip?.label ??
              (clip && project.media.find(({ id }) => id === clip.media_id)?.name) ??
              change?.after?.label ??
              change?.before?.label ??
              project.cues.find(({ cue_id }) => cue_id === key)?.text ??
              project.markers.find(({ id }) => id === key)?.text ??
              key,
          );
          return { key, label };
        });
        setConflict({ turn: current, names });
      } else setError(failure.message);
    } finally {
      setUndoing(false);
    }
  };
  const rows = (items: ActivityStep[]) =>
    items.map((step) => {
      const clips = project ? clipsOf(project) : [];
      const ids = step.locations
        .flatMap((location) => location.ids)
        .filter((id) => clips.some((clip) => clip.id === id));
      const location = step.locations.find((item) => item.ids.some((id) => ids.includes(id))) ?? step.locations[0];
      const target = location
        ? { ...location, ids }
        : project && step.keys.flatMap((id) => refLocations(project, { kind: "entity", id }))[0];
      const label = step.label ?? "工程修改";
      return (
        <div key={step.id} className="zc-activity-step">
          <div className="zc-activity-heading">
            {target ? (
              <Button variant="text" onClick={() => void jump(call, target).catch((e) => setError(String(e)))}>
                {label}
              </Button>
            ) : (
              <span>{label}</span>
            )}
            {step.author && <span className="zc-muted">{step.author.name}</span>}
          </div>
          {step.reason && (
            <details className="zc-muted">
              <summary>理由</summary>
              {step.reason}
            </details>
          )}
        </div>
      );
    });

  return (
    <section className="zc-activity-section" aria-label="本轮改动">
      <div className="zc-activity-heading">
        <h3>本轮改动</h3>
        {acknowledge && !withdrawn && <Button onClick={acknowledge}>知道了</Button>}
        {currentSteps.length > 0 &&
          (withdrawn ? (
            <output>已撤回</output>
          ) : (
            <Button disabled={undoing || !project} onClick={() => void undo()}>
              撤回这一轮
            </Button>
          ))}
      </div>
      {conflict && conflict.turn === current && (
        <div role="alert">
          这几处你后来改过
          {conflict.names.length > 0 && (
            <ul>
              {conflict.names.map(({ key, label }) => (
                <li key={key}>{label}</li>
              ))}
            </ul>
          )}
        </div>
      )}
      {error && <p role="alert">{error}</p>}
      {currentSteps.length ? (
        rows(currentSteps)
      ) : (
        <p className="zc-muted">{loading ? "正在读取改动…" : "本轮暂无改动"}</p>
      )}
      {[...groups.entries()]
        .reverse()
        .filter(([id]) => id !== current)
        .map(([id, items]) => (
          <details key={id} className="zc-activity-step">
            <summary>
              {items[0]?.label ?? "工程修改"} · {items.length} 步
            </summary>
            {rows(items)}
          </details>
        ))}
      {more && (
        <Button
          disabled={loading}
          onClick={() => {
            setLoading(true);
            void readPage(history.at(-1)?.revision)
              .then(({ entries = [] } = {}) => {
                setHistory((old) => [...old, ...entries]);
                setMore(entries.length === pageSize);
              })
              .catch((e: Error) => setError(e.message))
              .finally(() => setLoading(false));
          }}
        >
          查看更早的改动
        </Button>
      )}
    </section>
  );
}
