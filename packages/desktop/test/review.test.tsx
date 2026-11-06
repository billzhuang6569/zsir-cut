// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { URL as NodeURL } from "node:url";
import { act, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ProjectChanged } from "../../app-host/src/revision-events.js";
import type { EntityChange } from "../../core/dist/index.js";
import { useAiPanel } from "../src/AiPanel.js";
import type { ProjectView } from "../src/connection.js";
import { type ReviewSummary, ReviewView } from "../src/ReviewView.js";
import { initialState, type UiState } from "../src/state.js";
import type { ClipView } from "../src/timeline.js";
import { recordingCanvas } from "./canvas.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root;
let node: HTMLDivElement;
let reduced = false;
beforeEach(() => {
  vi.useFakeTimers();
  reduced = false;
  vi.stubGlobal("matchMedia", () => ({ matches: reduced, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => recordingCanvas().context);
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
  node = document.createElement("div");
  document.body.append(node);
  root = createRoot(node);
});
afterEach(async () => {
  await act(() => root.unmount());
  node.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const clip = (id: string, start: string, end: string): ClipView => ({
  id,
  media_id: "med_interview",
  occurrence_id: `occ_${id}`,
  enabled: true,
  label: id,
  timeline_in: { t: start },
  timeline_out: { t: end },
  source_in: { t: "0s" },
  source_out: { t: "2s" },
  speed: "1",
});
const original: ProjectView = {
  id: "tl_main",
  name: "会话 fixture",
  edit_rate: "25",
  drop_frame: false,
  start_timecode: "00:00:00:00",
  revision: { id: "rev_base", seq: 0 },
  duration: { t: "10s" },
  markers: [],
  media: [],
  styles: [],
  tracks: [
    {
      id: "trk_video",
      name: "视频 A",
      kind: "video",
      enabled: true,
      clips: [clip("clp_delete1", "0s", "2s"), clip("clp_delete2", "3s", "5s"), clip("clp_keep", "6s", "10s")],
    },
    { id: "trk_broll", name: "视频 B", kind: "video", enabled: true, clips: [] },
    { id: "trk_sub", name: "字幕 A", kind: "subtitle", enabled: true, clips: [] },
  ],
  cues: [
    {
      cue_id: "cue_brand",
      track_id: "trk_sub",
      occurrence_id: "occ_keep",
      token_ids: ["tok_brand"],
      start: "7s",
      end: "9s",
      text: "豆宝",
      style_id: "",
      piece: 0,
    },
    {
      cue_id: "cue_unchanged",
      track_id: "trk_sub",
      start: "9s",
      end: "10s",
      text: "未改的字幕",
      style_id: "",
      piece: 0,
    },
  ],
};
const plan: ProjectView = {
  ...original,
  revision: { id: "rev_draft", seq: 4 },
  cues: original.cues.map((cue) => (cue.cue_id === "cue_brand" ? { ...cue, text: "豆包", start: "8s" } : cue)),
  tracks: original.tracks.map((track) => ({
    ...track,
    clips:
      track.id === "trk_video"
        ? [clip("clp_keep", "6s", "10s")]
        : track.id === "trk_broll"
          ? [clip("clp_broll", "4s", "6s")]
          : [],
  })),
};
function entity(
  key: string,
  parent: string,
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
  type: EntityChange["entity"] = "clip",
): EntityChange {
  return {
    key,
    entity: type,
    before,
    after,
    before_parent: before ? parent : null,
    after_parent: after ? parent : null,
    before_index: null,
    after_index: null,
  };
}
// Host fixture: delete two clips, add B-roll, correct one source token; projection stays on the host.
const changes = [
  entity("clp_delete1", "trk_video", { timeline_start: "0s", duration: "2s" }, null),
  entity("clp_delete2", "trk_video", { timeline_start: "3s", duration: "2s" }, null),
  entity("clp_broll", "trk_broll", null, { timeline_start: "4s", duration: "2s" }),
];
const subtitle = entity("tok_brand", "trs_source", { text: "豆宝" }, { text: "豆包" }, "token");
const summary: ReviewSummary = {
  base_revision: "rev_base",
  draft_revision: "rev_draft",
  timeline_changes: changes,
  subtitle_changes: [subtitle],
  pending_count: 1,
  steps: [...changes, subtitle].map((change, index) => ({
    revision: { id: `rev_${index + 1}`, seq: index + 1 },
    label: ["删除开拍前沟通", "删除重复", "添加 B-roll", "校正品牌词"][index] ?? "",
    reason: "保留主要信息",
    keys: [change.key],
    summary: {
      [change.entity]: {
        added: change.before === null ? 1 : 0,
        removed: change.after === null ? 1 : 0,
        changed: change.before && change.after ? 1 : 0,
      },
    },
  })),
};
function host() {
  let current = structuredClone(summary);
  const call = vi.fn(async (verb: string, request: Record<string, unknown>): Promise<unknown> => {
    if (verb === "inspect" && request.view === "review") return structuredClone(current);
    if (verb === "inspect" && request.view === "session")
      return { state: "in_review", intent: "删重复、加画面、改字幕" };
    if (verb === "inspect" && request.view === "timeline")
      return request.session_id ? plan : request.at_revision === "rev_base" ? original : plan;
    if (verb === "inspect" && request.view === "brief")
      return { project: { name: "会话 fixture", revision: { id: "rev_approved", seq: 1 } } };
    if (verb === "preview_data")
      return {
        media: original.media,
        styles: original.styles,
        cues: request.session_id ? plan.cues : request.at_revision === "rev_base" ? original.cues : plan.cues,
      };
    if (verb === "chat_agents" || verb === "chat_list") return [];
    if (verb === "ai_state")
      return {
        sessions: [
          {
            session_id: "ses_review",
            state: "in_review",
            base_revision: "rev_base",
            draft_revision: "rev_draft",
            pending_count: 1,
            revision_count: 4,
            changes: [],
            decisions: [],
          },
        ],
        batches: [],
      };
    return {};
  });
  return {
    call,
    setSummary: (value: ReviewSummary) => {
      current = value;
    },
  };
}
function button(label: string) {
  const result = [...node.querySelectorAll<HTMLButtonElement>("button")].find(
    (item) => item.textContent === label || item.getAttribute("aria-label") === label,
  );
  if (!result) throw new Error(`Missing ${label}`);
  return result;
}
function Fixture({
  call,
  change = null,
  revision = 0,
  close = vi.fn(),
  committed = vi.fn(),
}: {
  call: ReturnType<typeof host>["call"];
  change?: ProjectChanged | null;
  revision?: number;
  close?: () => void;
  committed?: (view: ProjectView) => void;
}) {
  const [state, update] = useState<UiState>({ ...initialState(), project: "/fixture.zcut.json" });
  const [target, setTarget] = useState<HTMLElement | null>(null);
  const dragging = useRef(false);
  const ai = useAiPanel({ call, path: state.project, project: original, notices: [], revision });
  return (
    <>
      <aside ref={setTarget} />
      <output data-playhead>{"at" in state.playhead ? state.playhead.at : ""}</output>
      <ReviewView
        sessionId="ses_review"
        revision={revision}
        project={original}
        state={state}
        update={update}
        call={call}
        change={change}
        actions={ai.reviewActions}
        parametersTarget={target}
        viewerTarget={null}
        config={undefined}
        dragging={dragging}
        close={close}
        committed={committed}
      />
    </>
  );
}
it("uses read-only host views; outlines match each change and only-original uses the base view", async () => {
  const { call } = host();
  await act(async () => root.render(<Fixture call={call} />));
  expect(call).toHaveBeenCalledWith("inspect", {
    project: "/fixture.zcut.json",
    view: "review",
    session_id: "ses_review",
  });
  expect(call).toHaveBeenCalledWith("inspect", {
    project: "/fixture.zcut.json",
    view: "timeline",
    at_revision: "rev_base",
  });
  expect(call).toHaveBeenCalledWith("inspect", {
    project: "/fixture.zcut.json",
    view: "timeline",
    session_id: "ses_review",
    at_revision: "rev_draft",
  });
  expect(call.mock.calls.some(([verb]) => verb === "diff" || verb === "session_review")).toBe(false);
  const outlines = [...node.querySelectorAll<HTMLElement>("[data-change-key]")];
  expect(outlines.map((outline) => [outline.dataset.changeKey, outline.dataset.start, outline.dataset.end])).toEqual([
    ["clp_delete1", "0s", "2s"],
    ["clp_delete2", "3s", "5s"],
    ["clp_broll", "4s", "6s"],
    ["tok_brand", "8s", "9s"],
  ]);
  expect(outlines.map((outline) => outline.style.left)).toEqual(["0%", "30%", "40%", "80%"]);
  expect(outlines.map((outline) => outline.style.width)).toEqual(["20%", "20%", "20%", "10%"]);
  expect(outlines.filter((item) => item.classList.contains("is-removed"))).toHaveLength(2);
  expect(outlines[2]?.classList.contains("is-added")).toBe(true);
  expect(outlines[3]?.classList.contains("is-changed")).toBe(true);
  await act(() => button("只看原来").click());
  expect(node.querySelectorAll(".is-plan")).toHaveLength(0);
  expect(node.querySelectorAll("[data-change-key]")).toHaveLength(0);
  expect([...node.querySelectorAll(".zc-review-lane .zc-clip")].map((item) => item.getAttribute("aria-label"))).toEqual(
    ["clp_delete1", "clp_delete2", "clp_keep", "豆宝", "未改的字幕"],
  );
  await act(() => button("只看方案").click());
  expect(node.querySelectorAll(".is-original")).toHaveLength(0);
  expect(node.querySelector(".zc-review-lanes")?.textContent).not.toContain("clp_delete");
  expect([...node.querySelectorAll(".zc-review-lane .zc-clip-subtitle")].map((cue) => cue.textContent)).toEqual([
    "豆包",
    "未改的字幕",
  ]);
  expect(call).toHaveBeenCalledWith("preview_data", { session_id: "ses_review", at_revision: "rev_draft" });
});
it("step clicks and arrow navigation seek among host changes without editing", async () => {
  const { call } = host();
  await act(async () => root.render(<Fixture call={call} />));
  const step = node.querySelectorAll<HTMLButtonElement>("[data-step]")[2];
  await act(() => step?.click());
  expect(node.querySelector("[data-playhead]")?.textContent).toBe("4s");
  await act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown" })));
  expect(node.querySelector("[data-playhead]")?.textContent).toBe("8s");
  await act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp" })));
  expect(node.querySelector("[data-playhead]")?.textContent).toBe("4s");
  expect(call.mock.calls.some(([verb]) => verb === "edit")).toBe(false);
});
it.each([false, true])(
  "expands, staggers new steps on matching pushes and collapses after the committed read (reduced=%s)",
  async (reduce) => {
    reduced = reduce;
    const { call, setSummary } = host();
    const close = vi.fn(),
      committed = vi.fn();
    const render = (change: ProjectChanged | null = null) =>
      act(async () => root.render(<Fixture call={call} change={change} close={close} committed={committed} />));
    await render();
    const timeline = () => node.querySelector<HTMLElement>('[aria-label="时间线对比"]');
    expect(timeline()?.dataset.phase).toBe("expanding");
    await act(() => vi.advanceTimersByTime(reduce ? 149 : 559));
    expect(timeline()?.dataset.phase).toBe("expanding");
    await act(() => vi.advanceTimersByTime(1));
    expect(timeline()?.dataset.phase).toBe("ready");
    const count = call.mock.calls.filter(([, request]) => request.view === "review").length;
    const event = {
      target: "session",
      session_id: "ses_other",
      revision: { id: "rev_other", seq: 5 },
    } as ProjectChanged;
    await render(event);
    expect(call.mock.calls.filter(([, request]) => request.view === "review")).toHaveLength(count);
    setSummary({
      ...summary,
      steps: [
        ...summary.steps,
        ...[5, 6].map((i) => ({
          ...(summary.steps[2] as ReviewSummary["steps"][number]),
          revision: { id: `rev_${i}`, seq: i },
        })),
      ],
    });
    await render({ ...event, session_id: "ses_review" });
    const newSteps = [...node.querySelectorAll<HTMLElement>("[data-step].is-new")];
    expect(newSteps.map((item) => item.dataset.step)).toEqual(["rev_5", "rev_6"]);
    expect(newSteps.map((item) => item.style.animationDelay)).toEqual(["0ms", reduce ? "0ms" : "80ms"]);
    const refreshed = call.mock.calls.filter(([, request]) => request.view === "review").length;
    await render({ ...event, revision: { id: "rev_unrelated", seq: 7 } });
    expect(call.mock.calls.filter(([, request]) => request.view === "review")).toHaveLength(refreshed);
    await act(() => button("全部批准").click());
    expect(call.mock.calls.some(([verb]) => verb === "session_approve")).toBe(false);
    expect(node.textContent).toContain("还有 1 件决定未答");
    await act(async () => button("仍然批准").click());
    expect(call).toHaveBeenCalledWith(
      "session_approve",
      expect.objectContaining({ base_revision: "rev_base", session_id: "ses_review" }),
    );
    expect(timeline()?.dataset.phase).toBe("collapsing");
    expect(close).not.toHaveBeenCalled();
    await act(() => vi.advanceTimersByTime(reduce ? 149 : 299));
    expect(close).not.toHaveBeenCalled();
    await act(() => vi.advanceTimersByTime(1));
    expect(close).toHaveBeenCalledOnce();
    expect(committed).toHaveBeenCalledWith(
      expect.objectContaining({ tracks: plan.tracks, revision: { id: "rev_approved", seq: 1 } }),
    );
  },
);
it("rejects through the same main-revision write flow", async () => {
  const { call } = host();
  const close = vi.fn();
  await act(async () => root.render(<Fixture call={call} close={close} />));
  await act(async () => button("拒绝").click());
  expect(call).toHaveBeenCalledWith(
    "session_reject",
    expect.objectContaining({
      base_revision: "rev_base",
      session_id: "ses_review",
      author: { kind: "human", name: "桌面用户" },
    }),
  );
  await act(() => vi.advanceTimersByTime(300));
  expect(close).toHaveBeenCalledOnce();
});
it("uses only opacity in reduced-motion CSS", () => {
  const css = readFileSync(new NodeURL("../src/review.css", import.meta.url), "utf8");
  const reducedCss = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)"));
  expect(reducedCss).toContain("opacity 150ms");
  expect(reducedCss).not.toContain("scale");
  expect(reducedCss).not.toContain("left 150ms");
});
it("keeps unpositioned source-text changes in the details instead of inventing a timeline range", async () => {
  const { call, setSummary } = host();
  setSummary({
    ...summary,
    subtitle_changes: [entity("tok_unprojected", "trn_source", { text: "豆宝" }, { text: "豆包" }, "token")],
  });
  await act(async () => root.render(<Fixture call={call} />));
  expect(node.querySelectorAll("[data-change-key]")).toHaveLength(3);
  expect(node.querySelector("details")?.textContent).toContain("字词");
  expect(node.querySelector("details")?.textContent).toContain("豆包");
});
it("does not accept or close a draft when the write fails", async () => {
  const { call } = host();
  const handle = call.getMockImplementation();
  call.mockImplementation(async (verb, request) => {
    if (verb === "session_reject") throw new Error("conflict");
    return handle?.(verb, request);
  });
  const close = vi.fn();
  await act(async () => root.render(<Fixture call={call} close={close} />));
  await act(async () => button("拒绝").click());
  await act(() => vi.advanceTimersByTime(1000));
  expect(close).not.toHaveBeenCalled();
  expect(node.querySelector('[role="alert"]')?.textContent).toContain("conflict");
});
it("locates a subtitle override only in its host-projected occurrence", async () => {
  const { call, setSummary } = host();
  const handle = call.getMockImplementation();
  setSummary({
    ...summary,
    subtitle_changes: [
      entity(
        "override:trk_sub:occ_keep:cue_brand",
        "trk_sub",
        { cue_id: "cue_brand", occurrence_id: "occ_keep", text: "豆宝" },
        { cue_id: "cue_brand", occurrence_id: "occ_keep", text: "豆包" },
        "override",
      ),
    ],
  });
  call.mockImplementation(async (verb, request) => {
    if (verb === "preview_data" && request.session_id)
      return {
        media: [],
        styles: [],
        cues: [...plan.cues, { ...plan.cues[0], occurrence_id: "occ_other", piece: 1, start: "1s", end: "2s" }],
      };
    return handle?.(verb, request);
  });
  await act(async () => root.render(<Fixture call={call} />));
  const outlines = node.querySelectorAll<HTMLElement>('[data-change-key^="override:"]');
  expect(outlines).toHaveLength(1);
  expect(outlines[0]?.dataset.start).toBe("8s");
  expect(outlines[0]?.dataset.end).toBe("9s");
});
it("refreshes session readiness on ai_changed even when submitting for review writes no revision", async () => {
  const { call } = host();
  const handle = call.getMockImplementation();
  let state = "open";
  call.mockImplementation(async (verb, request) => {
    if (verb === "inspect" && request.view === "session") return { state, intent: "正在写草稿" };
    return handle?.(verb, request);
  });
  await act(async () => root.render(<Fixture call={call} />));
  expect(button("全部批准").disabled).toBe(true);
  state = "in_review";
  await act(async () => root.render(<Fixture call={call} revision={1} />));
  expect(button("全部批准").disabled).toBe(false);
});
