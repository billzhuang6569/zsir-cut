// @vitest-environment jsdom
import { act, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { mergeKeymap } from "../../app-host/src/keymap.js";
import type { UiState } from "../../app-host/src/ui.js";
import type { ProjectView } from "../src/connection.js";
import { useMediaPanel } from "../src/MediaPanel.js";
import { middle, type Placement, placeMedia, sourceProject } from "../src/media.js";
import { updateMediaCache } from "../src/media-cache.js";
import { initialState } from "../src/state.js";
import { useVoicePanel } from "../src/VoicePanel.js";
import { recordingCanvas } from "./canvas.js";
import { TimelinePreview } from "./timeline-preview.js";

type NativePayload = {
  type: "enter" | "over" | "drop" | "leave";
  paths?: string[];
  position?: { x: number; y: number };
};
const native = vi.hoisted(() => ({
  enabled: false,
  open: vi.fn(),
  reveal: vi.fn(),
  listeners: new Set<(event: { payload: NativePayload }) => void>(),
}));
const nativeDrop = (payload: NativePayload) => {
  for (const listener of native.listeners) listener({ payload });
};
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => native.enabled }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: native.open }));
vi.mock("@tauri-apps/plugin-opener", () => ({ revealItemInDir: native.reveal }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    onDragDropEvent: async (handler: (event: { payload: NativePayload }) => void) => {
      native.listeners.add(handler);
      return () => native.listeners.delete(handler);
    },
  }),
}));
const media = {
  id: "med_one",
  name: "镜头.mov",
  path: "/素材/镜头.mov",
  kind: "video",
  duration: "10s",
  start_timecode: "01:00:00:00",
  video: { width: 1920, height: 1080, rate: "25" },
  audio: { sample_rate: "48000", channels: 2 },
  organize: { note: "原注释", tags: ["采访"], folders: ["项目/原始"], rating: 3 },
  uses: 2,
};
const project: ProjectView = {
  id: "tl_one",
  name: "工程",
  revision: { id: "rev_one", seq: 1 },
  edit_rate: "25",
  start_timecode: "00:00:00:00",
  drop_frame: false,
  duration: { t: "10s" },
  media: [media, { ...media, id: "med_two", name: "风景.mov", organize: {} }],
  cues: [],
  styles: [],
  markers: [{ id: "mark", at: { t: "2s" }, kind: "review", text: "切点" }],
  tracks: [
    { id: "video_top", name: "视频 A", kind: "video", enabled: true, clips: [] },
    { id: "video_lower", name: "视频 B", kind: "video", enabled: true, clips: [] },
    { id: "audio_first", name: "声音 A", kind: "audio", enabled: true, clips: [] },
  ],
};
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
afterEach(() => {
  native.enabled = false;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const config = { port: 1234, token: "test" };
const palette = Array.from({ length: 9 }, (_, i) => `#${String(i).repeat(6)}`);
async function mount(
  nativeMode = false,
  preview = false,
  view = project,
  withConfig = false,
  preset: "fcp" | "premiere" = "fcp",
) {
  native.enabled = nativeMode;
  updateMediaCache(config, {
    media: view.media.map((item) => ({
      media_id: item.id,
      key: item.id.padEnd(32, "a"),
      peaks: "ready",
      thumbs: "missing",
    })),
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => ({
      ok: true,
      arrayBuffer: async () => Uint8Array.from([64, 191, 255]).buffer,
      json: async () => (url.includes("/peaks?") ? [0.25, 0.75, 1] : palette),
    })),
  );
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  const call = vi.fn(async (_verb: string, _request: Record<string, unknown>): Promise<unknown> => ({}));
  let state: UiState = { ...initialState(), panel: "media", project: "/工程.zcut.json", playhead: { at: "4s" } };
  let change: (next: UiState) => void = () => {};
  let refresh: (next: ProjectView) => void = () => {};
  const timelineCall = (verb: string, request: Record<string, unknown>) =>
    verb === "prefs_get"
      ? Promise.resolve({
          prefs: { keymap: { preset }, ui: { snap: true, magnetic: true, track_height: "m" } },
          ...mergeKeymap(preset, {}),
        })
      : call(verb, request);
  function Harness() {
    const [ui, update] = useState(state);
    const [placement, setPlacement] = useState<Placement>("av");
    const [currentProject, setProject] = useState(view);
    const dragging = useRef(false);
    refresh = setProject;
    state = ui;
    change = update;
    const panel = useMediaPanel({
      project: currentProject,
      state: ui,
      update,
      call,
      placement,
      preset,
      keymap: mergeKeymap(preset, {}).keymap,
      config: withConfig ? config : undefined,
    });
    const voice = useVoicePanel({ call, state: ui, update, project: currentProject });
    const source = preview && ui.preview === "media" && panel.selected ? sourceProject(project, panel.selected) : null;
    return (
      <>
        {panel.header}
        {panel.library}
        {panel.parameters}
        {ui.panel === "voice" && voice.parameters}
        <output aria-label="当前状态">{JSON.stringify(ui)}</output>
        {source && (
          <TimelinePreview
            project={source}
            viewerOnly
            state={{ ...ui, playhead: { at: ui.media?.at ?? "0s" }, range: null }}
            update={(next) => {
              if (ui.media)
                update({
                  ...ui,
                  playing: next.playing,
                  media: { ...ui.media, at: "at" in next.playhead ? next.playhead.at : "0s" },
                });
            }}
            config={undefined}
            error={null}
            dragging={{ current: false }}
            call={timelineCall}
          />
        )}
        <TimelinePreview
          project={currentProject}
          hideViewer={Boolean(source)}
          state={ui}
          update={update}
          config={undefined}
          error={null}
          dragging={dragging}
          call={timelineCall}
          placement={placement}
          onPlacementChange={setPlacement}
        />
      </>
    );
  }
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<Harness />);
  });
  const click = async (label: string) => {
    const node =
      container.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`) ??
      [...container.querySelectorAll("button")].find((b) => b.textContent === label);
    if (!node) throw new Error(label);
    await act(async () => {
      node.click();
    });
  };
  const select = async () => {
    await act(async () => {
      container.querySelector<HTMLButtonElement>(".zc-media-card")?.click();
    });
  };
  const setInput = async (label: string, text: string) => {
    const input = container.querySelector<HTMLInputElement>(`[aria-label="${label}"]`);
    if (!input) throw new Error(label);
    await act(async () => {
      input.focus();
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, text);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    return input;
  };
  const close = async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
  };
  return {
    container,
    call,
    click,
    select,
    setInput,
    close,
    state: () => state,
    refresh: async (next: ProjectView) => {
      await act(async () => {
        refresh(next);
      });
    },
    change: async (next: UiState) => {
      await act(async () => {
        change(next);
      });
    },
  };
}
it("commits organization once on blur/Enter, uses human labels, and clears a repeated star", async () => {
  const h = await mount();
  try {
    await h.select();
    expect(h.container.textContent).toContain("已用 2 段");
    expect(h.container.querySelector(".zc-media-info")?.textContent).not.toContain("med_one");
  } finally {
    await h.close();
  }
});
it("sends every organizing field and browser import paths only at submission", async () => {
  const h = await mount();
  try {
    await h.select();
    for (const [label, value, field, expected] of [
      ["注释", "新注释", "note", "新注释"],
      ["来源链接", "https://example.test", "link", "https://example.test"],
      ["添加标签", "新标签", "tags", ["采访", "新标签"]],
      ["添加文件夹", "项目/精选", "folders", ["项目/原始", "项目/精选"]],
    ] as const) {
      const count = h.call.mock.calls.length;
      if (field === "tags" || field === "folders") await h.click(label);
      const input = await h.setInput(label, value);
      expect(h.call).toHaveBeenCalledTimes(count);
      await act(async () => {
        input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      });
      expect(h.call).toHaveBeenCalledTimes(count + 1);
      expect(h.call).toHaveBeenLastCalledWith(
        "edit",
        expect.objectContaining({
          author: { kind: "human", name: "桌面用户" },
          label: expect.stringContaining("镜头.mov"),
          ops: [{ op: "update_media", media_id: media.id, [field]: expected }],
        }),
      );
    }
    await h.click("3 星");
    expect(h.call).toHaveBeenLastCalledWith(
      "edit",
      expect.objectContaining({ ops: [{ op: "update_media", media_id: media.id, rating: 0 }] }),
    );
    await h.click("删除标签 采访");
    expect(h.call).toHaveBeenLastCalledWith(
      "edit",
      expect.objectContaining({ ops: [{ op: "update_media", media_id: media.id, tags: [] }] }),
    );
    await h.click("删除文件夹 项目/原始");
    expect(h.call).toHaveBeenLastCalledWith(
      "edit",
      expect.objectContaining({ ops: [{ op: "update_media", media_id: media.id, folders: ["项目/精选"] }] }),
    );
    await h.click("导入素材");
    const input = await h.setInput("导入文件路径（逗号分隔）", "/素材/一.mov,/素材/二.wav");
    await act(async () => {
      input.blur();
    });
    expect(h.call).toHaveBeenLastCalledWith(
      "import_media",
      expect.objectContaining({ paths: ["/素材/一.mov", "/素材/二.wav"], label: "导入素材", base_revision: "rev_one" }),
    );
  } finally {
    await h.close();
  }
});
it.each(["fcp", "premiere"] as const)("routes source range and Q by focus with the %s preset", async (preset) => {
  const clip = {
    id: "clip",
    media_id: media.id,
    label: null,
    enabled: true,
    speed: "1",
    timeline_in: { t: "0s" },
    timeline_out: { t: "8s" },
    source_in: { t: "0s" },
    source_out: { t: "8s" },
  };
  const h = await mount(
    false,
    true,
    { ...project, tracks: project.tracks.map((track, i) => (i === 0 ? { ...track, clips: [clip] } : track)) },
    false,
    preset,
  );
  try {
    await h.select();
    expect(h.container.querySelector('[aria-label="素材预览"]')).not.toBeNull();
    const source = h.container.querySelector<HTMLElement>(".zc-media-card");
    const timeline = h.container.querySelector<HTMLElement>('[aria-label="时间标尺"]');
    if (!source || !timeline) throw new Error("Missing editor focus regions");
    const press = async (target: HTMLElement, key: string, init: KeyboardEventInit = {}, prevented = false) => {
      target.focus();
      await act(async () => {
        const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
        if (prevented) event.preventDefault();
        target.dispatchEvent(event);
      });
    };
    await h.change({ ...h.state(), selected: ["clip"], media: { id: media.id, at: "2s", in: null, out: null } });
    await press(source, "i");
    await h.change({ ...h.state(), media: { id: media.id, in: h.state().media?.in ?? null, out: null, at: "5s" } });
    await press(source, "o");
    expect(h.container.querySelector('[aria-label="播放时码"]')?.textContent).toBe("01:00:05:00");
    expect(h.state().media).toMatchObject({ in: "2s", out: "5s" });
    await press(source, "q", { metaKey: true });
    await press(source, "q", {}, true);
    const field = h.container.querySelector<HTMLInputElement>(".zc-media-info input");
    if (!field) throw new Error("Missing media input");
    await press(field, "q");
    expect(h.call.mock.calls.filter(([verb]) => verb === "edit")).toHaveLength(0);

    await press(source, "q");
    expect(h.call.mock.calls.filter(([verb]) => verb === "edit")).toHaveLength(preset === "fcp" ? 1 : 0);
    if (preset === "premiere") await press(source, ",");
    expect(h.call).toHaveBeenLastCalledWith(
      "edit",
      expect.objectContaining({
        ops: expect.arrayContaining([
          expect.objectContaining({
            op: "place",
            media_id: media.id,
            source_start: "2s",
            duration: "3s",
            at: "4s",
            mode: preset === "fcp" ? "overwrite" : "insert",
            video_track: preset === "fcp" ? "video_lower" : "video_top",
          }),
        ]),
      }),
    );
    await press(timeline, "q");
    const writes = h.call.mock.calls.filter(([verb]) => verb === "edit");
    expect(writes).toHaveLength(2);
    expect(writes[1]?.[1].ops).toEqual(
      preset === "premiere"
        ? [{ op: "trim", clip_id: "clip", edge: "in", to: "4s", ripple: true }]
        : expect.arrayContaining([expect.objectContaining({ op: "place", mode: "overwrite" })]),
    );
  } finally {
    await h.close();
  }
});
function dropGeometry(container: HTMLElement) {
  const mockRect = (selector: string, rect: Partial<DOMRect>) => {
    const node = container.querySelector<HTMLElement>(selector);
    if (!node) throw new Error(selector);
    vi.spyOn(node, "getBoundingClientRect").mockReturnValue(rect as DOMRect);
    return node;
  };
  const timeline = mockRect(".zc-timeline", { left: 100, right: 700, top: 200, bottom: 430 });
  mockRect(".zc-timeline-content", { top: 200 });
  mockRect(".zc-ruler-row", { bottom: 228 });
  mockRect(".zc-ruler-row > .zc-track-name", { width: 40 });
  mockRect(".zc-ruler", { left: 140 });
  mockRect('[data-track-id="video_top"]', { top: 228, bottom: 268 });
  mockRect('[data-track-id="video_lower"]', { top: 274, bottom: 314 });
  mockRect('[data-track-id="audio_first"]', { top: 320, bottom: 350 });
  return timeline;
}

async function pointer(target: Element, type: string, at: MouseEventInit = {}) {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    buttons: type === "pointerup" || type === "pointercancel" ? 0 : 1,
    ...at,
  });
  Object.defineProperty(event, "pointerId", { value: 1 });
  await act(async () => target.dispatchEvent(event));
}

it("shows both source-range ghosts and drops one linked overwrite at the snapped frame", async () => {
  const h = await mount(true);
  try {
    await h.select();
    await h.change({ ...h.state(), media: { id: media.id, at: "0s", in: "1s", out: "4s" } });
    const timeline = dropGeometry(h.container);
    const card = h.container.querySelector(".zc-media-card");
    if (!card) throw new Error("missing card");
    const capture = vi.fn();
    const release = vi.fn();
    Object.assign(card, {
      setPointerCapture: capture,
      hasPointerCapture: () => capture.mock.calls.length > release.mock.calls.length,
      releasePointerCapture: release,
    });
    const floating = () => document.querySelector<HTMLElement>(".zc-drop-card-preview");
    const point = { clientX: 240, clientY: 249, altKey: true };
    await pointer(card, "pointerdown");
    await pointer(card, "pointermove", { clientX: 4 });
    expect(capture).not.toHaveBeenCalled();
    expect(floating()).toBeNull();
    expect(timeline.querySelector(".zc-drop-line")).toBeNull();
    await pointer(card, "pointermove", { clientX: 5 });
    expect(capture).toHaveBeenCalledWith(1);
    expect(floating()?.textContent).toContain("镜头.mov");
    expect(floating()?.textContent).toContain("00:00:03:00");
    expect(floating()?.style.left).toBe("17px");
    await pointer(card, "pointermove", point);
    expect(floating()?.style.left).toBe("252px");
    expect(timeline.querySelector<HTMLElement>(".zc-drop-line")?.style.left).toContain("96px");
    const ghosts = [...timeline.querySelectorAll<HTMLElement>(".zc-track-lane .zc-drop-preview")];
    expect(ghosts).toHaveLength(2);
    for (const ghost of ghosts) {
      expect(ghost.style.left).toBe("96px");
      expect(ghost.style.width).toBe("144px");
      expect(ghost.textContent).toBe("00:00:02:00 · 覆盖");
    }
    expect(h.call).not.toHaveBeenCalled();
    await pointer(card, "pointerup", point);
    await pointer(card, "pointerup", point);
    expect(h.call).toHaveBeenCalledTimes(1);
    expect(h.call).toHaveBeenLastCalledWith(
      "edit",
      expect.objectContaining({
        ops: [
          {
            op: "place",
            media_id: media.id,
            source_start: "1s",
            duration: "3s",
            mode: "overwrite",
            at: "2s",
            video_track: "video_top",
            audio_track: "audio_first",
          },
        ],
      }),
    );
    expect(release).toHaveBeenCalledExactlyOnceWith(1);
    expect(floating()).toBeNull();
    expect(timeline.querySelector(".zc-drop-line")).toBeNull();
    expect(timeline.querySelector(".zc-drop-preview")).toBeNull();
  } finally {
    await h.close();
  }
});

it("preserves clicks below the threshold and cancels when released outside the timeline", async () => {
  const h = await mount();
  try {
    const timeline = dropGeometry(h.container);
    const card = h.container.querySelector(".zc-media-card");
    if (!card) throw new Error("missing card");
    const click = () =>
      act(async () => card.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 })));
    const point = { clientX: 240, clientY: 249 };
    const outside = { clientX: 240, clientY: 199 };
    await pointer(card, "pointerdown");
    await pointer(card, "pointermove", point);
    expect(timeline.querySelector(".zc-drop-preview")).not.toBeNull();
    await pointer(card, "pointermove", outside);
    expect(timeline.querySelector(".zc-drop-preview")).toBeNull();
    expect(timeline.querySelector(".zc-drop-line")).toBeNull();
    expect(document.querySelector(".zc-drop-card-preview")).not.toBeNull();
    await pointer(card, "pointerup", outside);
    await click();
    expect(document.querySelector(".zc-drop-card-preview")).toBeNull();
    expect(h.call).not.toHaveBeenCalled();
    expect(h.state().selected).toEqual([]);
    await pointer(card, "pointerdown");
    await pointer(card, "pointermove", { clientX: 3 });
    await pointer(card, "pointerup", { clientX: 3 });
    await click();
    expect(h.state().selected).toEqual([media.id]);
  } finally {
    await h.close();
  }
});

it("rejects an incompatible lane, then cancels a new-track preview with Escape", async () => {
  const h = await mount();
  try {
    const timeline = dropGeometry(h.container);
    const placement = h.container.querySelector<HTMLSelectElement>(".zc-placement select");
    if (!placement) throw new Error("missing placement");
    await act(async () => {
      placement.value = "audio";
      placement.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const card = h.container.querySelector(".zc-media-card");
    if (!card) throw new Error("missing card");
    await pointer(card, "pointerdown");
    const point = { clientX: 240, clientY: 249 };
    await pointer(card, "pointermove", point);
    expect(timeline.querySelector(".zc-drop-preview.is-invalid")?.textContent).toContain("请把声音放到声音轨");
    await pointer(card, "pointerup", point);
    expect(h.call).not.toHaveBeenCalled();
    await pointer(card, "pointerdown");
    const gap = { ...point, clientY: 270 };
    await pointer(card, "pointermove", gap);
    expect(timeline.querySelector(".zc-drop-new-track")?.textContent).toContain("新建声音轨");
    await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true })));
    expect(timeline.querySelector(".zc-drop-preview")).toBeNull();
    expect(timeline.querySelector(".zc-drop-line")).toBeNull();
    expect(document.querySelector(".zc-drop-card-preview")).toBeNull();
    await pointer(card, "pointerup", gap);
    expect(h.call).not.toHaveBeenCalled();
    await pointer(card, "pointerdown");
    await pointer(card, "pointermove", gap);
    await pointer(card, "pointerup", gap);
    const [, request] = h.call.mock.calls[0] ?? [];
    const [addTrack, place] = request?.ops as Record<string, unknown>[];
    expect(addTrack).toMatchObject({ op: "add_track", kind: "audio", index: 1 });
    expect(place).toMatchObject({ op: "place", audio_track: addTrack?.id, mode: "insert" });
    expect(place).not.toHaveProperty("video_track");
  } finally {
    await h.close();
  }
});

it("scrolls at both timeline edges and recomputes the landing under the pointer", async () => {
  const h = await mount();
  try {
    const timeline = dropGeometry(h.container);
    const card = h.container.querySelector(".zc-media-card");
    const ruler = timeline.querySelector(".zc-ruler");
    if (!card || !ruler) throw new Error("missing drag geometry");
    vi.mocked(ruler.getBoundingClientRect).mockImplementation(() => ({ left: 140 - timeline.scrollLeft }) as DOMRect);
    let frame: FrameRequestCallback | undefined;
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frame = callback;
      return 123;
    });
    await pointer(card, "pointerdown");
    const edge = { clientX: 699, clientY: 250 };
    await pointer(card, "pointermove", edge);
    const ghost = () => timeline.querySelector<HTMLElement>('[data-track-id="video_top"] .zc-drop-preview')?.style.left;
    const before = ghost();
    await act(async () => frame?.(0));
    expect(timeline.scrollLeft).toBeGreaterThan(0);
    expect(ghost()).not.toBe(before);
    const rightScroll = timeline.scrollLeft;
    const leftEdge = { ...edge, clientX: 141 };
    await pointer(card, "pointermove", leftEdge);
    await act(async () => frame?.(0));
    expect(timeline.scrollLeft).toBeLessThan(rightScroll);
    expect(h.call).not.toHaveBeenCalled();
    await pointer(card, "pointerup", edge);
    expect(h.call).toHaveBeenCalledTimes(1);
  } finally {
    await h.close();
  }
});

it("drags an actual voice result to the audio lane while keeping its buttons independent", async () => {
  const take = { id: "take", kind: "audio", duration: "6s", audio: { sample_rate: "48000", channels: 1 } };
  const h = await mount(true, false, { ...project, media: [media, take] });
  try {
    const timeline = dropGeometry(h.container);
    h.call.mockImplementation(async (verb) => {
      if (verb === "voice_list") return { voices: [] };
      if (verb === "inspect") return { entity: { ext: { "zsir.voice": { text: "配音文本" } } } };
      return {};
    });
    await h.change({ ...h.state(), panel: "voice", sub: "generate" });
    const card = h.container.querySelector(".zc-voice-results [data-media-id='take']");
    const button = card?.querySelector("button");
    const title = card?.querySelector("strong");
    if (!card || !button || !title) throw new Error("missing voice result");
    const point = { clientX: 236, clientY: 330 };
    await pointer(button, "pointerdown");
    await pointer(button, "pointermove", point);
    await pointer(button, "pointerup", point);
    expect(timeline.querySelector(".zc-drop-preview")).toBeNull();
    expect(h.call.mock.calls.some(([verb]) => verb === "edit")).toBe(false);
    await pointer(title, "pointerdown");
    await pointer(title, "pointermove", point);
    expect(document.querySelector(".zc-drop-card-preview")?.textContent).toContain("配音 01");
    expect(timeline.querySelector('[data-track-id="audio_first"] .zc-drop-preview')).not.toBeNull();
    await pointer(title, "pointerup", point);
    expect(h.call).toHaveBeenLastCalledWith(
      "edit",
      expect.objectContaining({
        ops: [expect.objectContaining({ op: "place", media_id: "take", audio_track: "audio_first", duration: "6s" })],
      }),
    );
  } finally {
    await h.close();
  }
});

it("offers the desktop drop hint for browser files without importing them", async () => {
  const h = await mount();
  try {
    const timeline = dropGeometry(h.container);
    const event = new MouseEvent("drop", { bubbles: true, cancelable: true, clientX: 240, clientY: 249 });
    Object.defineProperty(event, "dataTransfer", { value: { types: ["Files"] } });
    await act(async () => timeline.dispatchEvent(event));
    expect(timeline.querySelector('[role="alert"]')?.textContent).toBe("请在桌面应用中把文件拖到时间线");
    expect(h.call).not.toHaveBeenCalled();
  } finally {
    await h.close();
  }
});

it("imports Finder paths in payload order on the AI tab and commits one edit after partial failure", async () => {
  const h = await mount(true);
  try {
    const timeline = dropGeometry(h.container);
    await h.change({ ...h.state(), panel: "ai" });
    vi.stubGlobal("devicePixelRatio", 2);
    timeline.scrollLeft = 48;
    const ruler = timeline.querySelector(".zc-ruler");
    if (!ruler) throw new Error("missing ruler");
    vi.mocked(ruler.getBoundingClientRect).mockReturnValue({ left: 92 } as DOMRect);
    h.call.mockImplementation(async (verb, request) => {
      if (verb === "import_media") {
        const [path] = request.paths as string[];
        if (path === "/离线.mov") throw new Error("文件无法读取");
        const first = path === "/10.mov";
        return {
          imported: [{ media_id: first ? "med_ten" : "med_two" }],
          receipt: { before: request.base_revision, after: first ? "rev_two" : "rev_three" },
        };
      }
      if (verb === "inspect") return { entity: { ...media, id: request.id, duration: "3s" } };
      return {};
    });
    const position = { x: 384, y: 760 };
    const paths = ["/10.mov", "/离线.mov", "/2.mov"];
    await act(async () => nativeDrop({ type: "enter", position: { x: 70, y: 70 }, paths }));
    expect(timeline.querySelector(".zc-drop-preview")).toBeNull();
    await act(async () => nativeDrop({ type: "over", position: { ...position, y: 500 } }));
    expect(timeline.querySelector('[data-track-id="video_top"] .zc-drop-preview')).not.toBeNull();
    expect(timeline.querySelector<HTMLElement>(".zc-drop-line")?.style.left).toContain("96px");
    await act(async () => nativeDrop({ type: "over", position }));
    expect(timeline.querySelector(".zc-drop-new-track")?.textContent).toContain("00:00:02:00");
    await act(async () => nativeDrop({ type: "leave" }));
    expect(timeline.querySelector(".zc-drop-line")).toBeNull();
    await act(async () => nativeDrop({ type: "enter", position, paths }));
    expect(timeline.querySelector(".zc-drop-new-track .zc-drop-preview")).not.toBeNull();
    expect(timeline.querySelector(".zc-drop-line")).not.toBeNull();
    expect(h.call).not.toHaveBeenCalled();
    await act(async () => {
      nativeDrop({ type: "drop", position, paths });
      nativeDrop({ type: "drop", position, paths });
    });
    expect(h.call.mock.calls.filter(([verb]) => verb === "import_media").map(([, request]) => request.paths)).toEqual(
      paths.map((path) => [path]),
    );
    expect(h.call.mock.calls.filter(([verb]) => verb === "edit")).toHaveLength(1);
    const request = h.call.mock.lastCall?.[1];
    expect(request?.base_revision).toBe("rev_three");
    const [video, audio, first, second] = request?.ops as Record<string, unknown>[];
    expect(video).toMatchObject({ op: "add_track", kind: "video", index: 3 });
    expect(audio).toMatchObject({ op: "add_track", kind: "audio", index: 4 });
    expect(first).toMatchObject({
      op: "place",
      media_id: "med_ten",
      at: "2s",
      video_track: video?.id,
      audio_track: audio?.id,
    });
    expect(second).toMatchObject({
      op: "place",
      media_id: "med_two",
      at: "5s",
      video_track: video?.id,
      audio_track: audio?.id,
    });
    expect(timeline.querySelector('[role="alert"]')?.textContent).toBe("离线.mov：文件无法读取");
  } finally {
    await h.close();
  }
});

it("cancels a Finder landing when the project changes while importing", async () => {
  const h = await mount(true);
  try {
    dropGeometry(h.container);
    let complete: (value: unknown) => void = () => {};
    h.call.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    const drop = { position: { x: 236, y: 250 }, paths: ["/镜头.mov"] };
    await act(async () => {
      nativeDrop({ type: "enter", ...drop });
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true }));
      nativeDrop({ type: "drop", ...drop });
    });
    expect(h.call).not.toHaveBeenCalled();
    await act(async () => {
      nativeDrop({ type: "enter", ...drop });
      nativeDrop({ type: "leave" });
      nativeDrop({ type: "drop", ...drop });
    });
    expect(h.call).not.toHaveBeenCalled();
    await act(async () => {
      nativeDrop({ type: "enter", ...drop });
      nativeDrop({ type: "drop", ...drop });
    });
    expect(h.call).toHaveBeenCalledTimes(1);
    await h.change({ ...h.state(), project: "/另一个工程.zcut.json" });
    await act(async () => complete({ imported: [{ media_id: "med_imported" }] }));
    expect(h.call).toHaveBeenCalledTimes(1);
  } finally {
    await h.close();
  }
});
it("filters nested folders and tags, searches notes, and exposes list state", async () => {
  const h = await mount();
  try {
    const select = h.container.querySelector<HTMLSelectElement>('[aria-label="素材范围"]');
    if (!select) throw new Error("scope");
    for (const scope of ["folder:项目", "tag:采访"]) {
      await act(async () => {
        select.value = scope;
        select.dispatchEvent(new Event("change", { bubbles: true }));
      });
      expect(h.container.querySelectorAll(".zc-media-card")).toHaveLength(1);
    }
    await h.setInput("搜索素材内容", "原注释");
    expect(h.container.querySelectorAll(".zc-media-card")).toHaveLength(1);
    await h.click("列表");
    expect(h.state().sub).toBe("list");
    expect(h.container.querySelector(".zc-media-list")).not.toBeNull();
  } finally {
    await h.close();
  }
});
it("uses native multiple-file dialog, Finder reveal, and bounded file drops", async () => {
  native.open.mockResolvedValue(["/一.mov", "/二.wav"]);
  native.reveal.mockResolvedValue(undefined);
  const h = await mount(true);
  try {
    await h.click("导入素材");
    expect(native.open).toHaveBeenCalledWith({ multiple: true, directory: false });
    expect(h.call).toHaveBeenLastCalledWith("import_media", expect.objectContaining({ paths: ["/一.mov", "/二.wav"] }));
    await h.select();
    await h.click("在访达中显示");
    expect(native.reveal).toHaveBeenCalledWith(media.path);
    const area = h.container.querySelector<HTMLElement>(".zc-media-library");
    if (!area) throw new Error("area");
    vi.spyOn(area, "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, right: 200, bottom: 200 } as DOMRect);
    const count = h.call.mock.calls.length;
    await act(async () => {
      nativeDrop({ type: "drop", paths: ["/外.mov"], position: { x: 500, y: 500 } });
    });
    expect(h.call).toHaveBeenCalledTimes(count);
    await act(async () => {
      nativeDrop({ type: "drop", paths: ["/拖入.mov"], position: { x: 10, y: 10 } });
    });
    expect(h.call).toHaveBeenLastCalledWith("import_media", expect.objectContaining({ paths: ["/拖入.mov"] }));
  } finally {
    await h.close();
  }
});
it("keeps audio-only and image placement exact and uses a five second image default", () => {
  const state = initialState();
  const audio = placeMedia(project, { ...media, kind: "audio", duration: "1001/300s" }, state, "1s");
  expect(audio).toMatchObject({ op: { duration: "83/25s", audio_track: "audio_first" } });
  expect(audio).not.toHaveProperty("op.video_track");
  const { audio: _audio, ...silent } = media;
  const image = { ...silent, kind: "image", duration: "3600s" };
  expect(placeMedia(project, image, state, "0s")).toMatchObject({
    op: { duration: "5s", source_start: "0s", video_track: "video_top" },
  });
  expect(middle(image)).toBe("0s");
});

it("shows accepted import progress, prevents duplicate writes, and reports job failure", async () => {
  const h = await mount();
  try {
    let finish: (value: unknown) => void = () => {};
    h.call.mockImplementation(async (verb) =>
      verb === "import_media"
        ? { job_id: "job_test" }
        : new Promise((resolve) => {
            finish = resolve;
          }),
    );
    await h.click("导入素材");
    const input = await h.setInput("导入文件路径（逗号分隔）", "/长素材.mov");
    await act(async () => {
      input.blur();
    });
    expect(h.container.textContent).toContain("正在处理");
    expect(h.call).toHaveBeenLastCalledWith("job_status", { project: "/工程.zcut.json", job_id: "job_test" });
    await act(async () => {
      finish({ state: "failed", progress: 0.5 });
    });
    expect(h.container.querySelector('[role="alert"]')?.textContent).toContain("导入失败");
    expect(h.container.textContent).not.toContain("正在处理");
  } finally {
    await h.close();
  }
});

it("shows one scope count, placeholder fields, and collapsed add/import controls", async () => {
  const h = await mount();
  try {
    expect(h.container.querySelector('option[value="all"]')?.textContent).toBe("全部");
    expect(h.container.querySelector('[aria-label="筛选数量"]')?.textContent).toBe("2");
    expect(h.container.querySelector('input[aria-label="导入文件路径（逗号分隔）"]')).toBeNull();
    await h.select();
    expect(h.container.querySelector('input[placeholder="添加注释"]')).not.toBeNull();
    expect(h.container.querySelector('input[placeholder="http://"]')).not.toBeNull();
    expect(h.container.querySelector('input[aria-label="添加标签"]')).toBeNull();
    expect(h.container.querySelector('input[aria-label="添加文件夹"]')).toBeNull();
    expect([...h.container.querySelectorAll(".zc-media-group h4")].map((n) => n.textContent)).toEqual([
      "基本信息",
      "标签",
      "文件夹",
    ]);
    expect(h.container.querySelectorAll(".zc-stars button")).toHaveLength(5);
    await h.click("添加标签");
    expect(h.container.querySelector('input[placeholder="添加标签"]')).not.toBeNull();
  } finally {
    await h.close();
  }
});
it("renders nine swatches and copies the selected color, reporting clipboard failure", async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  const h = await mount(false, false, project, true);
  try {
    await h.select();
    expect(h.container.querySelectorAll(".zc-palette button")).toHaveLength(9);
    expect(h.container.querySelector(".zc-palette button")?.getAttribute("title")).toBe(palette[0]);
    await h.click(`复制色值 ${palette[0]}`);
    expect(writeText).toHaveBeenCalledWith(palette[0]);
    writeText.mockRejectedValueOnce(new Error("denied"));
    await h.click(`复制色值 ${palette[1]}`);
    expect(h.container.querySelector('[role="alert"]')?.textContent).toBe("无法复制色值");
  } finally {
    await h.close();
  }
});
it("formats card and list durations exactly at minute/hour boundaries", async () => {
  const durations = ["0s", "1799/30s", "60s", "3599999/1000s", "3600s", "3661s"];
  const view = { ...project, media: durations.map((duration, i) => ({ ...media, id: `duration_${i}`, duration })) };
  const h = await mount(false, false, view);
  try {
    const expected = ["0:00", "0:59", "1:00", "59:59", "1:00:00", "1:01:01"];
    expect([...h.container.querySelectorAll(".zc-media-duration")].map((n) => n.textContent)).toEqual(expected);
    expect(h.container.querySelector(".zc-media-caption")?.textContent).toBe("镜头.mov · 原注释");
    await h.click("列表");
    const rows = [...h.container.querySelectorAll(".zc-media-card")];
    expect(rows.map((n) => n.children[2]?.textContent)).toEqual(expected);
    expect(rows[0]?.children).toHaveLength(6);
  } finally {
    await h.close();
  }
});
it("renders cached peaks for audio cards and a single image thumbnail", async () => {
  const view = {
    ...project,
    media: [
      { ...media, id: "audio", kind: "audio", duration: "1001/30s" },
      { ...media, id: "image", kind: "image" },
    ],
  };
  const canvas = recordingCanvas();
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    left: 0,
    right: 240,
    width: 240,
    top: 0,
    bottom: 48,
    height: 48,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  });
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => canvas.context);
  const h = await mount(false, false, view, true);
  try {
    const cards = h.container.querySelectorAll(".zc-media-card");
    expect(cards[0]?.querySelector(".zc-wave canvas")).not.toBeNull();
    expect(canvas.calls.some((call) => call[0] === "fillRect" && call[4] === 26)).toBe(true);
    expect(cards[0]?.querySelector(".zc-media-used .zc-icon path")?.getAttribute("d")).toContain("M4 9.5");
    expect(fetch).toHaveBeenCalledWith(expect.stringContaining("/media-cache/audio"));
    expect(cards[1]?.querySelectorAll("img")).toHaveLength(1);
    expect(cards[1]?.querySelector("img")?.getAttribute("src")).toContain("/thumb?token=test&media_id=image&at=0s");
  } finally {
    await h.close();
  }
});

it.each(["audio", "image", "video"])("shows only applicable media metadata for %s", async (kind) => {
  const view = { ...project, media: [{ ...media, kind }] };
  const ui = await mount(false, false, view);
  try {
    await ui.select();
    const labels = [...ui.container.querySelectorAll(".zc-media-info dt")].map((node) => node.textContent);
    if (kind === "audio") {
      expect(labels).toContain("采样率");
      expect(labels).toContain("声道");
      expect(labels).not.toContain("尺寸");
      expect(labels).not.toContain("帧率");
      expect(ui.container.querySelector(".zc-media-info")?.textContent).toContain("48000 Hz");
    } else {
      expect(labels).toContain("尺寸");
      expect(labels.includes("帧率")).toBe(kind === "video");
    }
    expect(labels.includes("时长")).toBe(kind !== "image");
    expect(labels.includes("选中范围")).toBe(kind !== "image");
    expect(Boolean(ui.container.querySelector(".zc-media-duration"))).toBe(kind !== "image");
  } finally {
    await ui.close();
  }
});

async function scope(h: Awaited<ReturnType<typeof mount>>, value: string) {
  const select = h.container.querySelector<HTMLSelectElement>('[aria-label="素材范围"]');
  if (!select) throw new Error("scope");
  await act(async () => {
    select.value = value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}
async function addFolder(h: Awaited<ReturnType<typeof mount>>, folder: string) {
  await h.click("添加文件夹");
  const input = await h.setInput("添加文件夹", folder);
  await act(async () => {
    input.blur();
  });
}
it("lists all folders in hierarchy order and filters descendants in grid and list", async () => {
  const view = {
    ...project,
    media: [
      { ...media, organize: { folders: ["A/child/deep", "A-other", "A/child"] } },
      { ...media, id: "med_two", organize: { folders: ["A/sibling"] } },
      { ...media, id: "med_three", organize: {} },
    ],
  };
  const h = await mount(false, false, view);
  try {
    const options = [...h.container.querySelectorAll('select[aria-label="素材范围"] option')];
    expect(options.map((node) => [node.getAttribute("value"), node.textContent])).toEqual([
      ["all", "全部"],
      ["folder:A", "A"],
      ["folder:A/child", "　child"],
      ["folder:A/child/deep", "　　deep"],
      ["folder:A/sibling", "　sibling"],
      ["folder:A-other", "A-other"],
    ]);
    await scope(h, "folder:A");
    expect(h.container.querySelectorAll(".zc-media-card")).toHaveLength(2);
    await h.click("列表");
    await scope(h, "folder:A/child");
    expect(h.container.querySelectorAll(".zc-media-list .zc-media-card")).toHaveLength(1);
    await scope(h, "folder:A-other");
    expect(h.container.querySelectorAll(".zc-media-card")).toHaveLength(1);
    await scope(h, "all");
    expect(h.container.querySelectorAll(".zc-media-card")).toHaveLength(3);
  } finally {
    await h.close();
  }
});
it("offers existing folders and links successful whole-field writes to tags, dropdown, and filtering", async () => {
  const h = await mount();
  try {
    await h.select();
    await h.click("添加文件夹");
    const input = h.container.querySelector<HTMLInputElement>('input[aria-label="添加文件夹"]');
    expect(input?.getAttribute("list")).toBe(h.container.querySelector("datalist")?.id);
    expect([...h.container.querySelectorAll("datalist option")].map((node) => node.getAttribute("value"))).toEqual([
      "项目",
      "项目/原始",
    ]);
    await h.setInput("添加文件夹", "新项目/精选");
    await act(async () => {
      input?.blur();
    });
    expect(h.call).toHaveBeenLastCalledWith(
      "edit",
      expect.objectContaining({
        project: "/工程.zcut.json",
        base_revision: "rev_one",
        idempotency_key: expect.any(String),
        author: { kind: "human", name: "桌面用户" },
        label: "修改 镜头.mov 的文件夹",
        ops: [{ op: "update_media", media_id: "med_one", folders: ["项目/原始", "新项目/精选"] }],
      }),
    );
    expect(h.container.querySelector('option[value="folder:新项目/精选"]')).not.toBeNull();
    expect(h.container.querySelector('[aria-label="删除文件夹 新项目/精选"]')).not.toBeNull();
    await scope(h, "folder:新项目");
    await h.click("删除文件夹 新项目/精选");
    expect(h.container.querySelector<HTMLSelectElement>('[aria-label="素材范围"]')?.value).toBe("folder:新项目");
    expect(h.container.querySelector('option[value="folder:新项目"]')?.textContent).toBe("新项目（空）");
    expect(h.call).toHaveBeenLastCalledWith(
      "edit",
      expect.objectContaining({ ops: [{ op: "update_media", media_id: "med_one", folders: ["项目/原始"] }] }),
    );
    expect(h.container.querySelectorAll(".zc-media-card")).toHaveLength(0);
    await scope(h, "all");
    expect(h.container.querySelectorAll(".zc-media-card")).toHaveLength(2);
    await addFolder(h, "项目/原始");
    expect(h.call).toHaveBeenLastCalledWith(
      "edit",
      expect.objectContaining({ ops: [{ op: "update_media", media_id: "med_one", folders: ["项目/原始"] }] }),
    );
    await h.refresh({
      ...project,
      revision: { id: "rev_two", seq: 2 },
      media: [{ ...media, organize: { folders: ["远端"] } }],
    });
    expect(h.container.querySelector('[aria-label="删除文件夹 远端"]')).not.toBeNull();
    expect(h.container.querySelector('[aria-label="删除文件夹 项目/原始"]')).toBeNull();
  } finally {
    await h.close();
  }
});
it("keeps folders and filtered media on failed edits, shows errors, and prevents duplicate writes", async () => {
  const h = await mount();
  try {
    await h.select();
    await scope(h, "folder:项目");
    let reject: (error: Error) => void = () => {};
    h.call.mockImplementationOnce(
      () =>
        new Promise((_resolve, fail) => {
          reject = fail;
        }),
    );
    await h.click("删除文件夹 项目/原始");
    expect(h.container.querySelector<HTMLButtonElement>('[aria-label="删除文件夹 项目/原始"]')?.disabled).toBe(true);
    await h.click("删除文件夹 项目/原始");
    expect(h.call).toHaveBeenCalledTimes(1);
    await act(async () => {
      reject(new Error("修订冲突"));
    });
    expect(h.container.querySelector('[role="alert"]')?.textContent).toBe("修订冲突");
    expect(h.container.querySelectorAll(".zc-media-card")).toHaveLength(1);
    expect(h.container.querySelector('[aria-label="删除文件夹 项目/原始"]')).not.toBeNull();
    h.call.mockRejectedValueOnce(new Error("写入失败"));
    await addFolder(h, "失败文件夹");
    expect(h.container.querySelector('option[value="folder:失败文件夹"]')).toBeNull();
    expect(h.container.querySelector('[aria-label="删除文件夹 失败文件夹"]')).toBeNull();
    expect(h.container.querySelector('[role="alert"]')?.textContent).toBe("写入失败");
  } finally {
    await h.close();
  }
});
it("adds and removes folders for every selected media in one edit while preserving individual folders", async () => {
  const view = {
    ...project,
    media: [media, { ...media, id: "med_two", name: "风景.mov", organize: { folders: ["其他"] } }],
  };
  const h = await mount(false, false, view);
  try {
    await h.select();
    await act(async () => {
      h.container
        .querySelectorAll(".zc-media-card")[1]
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true, metaKey: true }));
    });
    expect(h.state().selected).toEqual(["med_one", "med_two"]);
    expect(h.container.querySelectorAll('.zc-media-card[aria-pressed="true"]')).toHaveLength(2);
    expect(h.container.querySelector('[aria-label="删除文件夹 项目/原始"]')).not.toBeNull();
    h.call.mockRejectedValueOnce(new Error("批量失败"));
    await addFolder(h, "失败目录");
    expect(h.container.querySelector('[role="alert"]')?.textContent).toBe("批量失败");
    expect(h.container.querySelector('option[value="folder:失败目录"]')).toBeNull();
    expect(h.container.querySelector('[aria-label="删除文件夹 项目/原始"]')).not.toBeNull();
    expect(h.container.querySelector('[aria-label="删除文件夹 其他"]')).not.toBeNull();
    await addFolder(h, "共同/精选");
    expect(h.call).toHaveBeenLastCalledWith(
      "edit",
      expect.objectContaining({
        label: "修改 2 个素材 的文件夹",
        author: { kind: "human", name: "桌面用户" },
        ops: [
          { op: "update_media", media_id: "med_one", folders: ["项目/原始", "共同/精选"] },
          { op: "update_media", media_id: "med_two", folders: ["其他", "共同/精选"] },
        ],
      }),
    );
    await scope(h, "folder:共同");
    await h.click("删除文件夹 共同/精选");
    expect(h.call).toHaveBeenLastCalledWith(
      "edit",
      expect.objectContaining({
        ops: [
          { op: "update_media", media_id: "med_one", folders: ["项目/原始"] },
          { op: "update_media", media_id: "med_two", folders: ["其他"] },
        ],
      }),
    );
    expect(h.container.querySelectorAll(".zc-media-card")).toHaveLength(0);
    await scope(h, "all");
    await act(async () => {
      h.container
        .querySelectorAll(".zc-media-card")[1]
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true, ctrlKey: true }));
    });
    expect(h.state().selected).toEqual(["med_one"]);
    await addFolder(h, "单选");
    expect(h.call).toHaveBeenLastCalledWith(
      "edit",
      expect.objectContaining({ ops: [{ op: "update_media", media_id: "med_one", folders: ["项目/原始", "单选"] }] }),
    );
  } finally {
    await h.close();
  }
});

function skimImages() {
  const images: HTMLImageElement[] = [];
  vi.stubGlobal("Image", function MockImage() {
    const image = document.createElement("img");
    images.push(image);
    return image;
  });
  return images;
}
async function moveSkim(container: HTMLElement, x: number) {
  const film = container.querySelector<HTMLElement>(".zc-media-film");
  if (!film) throw new Error("Missing film");
  vi.spyOn(film, "getBoundingClientRect").mockReturnValue({ left: 10, width: 200 } as DOMRect);
  await act(async () => {
    film.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, clientX: 10 + x }));
  });
}
it.each([
  ["25", "10s", "5s", "249/25s"],
  ["30000/1001", "1001/100s", "1001/200s", "299299/30000s"],
  ["30000/1001", "10s", "149149/30000s", "299299/30000s"],
])("maps hover to the %s source frame grid and clamps the right edge", async (rate, duration, midpoint, last) => {
  const images = skimImages();
  const h = await mount(
    false,
    false,
    { ...project, media: [{ ...media, duration, video: { ...media.video, rate } }] },
    true,
  );
  vi.useFakeTimers();
  try {
    await h.change({ ...h.state(), selected: [media.id], media: { id: media.id, at: "3s", in: "1s", out: "7s" } });
    const before = h.state();
    await moveSkim(h.container, 100);
    expect(new URL(images[0]?.src ?? "").searchParams.get("at")).toBe(midpoint);
    await act(async () => images[0]?.dispatchEvent(new Event("load")));
    expect(h.container.querySelector(".zc-media-skim-frame")).not.toBeNull();
    expect(h.state()).toEqual(before);
    expect(h.call).not.toHaveBeenCalled();
    await moveSkim(h.container, 250);
    await act(async () => vi.advanceTimersByTime(80));
    expect(new URL(images[1]?.src ?? "").searchParams.get("at")).toBe(last);
    await act(async () =>
      h.container.querySelector(".zc-media-film")?.dispatchEvent(new MouseEvent("pointerout", { bubbles: true })),
    );
    expect(h.container.querySelector(".zc-media-skim-frame")).toBeNull();
    expect(h.container.querySelector(".zc-media-skim-line")).toBeNull();
    expect(h.container.querySelectorAll(".zc-media-film > img")).toHaveLength(1);
    await h.select();
    expect(h.state().selected).toEqual([media.id]);
  } finally {
    await h.close();
    vi.useRealTimers();
  }
});
it("throttles, dedupes frames, discards stale loads, keeps cover on failure and cancels on unmount", async () => {
  const images = skimImages();
  const h = await mount(false, false, project, true);
  vi.useFakeTimers();
  try {
    await moveSkim(h.container, 20);
    const staleLoad = images[0]?.onload;
    await moveSkim(h.container, 20.1);
    await moveSkim(h.container, 40);
    expect(images).toHaveLength(1);
    await act(async () => images[0] && staleLoad?.call(images[0], new Event("load")));
    expect(h.container.querySelector(".zc-media-skim-frame")).toBeNull();
    await act(async () => vi.advanceTimersByTime(80));
    expect(images).toHaveLength(2);
    expect(new URL(images[1]?.src ?? "").searchParams.get("at")).toBe("2s");
    await act(async () => images[1]?.dispatchEvent(new Event("load")));
    const current = h.container.querySelector<HTMLImageElement>(".zc-media-skim-frame")?.src;
    await act(async () => images[0] && staleLoad?.call(images[0], new Event("load")));
    expect(h.container.querySelector<HTMLImageElement>(".zc-media-skim-frame")?.src).toBe(current);
    await moveSkim(h.container, 40.1);
    await act(async () => vi.advanceTimersByTime(80));
    expect(images).toHaveLength(2);
    await moveSkim(h.container, 60);
    await act(async () => images[2]?.dispatchEvent(new Event("error")));
    expect(h.container.querySelector(".zc-media-skim-frame")).toBeNull();
    await moveSkim(h.container, 80);
    const late = images[2]?.onload;
    await act(async () =>
      h.container.querySelector(".zc-media-film")?.dispatchEvent(new MouseEvent("pointerout", { bubbles: true })),
    );
    await act(async () => {
      images[2] && late?.call(images[2], new Event("load"));
      vi.advanceTimersByTime(160);
    });
    expect(images).toHaveLength(3);
    expect(h.container.querySelector(".zc-media-skim-frame")).toBeNull();
    await moveSkim(h.container, 100);
    await moveSkim(h.container, 120);
    await h.close();
    await act(async () => vi.advanceTimersByTime(160));
    expect(images).toHaveLength(4);
    expect(images[3]?.getAttribute("src")).toBeNull();
  } finally {
    if (h.container.isConnected) await h.close();
    vi.useRealTimers();
  }
});
it("does not scrub list, image or audio cards and clears skimming on pointer capture", async () => {
  const images = skimImages();
  const h = await mount(
    false,
    false,
    { ...project, media: [media, { ...media, id: "image", kind: "image" }, { ...media, id: "audio", kind: "audio" }] },
    true,
  );
  try {
    const films = h.container.querySelectorAll(".zc-media-film");
    await act(async () => {
      for (const film of [...films].slice(1))
        film.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, clientX: 50 }));
    });
    expect(images).toHaveLength(0);
    await moveSkim(h.container, 100);
    const film = films[0];
    if (!film) throw new Error("missing film");
    expect(h.container.querySelector(".zc-media-skim-line")).not.toBeNull();
    await pointer(film, "pointerdown", { clientX: 100 });
    await pointer(film, "pointermove", { clientX: 104 });
    expect(h.container.querySelector(".zc-media-skim-line")).not.toBeNull();
    Object.assign(film, {
      setPointerCapture: () => film.dispatchEvent(new Event("gotpointercapture", { bubbles: true })),
    });
    await pointer(film, "pointermove", { clientX: 105 });
    expect(h.container.querySelector(".zc-media-skim-line")).toBeNull();
    await pointer(film, "pointercancel");
    await h.click("列表");
    expect(h.container.querySelector(".zc-media-film")).toBeNull();
    expect(images).toHaveLength(1);
  } finally {
    await h.close();
  }
});

it("keeps search and view controls visible above the media grid with scoped information fields", async () => {
  const h = await mount();
  expect(h.container.querySelector(".zc-panel-body.zc-media-library .zc-search input")).not.toBeNull();
  expect(h.container.querySelectorAll(".zc-media-head .zc-seg button")).toHaveLength(2);
  expect(h.container.querySelector(".zc-media-drop")?.textContent).toContain("拖到这里");
  await h.select();
  expect(h.container.querySelector(".zc-media-info.zc-panel-body .zc-field input[aria-label='注释']")).not.toBeNull();
  await h.close();
});
