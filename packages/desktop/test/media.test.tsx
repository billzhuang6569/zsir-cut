// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { UiState } from "../../app-host/src/ui.js";
import type { ProjectView } from "../src/connection.js";
import { useMediaPanel } from "../src/MediaPanel.js";
import { middle, placeMedia, sourceProject } from "../src/media.js";
import { initialState } from "../src/state.js";
import { TimelinePreview } from "../src/TimelinePreview.js";

const native = vi.hoisted(() => ({
  enabled: false,
  open: vi.fn(),
  reveal: vi.fn(),
  drop: undefined as
    | ((event: { payload: { type: string; paths: string[]; position: { x: number; y: number } } }) => void)
    | undefined,
  stop: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => native.enabled }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: native.open }));
vi.mock("@tauri-apps/plugin-opener", () => ({ revealItemInDir: native.reveal }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    onDragDropEvent: async (handler: typeof native.drop) => {
      native.drop = handler;
      return native.stop;
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
async function mount(nativeMode = false, preview = false, view = project, withConfig = false) {
  native.enabled = nativeMode;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => ({
      ok: true,
      json: async () => (url.includes("/peaks?") ? [0.25, 0.75, 1] : palette),
    })),
  );
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  const call = vi.fn(async (_verb: string, _request: Record<string, unknown>): Promise<unknown> => ({}));
  let state: UiState = { ...initialState(), panel: "media", project: "/工程.zcut.json", playhead: { at: "4s" } };
  let change: (next: UiState) => void = () => {};
  function Harness() {
    const [ui, update] = useState(state);
    state = ui;
    change = update;
    const panel = useMediaPanel({ project: view, state: ui, update, call, config: withConfig ? config : undefined });
    const source = preview && ui.preview === "media" && panel.selected ? sourceProject(project, panel.selected) : null;
    return (
      <>
        {panel.library}
        {panel.parameters}
        <output aria-label="当前状态">{JSON.stringify(ui)}</output>
        <TimelinePreview
          project={source ?? project}
          viewerOnly={Boolean(source)}
          state={source ? { ...ui, playhead: { at: ui.media?.at ?? "0s" } } : ui}
          update={(next) =>
            update(
              source && ui.media
                ? { ...ui, media: { ...ui.media, at: "at" in next.playhead ? next.playhead.at : "0s" } }
                : next,
            )
          }
          config={undefined}
          error={null}
          dragging={{ current: false }}
          call={call}
          onMediaDrop={(id, at, track) =>
            panel.place(
              project.media.find((m) => m.id === id),
              at,
              track,
            )
          }
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
      expect.objectContaining({ ops: [{ op: "update_media", media_id: media.id, folders: [] }] }),
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
it("sets I/O in source time, Q inserts at the timeline head, and source preview shows the source timecode", async () => {
  const h = await mount(false, true);
  try {
    await h.select();
    expect(h.container.querySelector('[aria-label="素材预览"]')).not.toBeNull();
    await h.change({ ...h.state(), media: { id: media.id, at: "2s", in: null, out: null } });
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "i" }));
    });
    await h.change({ ...h.state(), media: { id: media.id, in: h.state().media?.in ?? null, out: null, at: "5s" } });
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "o" }));
    });
    expect(h.container.querySelector('[aria-label="播放时码"]')?.textContent).toBe("01:00:05:00");
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "q" }));
    });
    expect(h.call).toHaveBeenLastCalledWith(
      "edit",
      expect.objectContaining({
        label: "把 镜头.mov 加到时间线",
        ops: [
          {
            op: "place",
            media_id: media.id,
            source_start: "2s",
            duration: "3s",
            at: "4s",
            mode: "insert",
            video_track: "video_top",
            audio_track: "audio_first",
          },
        ],
      }),
    );
  } finally {
    await h.close();
  }
});
it("drops overwrite on the requested track with the existing 8px snap", async () => {
  const h = await mount();
  try {
    await h.select();
    const lane = h.container.querySelector<HTMLElement>('[aria-label="视频 B 放置区域"]');
    if (!lane) throw new Error("lane");
    const dataTransfer = { types: ["application/x-zcut-media"], getData: () => media.id, dropEffect: "" };
    for (const type of ["dragover", "drop"]) {
      const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: 100 });
      Object.defineProperty(event, "dataTransfer", { value: dataTransfer });
      await act(async () => {
        lane.dispatchEvent(event);
      });
      if (type === "dragover") expect(lane.querySelector<HTMLElement>(".zc-drop-preview")?.style.left).toBe("96px");
    }
    expect(h.call).toHaveBeenLastCalledWith(
      "edit",
      expect.objectContaining({
        ops: [expect.objectContaining({ mode: "overwrite", at: "2s", video_track: "video_lower" })],
      }),
    );
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
    await h.click("搜索素材");
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
      native.drop?.({ payload: { type: "drop", paths: ["/外.mov"], position: { x: 500, y: 500 } } });
    });
    expect(h.call).toHaveBeenCalledTimes(count);
    await act(async () => {
      native.drop?.({ payload: { type: "drop", paths: ["/拖入.mov"], position: { x: 10, y: 10 } } });
    });
    expect(h.call).toHaveBeenLastCalledWith("import_media", expect.objectContaining({ paths: ["/拖入.mov"] }));
  } finally {
    await h.close();
  }
});
it("keeps audio-only and image placement exact and uses a five second image default", () => {
  const state = initialState();
  const audio = placeMedia(project, { ...media, kind: "audio", duration: "1001/30000s" }, state, "1s");
  expect(audio).toMatchObject({ duration: "1001/30000s", audio_track: "audio_first" });
  expect(audio).not.toHaveProperty("video_track");
  const { audio: _audio, ...silent } = media;
  const image = { ...silent, kind: "image", duration: "3600s" };
  expect(placeMedia(project, image, state, "0s")).toMatchObject({
    duration: "5s",
    source_start: "0s",
    video_track: "video_top",
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
      "标签",
      "文件夹",
      "基本信息",
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
  const h = await mount(false, false, view, true);
  try {
    const cards = h.container.querySelectorAll(".zc-media-card");
    expect(cards[0]?.querySelector(".zc-wave rect")?.getAttribute("height")).toBe("6.5");
    expect(cards[0]?.querySelector(".zc-media-used .zc-icon path")?.getAttribute("d")).toContain("M2 6");
    expect(fetch).toHaveBeenCalledWith(expect.stringContaining("/peaks?token=test&media_id=audio"), expect.anything());
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
