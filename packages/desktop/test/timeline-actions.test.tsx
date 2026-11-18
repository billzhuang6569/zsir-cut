// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Action, mergeKeymap, type presets } from "../../app-host/src/keymap.js";
import { connectHost, DESKTOP_AUTHOR, type ProjectView } from "../src/connection.js";
import { commandBlockReason, runEditorCommand } from "../src/editorShortcuts.js";
import { type Placement, threePointEdit } from "../src/media.js";
import { PreviewMix } from "../src/preview-mix.js";
import { applyUi, initialState } from "../src/state.js";
import { add, compare, frameTime, parseRational, sub } from "../src/timeline.js";
import { recordingCanvas } from "./canvas.js";
import { TimelinePreview } from "./timeline-preview.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let host: HTMLDivElement;
let root: Root;
let state = initialState();
let project: ProjectView;
let aiChanges: Parameters<typeof TimelinePreview>[0]["aiChanges"];
let preset: keyof typeof presets;
let overrides: Partial<Record<Action, string | null>>;
let ui: { snap: boolean; magnetic: boolean; skimming: boolean; track_height: "s" | "m" | "l" };
let readOnly = false;
let sourceViewer = false;
let showViewer = false;
let previewConfig: { port: number; token: string } | undefined;
let inspectorTarget: HTMLDivElement | null = null;
const dragging = { current: false };
const settings = vi.fn();
const reply = () => ({ prefs: { ui, keymap: { preset } }, ...mergeKeymap(preset, overrides) });
const call = vi.fn(async (verb: string, request: Record<string, unknown>) => {
  if (verb === "prefs_get") return reply();
  if (verb === "prefs_set") {
    ui = { ...ui, ...(request.patch as { ui: Partial<typeof ui> }).ui };
    return reply();
  }
  return {};
});
const render = () =>
  root.render(
    <TimelinePreview
      project={project}
      aiChanges={aiChanges}
      state={state}
      update={(next) => {
        state = next;
        render();
      }}
      call={call}
      config={previewConfig}
      error={null}
      dragging={dragging}
      hideViewer={!sourceViewer && !showViewer}
      clipInspectorTarget={inspectorTarget}
      viewerOnly={sourceViewer}
      readOnly={readOnly}
      onOpenSettings={settings}
    />,
  );
const refresh = () =>
  act(async () => {
    window.dispatchEvent(new Event("desktop-prefs-changed"));
  });
const get = (selector: string) => host.querySelector<HTMLElement>(selector) as HTMLElement;
async function key(notation: string, target: EventTarget = window) {
  const base = notation.replace(/[⌃⌥⇧⌘]/g, "");
  const names: Record<string, string> = {
    Space: " ",
    Delete: "Backspace",
    ForwardDelete: "Delete",
    Left: "ArrowLeft",
    Right: "ArrowRight",
    Up: "ArrowUp",
    Down: "ArrowDown",
  };
  await act(async () => {
    target.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: names[base] ?? base,
        ctrlKey: notation.includes("⌃"),
        altKey: notation.includes("⌥"),
        shiftKey: notation.includes("⇧"),
        metaKey: notation.includes("⌘"),
        bubbles: true,
        cancelable: true,
      }),
    );
  });
}
const action = (name: Action) => key(reply().keymap[name] as string);
const writes = () => call.mock.calls.filter(([verb]) => !verb.startsWith("prefs_"));
const lastOps = () => writes().at(-1)?.[1].ops;
async function pointer(target: HTMLElement, type: string, x: number, y = 40, options: MouseEventInit = {}) {
  await act(async () => {
    const event = new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0, ...options });
    Object.defineProperty(event, "pointerId", { value: 1 });
    target.dispatchEvent(event);
  });
}
async function click(target: HTMLElement) {
  await act(async () => target.click());
}

beforeEach(async () => {
  state = { ...initialState(), project: "/test.zcut.json", playhead: { at: "2s" } };
  preset = "fcp";
  overrides = {};
  ui = { snap: false, magnetic: true, skimming: false, track_height: "m" };
  readOnly = false;
  aiChanges = undefined;
  sourceViewer = false;
  showViewer = false;
  dragging.current = false;
  call.mockClear();
  settings.mockClear();
  project = {
    id: "timeline",
    name: "快捷键",
    revision: { id: "revision", seq: 0 },
    edit_rate: "25",
    start_timecode: "00:00:00:00",
    drop_frame: false,
    duration: { t: "8s" },
    tracks: ["video", "audio", "audio"].map((kind, track) => ({
      id: `t${track}`,
      name: `轨道 ${track}`,
      kind: kind as "video" | "audio",
      enabled: true,
      clips: [0, 4].map((start, index) => ({
        id: `c${track}${index}`,
        media_id: "media",
        occurrence_id: `occ${index}`,
        label: null,
        enabled: true,
        speed: "1",
        timeline_in: { t: `${start}s` },
        timeline_out: { t: `${start + 4}s` },
        source_in: { t: "2s" },
        source_out: { t: "6s" },
      })),
    })),
    cues: [],
    media: [{ id: "media", kind: "video", name: "素材", duration: "20s" }],
    styles: [],
    markers: [{ id: "review", at: { t: "6s" }, text: "待审", kind: "review" }],
  };
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => recordingCanvas().context);
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
  vi.spyOn(window, "requestAnimationFrame").mockReturnValue(1);
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => render());
  Object.defineProperty(get(".zc-timeline"), "clientWidth", { value: 800 });
  call.mockClear();
});
afterEach(async () => {
  await act(() => root.unmount());
  host.remove();
  previewConfig = undefined;
  inspectorTarget?.remove();
  inspectorTarget = null;
  vi.restoreAllMocks();
});

it("dispatches palette edits through the same timeline handler, including unbound actions", async () => {
  expect(commandBlockReason("ripple_delete")).toBe("请选择片段或标记入出点");
  expect(runEditorCommand("ripple_delete")).toBe(false);
  expect(writes()).toEqual([]);

  state = { ...state, selected: ["c00"] };
  await act(() => render());
  await action("ripple_delete");
  const keyboardRequest = writes()[0]?.[1];
  expect(keyboardRequest?.ops).toEqual([{ op: "remove", clip_ids: ["c00"], ripple: true }]);

  overrides = { ripple_delete: null };
  await refresh();
  expect(commandBlockReason("ripple_delete")).toBeNull();
  await act(async () => {
    expect(runEditorCommand("ripple_delete")).toBe(true);
  });
  expect(writes()).toHaveLength(2);
  expect(writes()[1]).toEqual(["edit", { ...keyboardRequest, idempotency_key: expect.any(String) }]);
});

it("opens the clip menu for the timeline selection and sends a revisioned edit", async () => {
  state = { ...state, selected: ["c00", "c10"] };
  await act(async () => render());
  await act(async () => {
    get('[data-selection-id="c00"]').dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        button: 2,
        clientX: 50,
        clientY: 50,
      }),
    );
  });
  const menu = document.querySelector('[aria-label="片段操作"]');
  expect(menu).not.toBeNull();
  expect(state.selected).toEqual(["c00", "c10"]);
  await click(menu?.querySelector("button") as HTMLElement);
  expect(writes()).toEqual([
    [
      "edit",
      expect.objectContaining({
        project: state.project,
        base_revision: project.revision.id,
        timeline_id: project.id,
        idempotency_key: expect.any(String),
        author: DESKTOP_AUTHOR,
        label: "删除留空隙",
        ops: [{ op: "remove", clip_ids: ["c00", "c10"] }],
      }),
    ],
  ]);
  await key("⇧F10", get('[data-selection-id="c01"]'));
  expect(state.selected).toEqual(["c01"]);
  expect(document.querySelector('[aria-label="片段操作"]')).not.toBeNull();
});

it("keeps the selected audio gain local while dragging and writes on release", async () => {
  showViewer = true;
  state = { ...state, selected: ["c10"] };
  inspectorTarget = document.createElement("div");
  document.body.append(inspectorTarget);
  await act(async () => render());
  const video = host.querySelector<HTMLVideoElement>('video[aria-label="时间线预览"]') as HTMLVideoElement;
  Object.defineProperty(video, "readyState", { value: 1 });
  const slider = inspectorTarget.querySelector<HTMLInputElement>('input[type="range"]') as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(slider, "-6");
    slider.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(video.muted).toBe(true);
  expect(writes()).toEqual([]);
  await pointer(slider, "pointerup", 0);
  expect(lastOps()).toEqual([{ op: "set_clip", clip_id: "c10", gain_db: -6 }]);
  expect(writes()).toHaveLength(1);
});

describe.each(["fcp", "premiere"] as const)("%s merged actions", (value) => {
  beforeEach(async () => {
    preset = value;
    await refresh();
    call.mockClear();
  });
  it.each([
    "split_at_playhead",
    "split_all_at_playhead",
    "trim_start_to_playhead",
    "trim_end_to_playhead",
    "ripple_delete",
    "lift_delete",
    "nudge_edit_back",
    "nudge_edit_fwd",
    "extend_edit",
    "add_marker",
    "undo",
    "redo",
  ] as const)("emits %s with a human author and Chinese label", async (name) => {
    state = { ...state, selected: ["c00"] };
    if (name === "extend_edit") state = { ...state, selected: [], edit_point: { track_id: "t0", at: "4s" } };
    await act(async () => render());
    await action(name);
    const request = writes()[0];
    expect(request?.[1]).toMatchObject({
      author: DESKTOP_AUTHOR,
      base_revision: "revision",
      project: "/test.zcut.json",
      label: expect.stringMatching(/[\u4e00-\u9fff]/),
    });
    const expected: Partial<Record<Action, unknown>> = {
      split_at_playhead: [{ op: "split", clip_id: "c00", at: "2s" }],
      split_all_at_playhead: [0, 1, 2].map((track) => ({
        op: "split",
        clip_id: `c${track}0`,
        at: "2s",
        linked: false,
      })),
      trim_start_to_playhead: [{ op: "trim", clip_id: "c00", edge: "in", to: "2s", ripple: true }],
      trim_end_to_playhead: [{ op: "trim", clip_id: "c00", edge: "out", to: "2s", ripple: true }],
      ripple_delete: [{ op: "remove", clip_ids: ["c00"], ripple: true }],
      lift_delete: [{ op: "remove", clip_ids: ["c00"] }],
      nudge_edit_back: [{ op: "move", clip_ids: ["c00"], to: "0s", mode: "insert" }],
      nudge_edit_fwd: [{ op: "move", clip_ids: ["c00"], to: "1/25s", mode: "insert" }],
      extend_edit: [{ op: "roll", clip_id: "c00", edge: "out", to: "2s" }],
      add_marker: [{ op: "add_marker", at: "2s", duration: "0s", kind: "review", text: "标记" }],
    };
    if (name === "undo" || name === "redo") expect(request?.[0]).toBe(name);
    else {
      expect(request?.[0]).toBe("edit");
      expect(lastOps()).toEqual(expected[name]);
    }
    expect(writes()).toHaveLength(1);
  });
  it("shows distinct snap and magnetic icons and tooltips from the merged keymap", async () => {
    const snap = get(`[title="吸附 ${reply().keymap.toggle_snap}"]`);
    const magnetic = get(`[title="磁性 ${reply().keymap.toggle_magnetic}"]`);
    expect(snap).not.toBeNull();
    expect(magnetic).not.toBeNull();
    expect(snap.querySelector("svg")?.innerHTML).not.toBe(magnetic.querySelector("svg")?.innerHTML);
    for (const button of [snap, magnetic]) {
      expect(button.querySelector("svg")?.getAttribute("viewBox")).toBe("0 0 24 24");
      expect(button.querySelector("svg")?.getAttribute("stroke-width")).toBe("1.5");
    }
    overrides = { toggle_snap: "D", toggle_magnetic: null };
    await refresh();
    expect(get('[title="吸附 D"]')).not.toBeNull();
    expect(get('[title="磁性"]')).not.toBeNull();
  });
  it("dispatches transport, navigation, range, tools, zoom, height and window actions", async () => {
    await action("play_pause");
    expect(state.playing).toBe(true);
    await action("shuttle_back");
    expect(state.playing).toBe(true);
    await action("shuttle_stop");
    expect(state.playing).toBe(false);
    await action("shuttle_fwd");
    expect(state.playing).toBe(true);
    await action("step_back");
    expect(state.playhead).toEqual({ at: "49/25s" });
    expect(state.playing).toBe(false);
    await action("step_fwd");
    expect(state.playhead).toEqual({ at: "2s" });
    await action("prev_edit");
    expect(state.playhead).toEqual({ at: "0s" });
    await action("next_edit");
    expect(state.playhead).toEqual({ at: "4s" });
    await action("next_review");
    expect(state.playhead).toEqual({ at: "6s" });
    await action("mark_in");
    expect(state.range).toEqual({ start: "6s", duration: "2s" });
    await action("step_fwd");
    await action("mark_out");
    expect(state.range).toEqual({ start: "6s", duration: "1/25s" });
    for (const [name, label] of [
      ["tool_select", "选择"],
      ["tool_blade", "切割"],
      ["tool_roll", "滚动编辑"],
    ] as const) {
      await action(name);
      expect(get(`[aria-label^="${label} "]`).getAttribute("aria-pressed")).toBe("true");
    }
    const zoom = () => (get('[aria-label="时间线缩放"]') as HTMLInputElement).value;
    await action("zoom_in");
    expect(zoom()).toBe("60");
    await action("zoom_out");
    expect(zoom()).toBe("48");
    await action("zoom_fit");
    expect(zoom()).toBe("90");
    await action("track_taller");
    expect(ui.track_height).toBe("l");
    expect(get(".zc-track-height-l")).not.toBeNull();
    await action("track_shorter");
    expect(ui.track_height).toBe("m");
    await action("toggle_snap");
    expect(ui.snap).toBe(true);
    await action("toggle_magnetic");
    await act(() => window.dispatchEvent(new KeyboardEvent("keyup", { key: "p" })));
    expect(ui.magnetic).toBe(false);
    await action("toggle_history");
    expect(state.history?.open).toBe(true);
    await action("toggle_history");
    expect(state.history?.open).toBe(false);
    await action("open_settings");
    expect(settings).toHaveBeenCalledOnce();
    expect(writes()).toHaveLength(0);
  });
});

it("refreshes an individual override and keeps other keys, including unbinding", async () => {
  overrides = { tool_blade: "D" };
  await refresh();
  await key("B");
  expect(get('[aria-label="切割 D"]').getAttribute("aria-pressed")).toBe("false");
  await key("D");
  expect(get('[aria-label="切割 D"]').getAttribute("aria-pressed")).toBe("true");
  await key("A");
  expect(get('[aria-label="选择 A"]').getAttribute("aria-pressed")).toBe("true");
  overrides = { tool_blade: null };
  await refresh();
  await key("D");
  expect(get('[aria-label="切割 "]').getAttribute("aria-pressed")).toBe("false");
  await key("⌘B");
  expect(lastOps()).toEqual([{ op: "split", clip_id: "c00", at: "2s" }]);
});

it.each([true, false])(
  "magnetic %s controls move and trim, while named deletes retain their meaning",
  async (magnetic) => {
    ui.magnetic = magnetic;
    await refresh();
    state.selected = ["c00"];
    await act(async () => render());
    await action("trim_start_to_playhead");
    expect(lastOps()).toEqual([{ op: "trim", clip_id: "c00", edge: "in", to: "2s", ripple: magnetic }]);
    await action("trim_end_to_playhead");
    expect(lastOps()).toEqual([{ op: "trim", clip_id: "c00", edge: "out", to: "2s", ripple: magnetic }]);
    await action("nudge_edit_fwd");
    expect(lastOps()).toEqual([{ op: "move", clip_ids: ["c00"], to: "1/25s", mode: magnetic ? "insert" : "place" }]);
    await action("ripple_delete");
    expect(lastOps()).toEqual([{ op: "remove", clip_ids: ["c00"], ripple: true }]);
    await action("lift_delete");
    expect(lastOps()).toEqual([{ op: "remove", clip_ids: ["c00"] }]);
    const handle = get('[data-selection-id="c00"] [data-trim-edge="out"]');
    await pointer(handle, "pointerdown", 192);
    await pointer(handle, "pointermove", 144);
    await pointer(handle, "pointerup", 144);
    expect(lastOps()).toEqual([{ op: "trim", clip_id: "c00", edge: "out", to: "3s", ripple: magnetic, linked: true }]);
    const clip = get('[data-selection-id="c00"]');
    await pointer(clip, "pointerdown", 20);
    await pointer(clip, "pointermove", 68);
    await pointer(clip, "pointerup", 68);
    expect(lastOps()).toMatchObject([{ op: "move", mode: magnetic ? "insert" : "overwrite" }]);
  },
);

it("selects a seam, exposes it in ui_state, rolls one exact NTSC frame and preserves the pair's duration", async () => {
  project.edit_rate = "30000/1001";
  project.duration.t = frameTime(240n, project.edit_rate);
  for (const track of project.tracks)
    for (const [index, clip] of track.clips.entries()) {
      clip.timeline_in.t = frameTime(BigInt(index * 120), project.edit_rate);
      clip.timeline_out.t = frameTime(BigInt((index + 1) * 120), project.edit_rate);
    }
  project = { ...project };
  await act(async () => render());
  const seam = get(".zc-seam");
  await click(seam);
  expect(applyUi(state, "ui_state", {}).edit_point).toEqual({ track_id: "t0", at: frameTime(120n, project.edit_rate) });
  expect(get(".zc-seam.is-selected")).not.toBeNull();
  expect(get(".zc-cut-tick")).toBeNull();
  await key(",");
  const to = frameTime(119n, project.edit_rate);
  expect(lastOps()).toEqual([{ op: "roll", clip_id: "c00", edge: "out", to }]);
  const left = sub(parseRational(to, true), parseRational("0s", true));
  const right = sub(parseRational(project.duration.t, true), parseRational(to, true));
  expect(compare(add(left, right), parseRational(project.duration.t, true))).toBe(0);
  expect(state.edit_point?.at).toBe(to);
  expect(applyUi(state, "ui_select", { ids: [] }).edit_point).toBeNull();
});

it("drags a seam with roll, and cancels without writing", async () => {
  await action("tool_roll");
  const seam = get(".zc-seam");
  await pointer(seam, "pointerdown", 192);
  await pointer(seam, "pointermove", 240);
  await pointer(seam, "pointerup", 240);
  expect(lastOps()).toEqual([{ op: "roll", clip_id: "c00", edge: "out", to: "5s" }]);
  call.mockClear();
  await pointer(seam, "pointerdown", 192);
  await pointer(seam, "pointermove", 240);
  await pointer(seam, "pointercancel", 240);
  expect(writes()).toHaveLength(0);
  expect(seam.style.left).toBe("192px");
});

it("splits all crossing clips once at one NTSC instant, excluding clips touching the playhead", async () => {
  project.edit_rate = "30000/1001";
  state.playhead = { at: "1001/500s" };
  const edge = project.tracks[2]?.clips[1];
  if (edge) edge.timeline_in = { t: "1001/500s" };
  await act(async () => render());
  await action("split_all_at_playhead");
  expect(writes()).toHaveLength(1);
  expect(lastOps()).toEqual(
    [0, 1, 2].map((track) => ({ op: "split", clip_id: `c${track}0`, at: "1001/500s", linked: false })),
  );
});

it("does not split a linked group twice or split an unselected track", async () => {
  state.selected = ["c00", "c10"];
  await act(async () => render());
  await action("split_at_playhead");
  expect(lastOps()).toEqual([{ op: "split", clip_id: "c00", at: "2s" }]);
  state.selected = ["c01"];
  await act(async () => render());
  call.mockClear();
  await action("split_at_playhead");
  expect(writes()).toHaveLength(0);
});

it("persists toolbar toggles and reports a failed preference write", async () => {
  await click(get('[aria-label="磁性"]'));
  expect(call).toHaveBeenCalledWith("prefs_set", { patch: { ui: { magnetic: false } } });
  await click(get('[aria-label="吸附"]'));
  expect(call).toHaveBeenCalledWith("prefs_set", { patch: { ui: { snap: true } } });
  call.mockRejectedValueOnce(new Error("保存失败"));
  await click(get('[aria-label="磁性"]'));
  expect(get('[role="alert"]').textContent).toBe("保存失败");
  expect(ui.magnetic).toBe(false);
  expect(get(".zc-cache-bar")).toBeNull();
  expect(call.mock.calls.some(([verb]) => verb.startsWith("preview_cache"))).toBe(false);
});

it("ignores edit keys while typing, dragging or viewing history", async () => {
  const input = document.createElement("input");
  host.append(input);
  await key("⌘B", input);
  expect(writes()).toHaveLength(0);
  dragging.current = true;
  await key("⌘B");
  expect(writes()).toHaveLength(0);
  dragging.current = false;
  readOnly = true;
  await act(async () => render());
  await key("⌘B");
  expect(writes()).toHaveLength(0);
});

it.each(["fcp", "premiere"] as const)(
  "%s rolls the selected edit point in both directions with magnetic off",
  async (value) => {
    preset = value;
    ui.magnetic = false;
    await refresh();
    await click(get(".zc-seam"));
    await action("nudge_edit_back");
    expect(lastOps()).toEqual([{ op: "roll", clip_id: "c00", edge: "out", to: "99/25s" }]);
    state.edit_point = { track_id: "t0", at: "4s" };
    await act(async () => render());
    await action("nudge_edit_fwd");
    expect(lastOps()).toEqual([{ op: "roll", clip_id: "c00", edge: "out", to: "101/25s" }]);
  },
);

it("trims selected linked edges only once and nudges from the earliest linked edge", async () => {
  state.selected = ["c00", "c10"];
  await act(async () => render());
  await action("trim_start_to_playhead");
  expect(lastOps()).toEqual([{ op: "trim", clip_id: "c00", edge: "in", to: "2s", ripple: true }]);
  const linked = project.tracks[1]?.clips[0];
  if (linked) linked.timeline_in.t = "1/25s";
  state.selected = ["c10"];
  await act(async () => render());
  await action("nudge_edit_fwd");
  expect(lastOps()).toEqual([{ op: "move", clip_ids: ["c10"], to: "1/25s", mode: "insert" }]);
});

it("refreshes the merged keymap after a successful prefs_set reply through the connection", async () => {
  let receive: ((event: { data: string }) => void) | null = null;
  class Socket {
    readyState = 1;
    onopen: (() => void) | null = null;
    set onmessage(handler: (event: { data: string }) => void) {
      receive = handler;
    }
    send(raw: string) {
      const request = JSON.parse(raw);
      if (request.verb === "prefs_set")
        queueMicrotask(() =>
          receive?.({ data: JSON.stringify({ id: request.id, envelope: { ok: true, result: reply(), error: null } }) }),
        );
    }
    close() {}
  }
  vi.stubGlobal("WebSocket", Socket);
  const connection = connectHost(
    { port: 1, token: "test" },
    { ui: () => state, project: () => {}, icon: () => {}, error: () => {} },
  );
  try {
    await act(async () => receive?.({ data: JSON.stringify({ type: "bootstrap", project: null }) }));
    preset = "premiere";
    await act(async () => {
      await connection.call("prefs_set", { patch: { keymap: { preset } } });
    });
    await key("C");
    expect(get('[aria-label="切割 C"]').getAttribute("aria-pressed")).toBe("true");
    await key("⌘K");
    expect(lastOps()).toEqual([{ op: "split", clip_id: "c00", at: "2s" }]);
  } finally {
    connection();
    vi.unstubAllGlobals();
  }
});

it("reports selected edit points and the viewed history revision to the host", async () => {
  state.edit_point = { track_id: "t0", at: "4s" };
  state.history = { open: true, revision: "rev_previous", label: "上一步" };
  let receive: ((event: { data: string }) => void) | null = null;
  const sent: { type: string; result: unknown }[] = [];
  class Socket {
    readyState = 1;
    set onmessage(handler: (event: { data: string }) => void) {
      receive = handler;
    }
    send(raw: string) {
      sent.push(JSON.parse(raw));
    }
    close() {}
  }
  vi.stubGlobal("WebSocket", Socket);
  const connection = connectHost(
    { port: 1, token: "test" },
    {
      ui: (verb, request) => {
        state = applyUi(state, verb, request);
        return state;
      },
      project: () => {},
      icon: () => {},
      error: () => {},
    },
  );
  try {
    await act(async () =>
      receive?.({ data: JSON.stringify({ type: "ui_request", id: "read", verb: "ui_state", request: {} }) }),
    );
    expect(state.edit_point).toEqual({ track_id: "t0", at: "4s" });
    expect(sent[0]?.result).toMatchObject({ selected: [] });
    expect(sent[0]?.result).toMatchObject({
      edit_point: state.edit_point,
      chapters: { view: "outline" },
      history: { open: true, viewing: "rev_previous" },
    });
    await act(async () =>
      receive?.({ data: JSON.stringify({ type: "ui_request", id: "clear", verb: "ui_select", request: { ids: [] } }) }),
    );
    expect(state.edit_point).toBeNull();
    expect(sent[1]?.result).toHaveProperty("edit_point", null);
  } finally {
    connection();
    vi.unstubAllGlobals();
  }
});

describe("blade tool", () => {
  const clip = () => get('[data-selection-id="c00"]');
  const release = (key: string) =>
    act(async () => {
      window.dispatchEvent(new KeyboardEvent("keyup", { key }));
    });
  const pressed = (name: string) => get(`[aria-label^="${name} "]`).getAttribute("aria-pressed");
  const lines = () => host.querySelectorAll(".zc-blade-line");

  it("cuts the clicked frame after viewport, label and scroll offsets without changing UI state", async () => {
    state.selected = ["c11"];
    await act(async () => render());
    const before = structuredClone(state);
    const scroller = get(".zc-timeline");
    scroller.scrollLeft = 120;
    vi.spyOn(scroller, "getBoundingClientRect").mockReturnValue({ left: 30 } as DOMRect);
    vi.spyOn(get(".zc-ruler"), "getBoundingClientRect").mockReturnValue({ left: -10 } as DOMRect);
    await key("B");
    expect(writes()).toHaveLength(0);
    await pointer(clip(), "pointermove", 39);
    expect(lines()[0]?.getAttribute("style")).toBe("left: 48px;");
    expect(lines()[0]?.textContent).toBe("00:00:01:00");
    await pointer(clip(), "pointerdown", 39);
    expect(lines()).toHaveLength(0);
    await pointer(clip(), "pointerup", 39);
    await pointer(clip(), "click", 39);
    expect(lastOps()).toEqual([{ op: "split", clip_id: "c00", at: "1s" }]);
    expect(state).toEqual(before);
    expect(pressed("切割")).toBe("true");
  });

  it("Shift cuts each crossing video/audio clip once, including disabled tracks, in one edit", async () => {
    const audio = project.tracks[2];
    if (audio) audio.enabled = false;
    project.tracks.push({ id: "subtitle", name: "字幕", kind: "subtitle", enabled: true, clips: [] });
    await act(async () => render());
    await key("B");
    await pointer(clip(), "click", 49, 40, { shiftKey: true, altKey: true });
    expect(writes()).toHaveLength(1);
    expect(lastOps()).toEqual(
      ["c00", "c10", "c20"].map((id) => ({
        op: "split",
        clip_id: id,
        at: "1s",
        linked: false,
      })),
    );
  });

  it("Option cuts only the clicked clip with linked false", async () => {
    await key("B");
    await pointer(clip(), "click", 49, 40, { altKey: true });
    expect(lastOps()).toEqual([{ op: "split", clip_id: "c00", at: "1s", linked: false }]);
  });

  it("does not cut at the in/out point or change selection on blank space or seams", async () => {
    await key("B");
    const before = structuredClone(state);
    await pointer(clip(), "click", 0);
    await pointer(clip(), "click", 192);
    await pointer(get(".zc-track-lane"), "pointerdown", 300);
    await pointer(get(".zc-track-lane"), "click", 300);
    await pointer(get(".zc-seam"), "pointerdown", 192);
    await pointer(get(".zc-seam"), "click", 192);
    expect(writes()).toHaveLength(0);
    expect(state).toEqual(before);
  });

  it("updates linked, Option and Shift landing lines immediately on key changes", async () => {
    const unrelated = project.tracks[2]?.clips[0];
    if (unrelated) unrelated.occurrence_id = "other";
    await act(async () => render());
    await key("B");
    await pointer(clip(), "pointermove", 49);
    expect(lines()).toHaveLength(2);
    await key("⌥Alt");
    expect(lines()).toHaveLength(1);
    await key("⇧Shift");
    expect(lines()).toHaveLength(3);
    await release("Shift");
    expect(lines()).toHaveLength(2);
    await pointer(get(".zc-track-lane"), "pointermove", 300);
    expect(lines()).toHaveLength(0);
    await pointer(clip(), "pointermove", 49);
    await pointer(clip(), "pointerout", 49, 40, { relatedTarget: document.body });
    expect(lines()).toHaveLength(0);
    await pointer(clip(), "pointermove", 49);
    await click(get('[aria-label="选择 A"]'));
    expect(lines()).toHaveLength(0);
  });

  it.each([false, true])("draws landing lines on the linked lanes when Option is %s", async (altKey) => {
    const unrelated = project.tracks[2]?.clips[0];
    if (unrelated) unrelated.occurrence_id = "other";
    await act(async () => render());
    await key("B");
    await pointer(clip(), "pointermove", 49, 40, { altKey });
    expect(Array.from(lines(), (line) => line.closest<HTMLElement>(".zc-track-lane")?.dataset.trackId)).toEqual(
      altKey ? ["t0"] : ["t0", "t1"],
    );
    for (const line of lines()) expect((line as HTMLElement).style.left).toBe("48px");
    expect(writes()).toHaveLength(0);
  });

  it.each([
    ["playhead", "2s", 93],
    ["edit", "4s", 189],
    ["marker", "6s", 285],
  ])("uses a solid landing line and the same snapped %s time when clicked", async (_kind, at, x) => {
    ui.snap = true;
    await refresh();
    await key("B");
    const target = get(`[data-selection-id="${at === "6s" ? "c01" : "c00"}"]`);
    await pointer(target, "pointermove", Number(x));
    expect(lines()[0]?.classList.contains("is-snapped")).toBe(true);
    await pointer(target, "click", Number(x));
    if (at === "4s") expect(writes()).toHaveLength(0);
    else expect(lastOps()).toEqual([{ op: "split", clip_id: at === "6s" ? "c01" : "c00", at }]);
  });

  it("hides the landing line while dragging", async () => {
    await key("B");
    await pointer(clip(), "pointermove", 49);
    expect(lines().length).toBeGreaterThan(0);
    dragging.current = true;
    await pointer(clip(), "pointermove", 50);
    expect(lines()).toHaveLength(0);
  });

  it("suppresses the release click after dragging with the blade tool", async () => {
    await key("B");
    await pointer(clip(), "pointerdown", 49);
    await pointer(clip(), "pointermove", 70);
    expect(lines()).toHaveLength(0);
    await pointer(clip(), "pointerup", 70);
    await pointer(clip(), "click", 70, 40, { detail: 1 });
    expect(writes()).toHaveLength(0);
    expect(state.selected).toEqual([]);
  });

  it.each([
    ["B", "切割"],
    ["T", "滚动编辑"],
    ["A", "选择"],
  ])("%s is temporary after 300ms and short taps retain the new tool", async (toolKey, label) => {
    if (toolKey === "A") await click(get('[aria-label="切割 B"]'));
    const original = toolKey === "A" ? "切割" : "选择";
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    await key(toolKey);
    expect(pressed(label)).toBe("true");
    now = 300;
    await release(toolKey);
    expect(pressed(original)).toBe("true");
    await key(toolKey);
    now = 599;
    await release(toolKey);
    expect(pressed(label)).toBe("true");
    expect(writes()).toHaveLength(0);
  });

  it("restores the previous tool after a pointerdown even with a short hold", async () => {
    await key("B");
    await pointer(clip(), "pointerdown", 49);
    await pointer(clip(), "pointerup", 49);
    await pointer(clip(), "click", 49);
    await release("B");
    expect(pressed("选择")).toBe("true");
    expect(writes()).toHaveLength(1);
  });

  it("ignores repeat keydown without resetting the hold timer", async () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    await key("B");
    now = 250;
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "B", repeat: true, cancelable: true }));
    });
    now = 300;
    await release("B");
    expect(pressed("选择")).toBe("true");
    expect(writes()).toHaveLength(0);
  });

  it("restores a held tool on blur and ignores its later keyup", async () => {
    await key("B");
    await act(async () => window.dispatchEvent(new Event("blur")));
    expect(pressed("选择")).toBe("true");
    await release("B");
    expect(pressed("选择")).toBe("true");
  });
});

describe("skimmer", () => {
  const clip = () => get('[data-selection-id="c00"]');
  const line = () => get(".zc-skimmer");
  const leave = () => pointer(get(".zc-timeline"), "pointerout", 49, 40, { relatedTarget: document.body });

  it.each(["fcp", "premiere"] as const)("toggles %s skimming with prefs_set and the toolbar", async (value) => {
    preset = value;
    await refresh();
    await action("toggle_skimming");
    expect(call).toHaveBeenCalledWith("prefs_set", { patch: { ui: { skimming: true } } });
    const button = get(`[title="浏览条 ${reply().keymap.toggle_skimming}"]`);
    expect(button.getAttribute("aria-pressed")).toBe("true");
    await click(button);
    expect(call).toHaveBeenLastCalledWith("prefs_set", { patch: { ui: { skimming: false } } });
    expect(writes()).toHaveLength(0);
  });

  it("floors the hover frame on clips, blank lanes and ruler, with viewport and scroll offsets", async () => {
    await pointer(clip(), "pointermove", 49);
    expect(line()).toBeNull();
    await action("toggle_skimming");
    expect(line().style.left).toBe("calc(var(--track-label-w) + 48px)");
    const before = structuredClone(state);
    const scroller = get(".zc-timeline");
    scroller.scrollLeft = 120;
    vi.spyOn(scroller, "getBoundingClientRect").mockReturnValue({ left: 30 } as DOMRect);
    vi.spyOn(get(".zc-ruler"), "getBoundingClientRect").mockReturnValue({ left: -10 } as DOMRect);
    await pointer(get(".zc-track-lane"), "pointermove", 38.9);
    expect(line().style.left).toBe("calc(var(--track-label-w) + 48px)");
    await pointer(get(".zc-ruler"), "pointermove", 39.9);
    expect(line().style.left).toBe("calc(var(--track-label-w) + 48px)");
    await leave();
    expect(line()).toBeNull();
    expect(state).toEqual(before);
    expect(writes()).toHaveLength(0);
  });

  it("keeps NTSC hover and marker times on the exact frame grid", async () => {
    project.edit_rate = "30000/1001";
    await act(async () => render());
    await action("toggle_skimming");
    await pointer(clip(), "pointermove", 1.6015);
    expect(line().style.left).toBe("calc(var(--track-label-w) + 0px)");
    await pointer(clip(), "pointermove", 1.6016);
    expect(line().style.left).toBe("calc(var(--track-label-w) + 1.6016px)");
    await action("add_marker");
    expect(lastOps()).toMatchObject([{ at: "1001/30000s" }]);
  });

  it("shows the timeline frame when hovering from a paused source preview without moving the playhead", async () => {
    state = { ...state, preview: "media" };
    await act(async () => render());
    await action("toggle_skimming");
    await pointer(clip(), "pointermove", 49);
    expect(state.preview).toBe("timeline");
    expect(state.playhead).toEqual({ at: "2s" });
  });

  it("snaps to the playhead, edits and markers and clamps to the timeline", async () => {
    ui.snap = true;
    await refresh();
    await action("toggle_skimming");
    for (const [x, pixels] of [
      [98, 96],
      [194, 192],
      [290, 288],
      [999, 384],
    ]) {
      await pointer(get(".zc-ruler"), "pointermove", x as number);
      expect(line().style.left).toBe(`calc(var(--track-label-w) + ${pixels}px)`);
    }
  });

  it("seeks paused video silently, restores the playhead frame on leave, and hides while playing or dragging", async () => {
    showViewer = true;
    vi.spyOn(HTMLMediaElement.prototype, "readyState", "get").mockReturnValue(1);
    await act(async () => render());
    const video = get('video[aria-label="时间线预览"]') as HTMLVideoElement;
    expect(video.currentTime).toBe(4);
    await action("toggle_skimming");
    const before = structuredClone(state);
    await pointer(clip(), "pointermove", 49);
    expect(video.currentTime).toBe(3);
    expect(video.muted).toBe(true);
    expect(state).toEqual(before);
    expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
    await leave();
    expect(video.currentTime).toBe(4);
    await pointer(clip(), "pointermove", 49);
    await action("play_pause");
    expect(line()).toBeNull();
    expect(video.currentTime).toBe(4);
    await action("shuttle_stop");
    await pointer(clip(), "pointerdown", 49);
    expect(line()).toBeNull();
    await pointer(clip(), "pointermove", 60);
    expect(line()).toBeNull();
    await pointer(clip(), "pointercancel", 60);
  });

  it("uses only blade landing lines while the preview follows the same frame", async () => {
    showViewer = true;
    await act(async () => render());
    await action("toggle_skimming");
    await key("B");
    await pointer(clip(), "pointermove", 49);
    expect(line()).toBeNull();
    expect(get(".zc-blade-line").style.left).toBe("48px");
    expect(get('[aria-label="播放时码"]').textContent).toBe("00:00:01:00");
    expect(state.playhead).toEqual({ at: "2s" });
  });

  it.each([
    ["split_at_playhead", "at"],
    ["trim_start_to_playhead", "to"],
    ["trim_end_to_playhead", "to"],
    ["extend_edit", "to"],
    ["add_marker", "at"],
  ] as const)("uses the skimmer for %s and falls back after leaving or disabling", async (name, field) => {
    state = { ...state, selected: ["c00"], edit_point: { track_id: "t0", at: "4s" } };
    await act(async () => render());
    await action("toggle_skimming");
    await pointer(clip(), "pointermove", 49);
    await action(name);
    expect(lastOps()).toMatchObject([{ [field]: "1s" }]);
    expect(state.playhead).toEqual({ at: "2s" });
    await leave();
    state = { ...state, edit_point: { track_id: "t0", at: "4s" } };
    await act(async () => render());
    await action(name);
    expect(lastOps()).toMatchObject([{ [field]: "2s" }]);
    await pointer(clip(), "pointermove", 49);
    await action("toggle_skimming");
    state = { ...state, edit_point: { track_id: "t0", at: "4s" } };
    await act(async () => render());
    await action(name);
    expect(lastOps()).toMatchObject([{ [field]: "2s" }]);
  });

  it("keeps all-track split at the playhead and does not skim during playback", async () => {
    await action("toggle_skimming");
    await pointer(clip(), "pointermove", 49);
    await action("split_all_at_playhead");
    expect(lastOps()).toEqual(
      [0, 1, 2].map((track) => ({ op: "split", clip_id: `c${track}0`, at: "2s", linked: false })),
    );
    await action("play_pause");
    await action("add_marker");
    expect(lastOps()).toMatchObject([{ at: "2s" }]);
  });
});

describe.each(["fcp", "premiere"] as const)("%s timeline clicks", (value) => {
  beforeEach(async () => {
    preset = value;
    await refresh();
  });
  it.each([false, true])("selects a clip and moves only the fcp playhead (skimming %s)", async (enabled) => {
    ui.skimming = enabled;
    await refresh();
    const clip = get('[data-selection-id="c00"]');
    await pointer(clip, "pointermove", 49);
    await pointer(clip, "pointerdown", 49);
    await pointer(clip, "pointerup", 49);
    await pointer(clip, "click", 49, 40, { detail: 1 });
    expect(state.selected).toEqual(["c00"]);
    expect(state.playhead).toEqual({ at: value === "fcp" ? "1s" : "2s" });
    const lane = get(".zc-track-lane");
    await pointer(lane, "pointerdown", 145);
    await pointer(lane, "pointerup", 145);
    await pointer(lane, "click", 145, 40, { detail: 1 });
    expect(state.selected).toEqual([]);
    expect(state.playhead).toEqual({ at: value === "fcp" ? "3s" : "2s" });
  });
  it("uses the snapped skimmer frame for a clip click", async () => {
    ui.snap = true;
    ui.skimming = true;
    await refresh();
    const clip = get('[data-selection-id="c00"]');
    await pointer(clip, "pointermove", 98);
    expect(get(".zc-skimmer").style.left).toBe("calc(var(--track-label-w) + 96px)");
    await pointer(clip, "pointerdown", 98);
    await pointer(clip, "pointerup", 98);
    await pointer(clip, "click", 98, 40, { detail: 1 });
    expect(state.playhead).toEqual({ at: "2s" });
    expect(state.selected).toEqual(["c00"]);
  });
  it("keeps the playhead after dragging and when selecting an edit point", async () => {
    const clip = get('[data-selection-id="c00"]');
    await pointer(clip, "pointerdown", 49);
    await pointer(clip, "pointermove", 98);
    await pointer(clip, "pointerup", 98);
    await pointer(clip, "click", 98, 40, { detail: 1 });
    expect(state.playhead).toEqual({ at: "2s" });
    const seam = get(".zc-seam");
    await pointer(seam, "pointerdown", 192);
    await pointer(seam, "pointerup", 192);
    await pointer(seam, "click", 192, 40, { detail: 1 });
    expect(state.edit_point).toEqual({ track_id: "t0", at: "4s" });
    expect(state.playhead).toEqual({ at: "2s" });
  });
  it("preserves keyboard clip selection and suppresses the release click after a marquee drag", async () => {
    const clip = get('[data-selection-id="c00"]');
    await click(clip);
    expect(state.selected).toEqual(["c00"]);
    expect(state.playhead).toEqual({ at: "2s" });
    const lane = get(".zc-track-lane");
    await pointer(lane, "pointerdown", 100);
    await pointer(lane, "pointermove", 150);
    await pointer(lane, "pointerup", 150);
    await pointer(lane, "click", 150, 40, { detail: 1 });
    expect(state.playhead).toEqual({ at: "2s" });
  });
  it("moves the playhead on ruler clicks in both presets", async () => {
    const ruler = get(".zc-ruler");
    await pointer(ruler, "pointerdown", 48);
    await pointer(ruler, "pointerup", 48);
    expect(state.playhead).toEqual({ at: "1s" });
  });
});

it("sets timeline I/O, highlights the range and clears it", async () => {
  showViewer = true;
  await act(async () => render());
  await click(get('[aria-label="设入点 I"]'));
  expect(state.timelineMarks).toEqual({ in: "2s", out: null });
  expect(get(".zc-timeline-range").style.left).toBe("96px");
  state = { ...state, playhead: { at: "4s" } };
  await act(async () => render());
  await action("mark_out");
  expect(state.timelineMarks).toEqual({ in: "2s", out: "4s" });
  expect(state.range).toEqual({ start: "2s", duration: "2s" });
  expect(get(".zc-timeline-range").style.width).toBe("96px");
  await action("clear_in_out");
  expect(state.timelineMarks).toBeNull();
  expect(state.range).toBeNull();
  expect(get(".zc-timeline-range")).toBeNull();
});

it.each(["insert_edit", "overwrite_edit", "append_edit", "connect_edit"] as const)(
  "submits a single edit for %s",
  async (name) => {
    project = {
      ...project,
      media: [
        {
          id: "media",
          kind: "video",
          duration: "20s",
          video: { rate: "25", width: 1920, height: 1080 },
          audio: { sample_rate: "48000", channels: 2 },
        },
      ],
    };
    state = {
      ...state,
      media: { id: "media", at: "1s", in: "1s", out: "3s" },
      timelineMarks: { in: "1s", out: "4s" },
    };
    await act(async () => render());
    await action(name);
    const connect = name === "connect_edit";
    expect(writes()).toHaveLength(1);
    expect(writes()[0]).toEqual([
      "edit",
      expect.objectContaining({
        author: DESKTOP_AUTHOR,
        base_revision: "revision",
        timeline_id: project.id,
      }),
    ]);
    const ops = lastOps() as Record<string, unknown>[];
    expect(ops).toHaveLength(connect ? 3 : 1);
    if (connect) {
      expect(ops.slice(0, 2)).toEqual([
        { op: "add_track", kind: "video", index: 1, id: expect.any(String) },
        { op: "add_track", kind: "audio", index: 3, id: expect.any(String) },
      ]);
    }
    expect(ops.at(-1)).toEqual({
      op: "place",
      media_id: "media",
      source_start: "1s",
      duration: "2s",
      at: connect ? "2s" : name === "append_edit" ? "end" : "1s",
      mode: connect || name === "overwrite_edit" ? "overwrite" : "insert",
      video_track: connect ? ops[0]?.id : "t0",
      audio_track: connect ? ops[1]?.id : "t1",
    });
  },
);

it.each(["ripple_delete", "lift_delete"] as const)(
  "deletes a marked interval with %s on unlocked media tracks",
  async (name) => {
    project = { ...project, tracks: project.tracks.map((track, i) => (i === 1 ? { ...track, locked: true } : track)) };
    state = { ...state, timelineMarks: { in: "1s", out: "3s" } };
    await act(async () => render());
    await action(name);
    expect(writes()).toHaveLength(1);
    expect(lastOps()).toEqual([
      {
        op: "remove_span",
        range: { start: "1s", duration: "2s" },
        tracks: ["t0", "t2"],
        ripple: name === "ripple_delete",
      },
    ]);
  },
);

it.each(["video", "audio"] as const)(
  "uses the playhead for an out-only range and places only %s",
  (placement: Placement) => {
    const media = {
      id: "media",
      kind: "video",
      duration: "3s",
      video: { rate: "25", width: 1920, height: 1080 },
      audio: { sample_rate: "48000", channels: 2 },
    };
    const range = { ...state, timelineMarks: { in: null, out: "4s" } };
    const plan = threePointEdit("overwrite_edit", project, media, range, "2s", placement);
    expect(plan).toMatchObject({
      op: { at: "2s", duration: "3s", ...(placement === "video" ? { video_track: "t0" } : { audio_track: "t1" }) },
    });
    expect("op" in plan && plan.op).not.toHaveProperty(placement === "video" ? "audio_track" : "video_track");
  },
);

describe("track heads", () => {
  const head = (id: string) =>
    get(`[data-track-id="${id}"]`).parentElement?.querySelector(".zc-track-head") as HTMLElement;
  const control = (id: string, label: string) =>
    head(id).querySelector<HTMLElement>(`[aria-label="${label}"]`) as HTMLElement;
  const menuItem = (label: string) =>
    [...document.querySelectorAll<HTMLButtonElement>(".zc-track-menu button")].find((item) =>
      item.textContent?.startsWith(label),
    ) as HTMLButtonElement;
  const menu = (id: string) => pointer(head(id), "contextmenu", 10, 20, { button: 2 });

  it("writes lock, visibility, mute and rename edits", async () => {
    await click(control("t0", "锁定轨道"));
    expect(lastOps()).toEqual([{ op: "set_track", track_id: "t0", locked: true }]);
    await click(control("t0", "隐藏画面"));
    expect(lastOps()).toEqual([{ op: "set_track", track_id: "t0", enabled: false }]);
    await click(control("t1", "静音"));
    expect(lastOps()).toEqual([{ op: "set_track", track_id: "t1", enabled: false }]);

    await pointer(control("t0", "轨道 0"), "dblclick", 5);
    const input = get('input[aria-label="轨道名"]') as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, "画面 A");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await key("Enter", input);
    expect(lastOps()).toEqual([{ op: "rename_track", track_id: "t0", name: "画面 A" }]);

    project.tracks = project.tracks.map((track) => ({ ...track, enabled: false, locked: true }));
    await act(async () => render());
    await click(control("t0", "解锁轨道"));
    expect(lastOps()).toEqual([{ op: "set_track", track_id: "t0", locked: false }]);
    await click(control("t0", "显示画面"));
    expect(lastOps()).toEqual([{ op: "set_track", track_id: "t0", enabled: true }]);
    await click(control("t1", "取消静音"));
    expect(lastOps()).toEqual([{ op: "set_track", track_id: "t1", enabled: true }]);
  });

  it("inserts tracks at the requested index and only deletes eligible empty tracks", async () => {
    await menu("t1");
    await click(menuItem("在上方新建视频轨"));
    expect(lastOps()).toEqual([{ op: "add_track", id: expect.any(String), kind: "video", index: 1 }]);
    await menu("t1");
    await click(menuItem("在下方新建声音轨"));
    expect(lastOps()).toEqual([{ op: "add_track", id: expect.any(String), kind: "audio", index: 2 }]);
    await menu("t1");
    expect(menuItem("删除轨道").getAttribute("aria-disabled")).toBe("true");
    expect(menuItem("删除轨道").textContent).toContain("移走片段");
    await click(menuItem("删除轨道"));
    expect(writes()).toHaveLength(2);

    project.tracks = project.tracks.map((track) => (track.id === "t1" ? { ...track, clips: [] } : track));
    project.subtitleTracks = [{ id: "sub", name: "字幕", default_style_id: "style", carrier_tracks: ["t1"] }];
    await act(async () => render());
    expect(menuItem("删除轨道").textContent).toContain("字幕承载轨");
    project.subtitleTracks = [];
    await act(async () => render());
    await click(menuItem("删除轨道"));
    expect(lastOps()).toEqual([{ op: "remove_track", track_id: "t1" }]);
  });

  it("blocks pointer moves, trim handles, rolls and blade cuts on a locked lane", async () => {
    project.tracks = project.tracks.map((track) => (track.id === "t0" ? { ...track, locked: true } : track));
    await act(async () => render());
    const lane = get('[data-track-id="t0"]');
    const clip = get('[data-selection-id="c00"]');
    expect(lane.classList.contains("is-track-locked")).toBe(true);
    expect(clip.style.cursor).toBe("not-allowed");
    expect(lane.querySelector("[data-trim-edge]")).toBeNull();
    await pointer(clip, "pointerdown", 48);
    await pointer(clip, "pointermove", 96);
    await pointer(clip, "pointerup", 96);
    await action("tool_roll");
    const seam = lane.querySelector(".zc-seam") as HTMLElement;
    await pointer(seam, "pointerdown", 192);
    await pointer(seam, "pointermove", 215);
    await pointer(seam, "pointerup", 215);
    await action("tool_blade");
    await pointer(clip, "pointermove", 48);
    expect(lane.querySelector(".zc-blade-line")).toBeNull();
    await pointer(clip, "click", 48);
    expect(writes()).toHaveLength(0);
  });

  it("uses the selected target for three-point edits and keeps solo in UI state", async () => {
    project.media = [{ id: "media", kind: "audio", duration: "20s", audio: { sample_rate: "48000", channels: 2 } }];
    state.media = { id: "media", at: "0s", in: "0s", out: "2s" };
    await act(async () => render());
    await click(control("t2", "设为目标轨"));
    await click(control("t1", "独奏"));
    expect(state.soloAudioTrackIds).toEqual(["t1"]);
    expect(writes()).toHaveLength(0);
    await action("insert_edit");
    expect(lastOps()).toEqual([expect.objectContaining({ op: "place", mode: "insert", audio_track: "t2" })]);
    await action("overwrite_edit");
    expect(lastOps()).toEqual([expect.objectContaining({ op: "place", mode: "overwrite", audio_track: "t2" })]);
    await action("connect_edit");
    expect(lastOps()).toEqual([
      expect.objectContaining({ op: "add_track", kind: "audio", index: 3 }),
      expect.objectContaining({ op: "place", mode: "overwrite" }),
    ]);
    await click(control("t2", "取消目标轨"));
    await click(control("t1", "取消独奏"));
    expect(state.soloAudioTrackIds).toEqual([]);
    await action("insert_edit");
    expect(lastOps()).toEqual([expect.objectContaining({ op: "place", audio_track: "t1" })]);
  });

  it("updates the preview mix when solo changes in the track header", async () => {
    showViewer = true;
    previewConfig = { port: 1234, token: "test" };
    const warm = vi.spyOn(PreviewMix.prototype, "warm").mockImplementation(() => {});
    const mixedClips = () => warm.mock.lastCall?.[0].map(({ clip }) => clip.id);

    await act(async () => render());
    expect(mixedClips()).toEqual(["c10", "c11", "c20", "c21"]);
    await click(control("t1", "独奏"));
    expect(mixedClips()).toEqual(["c10", "c11"]);
    await click(control("t1", "取消独奏"));
    expect(mixedClips()).toEqual(["c10", "c11", "c20", "c21"]);
  });

  it("resizes one track and saves its height in the UI preferences", async () => {
    const row = head("t1").parentElement as HTMLElement;
    const handle = control("t1", "调整轨道高度");
    vi.spyOn(row, "getBoundingClientRect").mockReturnValue({ height: 30 } as DOMRect);
    await pointer(handle, "pointerdown", 10, 20);
    await pointer(handle, "pointermove", 10, 65);
    expect(row.style.height).toBe("75px");
    expect(call).not.toHaveBeenCalled();
    await pointer(handle, "pointerup", 10, 65);
    expect(call).toHaveBeenCalledWith("prefs_set", {
      patch: { ui: { track_heights: { [JSON.stringify([state.project, project.id, "t1"])]: 75 } } },
    });
    expect(row.style.height).toBe("75px");
    expect(head("t0").parentElement?.style.height).toBe("");
    expect(ui.track_height).toBe("m");
  });
});

describe("timeline clipboard", () => {
  it.each([true, false])("pastes linked and cross-track copies in one edit (magnetic %s)", async (magnetic) => {
    ui.magnetic = magnetic;
    project.edit_rate = "30000/1001";
    const [video, audio, otherAudio] = project.tracks;
    if (!video || !audio || !otherAudio) throw new Error("Missing fixture tracks");
    const [picture] = video.clips;
    const [sound] = audio.clips;
    const [, later] = otherAudio.clips;
    if (!picture || !sound || !later) throw new Error("Missing fixture clips");
    Object.assign(picture, {
      label: "画面",
      enabled: false,
      transform: { scale: 1.25 },
      time_map: [
        { at: { t: "0s" }, source: { t: "2s" }, interp: "linear" },
        { at: { t: "1001/500s" }, source: { t: "3s" }, interp: "linear" },
      ],
    });
    sound.gain_db = -6;
    sound.sync_broken = true;
    picture.timeline_out = sound.timeline_out = { t: "1001/500s" };
    later.timeline_in = { t: "1001/250s" };
    later.timeline_out = { t: "3003/500s" };
    state = { ...state, selected: [later.id, sound.id, picture.id], playhead: { at: "1001/1000s" } };
    await act(async () => render());
    await refresh();
    await action("copy");
    expect(writes()).toHaveLength(0);
    await action("paste");
    expect(writes()).toHaveLength(1);
    expect(writes()[0]?.[1].label).toBe("粘贴 2 个片段");
    const ops = lastOps() as Record<string, unknown>[];
    expect(ops).toEqual([
      expect.objectContaining({
        op: "place",
        mode: magnetic ? "insert" : "overwrite",
        at: "1001/1000s",
        duration: "1001/500s",
        source_start: "2s",
        media_id: "media",
        video_track: "t0",
        audio_track: "t1",
      }),
      expect.objectContaining({
        op: "set_clip",
        clip_id: ops[0]?.video_clip_id,
        label: "画面",
        enabled: false,
        transform: { scale: 1.25 },
        time_map: [
          { at: "0s", source: "2s", interp: "linear" },
          { at: "1001/500s", source: "3s", interp: "linear" },
        ],
      }),
      expect.objectContaining({ op: "set_clip", clip_id: ops[0]?.audio_clip_id, gain_db: -6 }),
      expect.objectContaining({
        op: "place",
        mode: magnetic ? "insert" : "overwrite",
        at: "1001/200s",
        audio_track: "t2",
      }),
      expect.objectContaining({ op: "set_clip", clip_id: ops[3]?.audio_clip_id }),
    ]);
    if (!magnetic) expect(get("output.zc-meta").textContent).toContain("将覆盖：画面");
  });

  it.each([true, false])("cuts using the matching delete and keeps a copy (magnetic %s)", async (magnetic) => {
    ui.magnetic = magnetic;
    state = { ...state, selected: ["c00"] };
    await act(async () => render());
    await refresh();
    await action("cut");
    expect(lastOps()).toEqual([{ op: "remove", clip_ids: ["c00"], ...(magnetic ? { ripple: true } : {}) }]);
    await action("paste");
    expect(lastOps()).toEqual(expect.arrayContaining([expect.objectContaining({ op: "place", video_track: "t0" })]));
  });

  it.each([true, false])(
    "uses explicit same-kind targets and rejects locked destinations (magnetic %s)",
    async (magnetic) => {
      ui.magnetic = magnetic;
      const target = project.tracks.find((track) => track.id === "t2");
      if (!target) throw new Error("Missing destination track");
      state = { ...state, selected: ["c00", "c10"] };
      await act(async () => render());
      await refresh();
      await action("copy");
      const head = get('[data-track-id="t2"]').parentElement;
      const targetButton = head?.querySelector<HTMLElement>('[aria-label="设为目标轨"]');
      if (!targetButton) throw new Error("Missing track target control");
      await click(targetButton);
      expect(state.editTargets).toMatchObject({ audio: "t2" });
      target.locked = true;
      await act(async () => render());
      await action("paste");
      expect(writes()).toHaveLength(0);
      expect(get("output.zc-meta").textContent).toBe(`轨道「${target.name}」已锁定`);
      target.locked = false;
      await act(async () => render());
      await action("paste");
      expect(writes()).toHaveLength(1);
      expect(lastOps()).toEqual(
        expect.arrayContaining([expect.objectContaining({ op: "place", video_track: "t0", audio_track: "t2" })]),
      );
    },
  );

  it("uses the active skimmer, falls back to the first track, and clears on a project switch", async () => {
    ui.skimming = true;
    state = { ...state, selected: ["c21"], editTargets: { audio: "t2" } };
    await act(async () => render());
    await refresh();
    await action("copy");
    project = { ...project, tracks: project.tracks.filter((track) => track.id !== "t2") };
    await act(async () => render());
    await pointer(get('[data-selection-id="c00"]'), "pointermove", 49);
    await action("paste");
    expect(lastOps()).toEqual(
      expect.arrayContaining([expect.objectContaining({ op: "place", at: "1s", audio_track: "t1" })]),
    );
    state = { ...state, project: "/other.zcut.json" };
    await act(async () => render());
    await action("paste");
    expect(writes()).toHaveLength(1);
    expect(get("output.zc-meta").textContent).toBe("剪贴板为空");
  });

  it("shows a copy ghost and follows Option at release without applying Premiere's Command reversal", async () => {
    preset = "premiere";
    ui.magnetic = false;
    project.tracks = project.tracks.slice(0, 2);
    await act(async () => render());
    await refresh();
    const clip = get('[data-selection-id="c00"]');
    await pointer(clip, "pointerdown", 10);
    await pointer(clip, "pointermove", 394, 40, { altKey: true, metaKey: true });
    expect(get(".zc-drop-preview").textContent).toBe("+");
    expect(clip.style.left).toBe("0px");
    await pointer(clip, "pointerup", 394, 40, { altKey: true, metaKey: true });
    expect(lastOps()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ op: "place", mode: "overwrite", at: "8s", video_track: "t0", audio_track: "t1" }),
      ]),
    );
    await pointer(clip, "pointerdown", 10);
    await pointer(clip, "pointermove", 394, 40, { altKey: true });
    await act(async () => window.dispatchEvent(new KeyboardEvent("keyup", { key: "Alt" })));
    expect(get(".zc-drop-preview")).toBeNull();
    await pointer(clip, "pointerup", 394);
    expect(lastOps()).toEqual([{ op: "move", mode: "place", to: "8s", clip_ids: ["c00"] }]);
  });

  it.each([true, false])("protects the original from an overlapping Option drop (magnetic %s)", async (magnetic) => {
    ui.magnetic = magnetic;
    project.tracks = project.tracks.slice(0, 2);
    await act(async () => render());
    await refresh();
    const clip = get('[data-selection-id="c00"]');
    await pointer(clip, "pointerdown", 10);
    await pointer(clip, "pointermove", 58, 40, { altKey: true });
    await pointer(clip, "pointerup", 58, 40, { altKey: true });
    expect(writes()).toHaveLength(0);
    expect(get("output.zc-meta").textContent).toBe(magnetic ? "插入会切开原片段" : "副本会覆盖原片段");
  });

  it("inserts overlapping cross-track copies without splitting a previously placed copy", async () => {
    const source = project.tracks[2]?.clips[1];
    if (!source) throw new Error("Missing fixture clip");
    source.timeline_in = { t: "1s" };
    source.timeline_out = { t: "5s" };
    state = { ...state, selected: ["c00", source.id] };
    await act(async () => render());
    await action("copy");
    await action("paste");
    const ops = lastOps() as Record<string, unknown>[];
    expect(ops[0]).toMatchObject({ op: "place", mode: "insert", at: "2s" });
    expect(ops[2]).toMatchObject({ op: "place", mode: "insert", at: "6s" });
    expect(ops[4]).toEqual({ op: "move", mode: "place", to: "3s", clip_ids: [ops[2]?.audio_clip_id] });
  });
});

it("outlines changed clips and marks deletions on the original track and ruler", async () => {
  aiChanges = {
    clips: new Map([["c00", "缩短开头"]]),
    removals: new Map([["c_deleted", { track: "t1", at: "9s", label: "删掉停顿" }]]),
  };
  await act(async () => render());
  const clip = get('[data-selection-id="c00"]');
  expect(clip.title).toContain("缩短开头");
  expect(clip.dataset.aiChange).toBe("缩短开头");
  expect(get('[data-track-id="t1"] .zc-ai-removal-line').title).toBe("删掉停顿");
  expect(get(".zc-ruler .zc-ai-removal-tick").style.left).toBe(get(".zc-ai-removal-line").style.left);
  await click(clip);
  expect(state.selected).toContain("c00");
  aiChanges = undefined;
  await act(async () => render());
  expect(host.querySelector("[data-ai-change], .zc-ai-removal-line, .zc-ai-removal-tick")).toBeNull();
});

it.each([
  ["slip", "滑动内容", "source", "14s"],
  ["slide", "滑动片段", "right", "99/25s"],
] as const)(
  "previews and commits a bounded %s drag, then releases the temporary tool",
  async (tool, label, detail, by) => {
    aiChanges = { clips: new Map([["c00", "缩短开头"]]), removals: new Map() };
    await act(async () => render());
    await action(tool === "slip" ? "tool_slip" : "tool_slide");
    const button = get(`button[aria-label^="${label}"]`);
    expect(button.getAttribute("aria-pressed")).toBe("true");
    const clip = get('[data-selection-id="c00"]');
    await pointer(clip, "pointerdown", 48);
    await pointer(clip, "pointermove", 900);
    expect(clip.style.outline).toContain("attention");
    const feedback = document.querySelector('[aria-label="拖动反馈"]')?.textContent;
    expect(feedback).toContain(detail === "source" ? "源入点" : "右侧入点");
    expect(feedback).toContain("+00:00:");
    expect(feedback).toContain(tool === "slip" ? "已到素材边界" : "已到相邻片段或空隙边界");
    expect(clip.dataset.aiChange).toBe("缩短开头");
    await pointer(clip, "pointerup", 900);
    expect(lastOps()).toEqual([{ op: tool, clip_id: "c00", by }]);
    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent("keyup", { key: reply().keymap[tool === "slip" ? "tool_slip" : "tool_slide"] ?? "" }),
      );
    });
    expect(button.getAttribute("aria-pressed")).toBe("false");
    await click(button);
    expect(button.getAttribute("aria-pressed")).toBe("true");
  },
);

it.each([
  ["select_edit_in", "left", "c00", "out", "trim"],
  ["select_edit_out", "right", "c01", "in", "trim"],
  ["select_edit_both", "both", "c00", "out", "roll"],
] as const)("selects %s at the playhead and nudges the selected edge", async (name, side, clip_id, edge, op) => {
  state.playhead = { at: "4s" };
  await act(async () => render());
  await action(name);
  expect(get(".zc-seam.is-selected").dataset.side).toBe(side);
  const extra = op === "trim" ? { ripple: true } : {};
  await action("nudge_edit_back");
  expect(lastOps()).toEqual([{ op, clip_id, edge, to: "99/25s", ...extra }]);
  state.edit_point = { ...state.edit_point, track_id: "t0", at: "4s" };
  await act(async () => render());
  await action("nudge_edit_fwd10");
  expect(lastOps()).toEqual([{ op, clip_id, edge, to: "22/5s", ...extra }]);
});

it("selects a gap across tracks, ignores lift, and closes gaps through the keyboard and menu", async () => {
  project = {
    ...project,
    tracks: project.tracks.map((track) => ({
      ...track,
      clips: track.clips.map((clip, index) => (index === 0 ? { ...clip, timeline_out: { t: "3s" } } : clip)),
    })),
  };
  await act(async () => render());
  const gap = get('.zc-gap[data-gap="3s"]');
  await click(gap);
  expect(host.querySelectorAll('.zc-gap[aria-pressed="true"]')).toHaveLength(3);
  await action("lift_delete");
  expect(writes()).toHaveLength(0);
  await action("ripple_delete");
  expect(lastOps()).toEqual([{ op: "remove_span", range: { start: "3s", duration: "1s" }, ripple: true }]);
  await pointer(gap, "contextmenu", 160);
  const buttons = host.querySelectorAll<HTMLButtonElement>(".zc-timeline-menu button");
  expect([...buttons].map((button) => button.textContent)).toEqual(["合拢这段空隙", "合拢全部空隙"]);
  await click(buttons[0] as HTMLButtonElement);
  expect(lastOps()).toEqual([{ op: "remove_span", range: { start: "3s", duration: "1s" }, ripple: true }]);
  await pointer(gap, "contextmenu", 160);
  await click(get(".zc-timeline-menu button:last-child"));
  expect(lastOps()).toEqual([{ op: "close_gaps" }]);
  expect(commandBlockReason("close_all_gaps")).toBeNull();
  await act(async () => expect(runEditorCommand("close_all_gaps")).toBe(true));
  expect(lastOps()).toEqual([{ op: "close_gaps" }]);
});

it("edits, drags, deletes and jumps to review markers", async () => {
  const marker = get(".zc-marker");
  await click(marker);
  expect(marker.getAttribute("aria-pressed")).toBe("true");
  await pointer(marker, "dblclick", 288);
  const input = get(".zc-marker-text") as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, "复查声音");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await key("Enter", input);
  expect(lastOps()).toEqual([{ op: "update_marker", marker_id: "review", text: "复查声音" }]);
  const updated = get(".zc-marker");
  await pointer(updated, "pointerdown", 288);
  await pointer(updated, "pointermove", 240);
  expect(updated.style.left).toBe("240px");
  await pointer(updated, "pointerup", 240);
  expect(lastOps()).toEqual([{ op: "update_marker", marker_id: "review", at: "5s" }]);
  await pointer(updated, "contextmenu", 288);
  await click(get(".zc-timeline-menu button"));
  expect(lastOps()).toEqual([{ op: "remove_marker", marker_id: "review" }]);
  state.playhead = { at: "0s" };
  await act(async () => render());
  const list = get('select[aria-label="标记"]') as HTMLSelectElement;
  await act(async () => {
    list.value = "review";
    list.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(state.playhead).toEqual({ at: "6s" });
});

it("shows outgoing and incoming source frames while rolling a cut", async () => {
  showViewer = true;
  previewConfig = { port: 1234, token: "test" };
  vi.spyOn(PreviewMix.prototype, "warm").mockImplementation(() => {});
  await act(async () => render());
  await action("tool_roll");
  const seam = get('[data-track-id="t0"] .zc-seam');
  await pointer(seam, "pointerdown", 192);
  await pointer(seam, "pointermove", 240);
  const frames = [...host.querySelectorAll<HTMLImageElement>(".zc-trim-frames img")];
  expect(frames.map((frame) => new URL(frame.src).searchParams.get("at"))).toEqual(["174/25s", "3s"]);
  await pointer(seam, "pointercancel", 240);
  expect(get(".zc-trim-frames")).toBeNull();
  expect(writes().filter(([verb]) => verb === "edit")).toHaveLength(0);
});
