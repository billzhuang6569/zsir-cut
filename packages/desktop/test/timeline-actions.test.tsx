// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Action, mergeKeymap, type presets } from "../../app-host/src/keymap.js";
import { connectHost, DESKTOP_AUTHOR, type ProjectView } from "../src/connection.js";
import { applyUi, initialState } from "../src/state.js";
import { add, compare, frameTime, parseRational, sub } from "../src/timeline.js";
import { recordingCanvas } from "./canvas.js";
import { TimelinePreview } from "./timeline-preview.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let host: HTMLDivElement;
let root: Root;
let state = initialState();
let project: ProjectView;
let preset: keyof typeof presets;
let overrides: Partial<Record<Action, string | null>>;
let ui: { snap: boolean; magnetic: boolean; track_height: "s" | "m" | "l" };
let readOnly = false;
let sourceViewer = false;
const dragging = { current: false };
const settings = vi.fn();
const reply = () => ({ prefs: { ui }, ...mergeKeymap(preset, overrides) });
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
      state={state}
      update={(next) => {
        state = next;
        render();
      }}
      call={call}
      config={undefined}
      error={null}
      dragging={dragging}
      hideViewer={!sourceViewer}
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
async function pointer(target: HTMLElement, type: string, x: number, y = 40) {
  await act(async () => {
    const event = new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0 });
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
  ui = { snap: false, magnetic: true, track_height: "m" };
  readOnly = false;
  sourceViewer = false;
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
  vi.restoreAllMocks();
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
    expect(lastOps()).toMatchObject([{ op: "move", mode: magnetic ? "insert" : "place" }]);
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
