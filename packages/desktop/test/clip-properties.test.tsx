// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ClipInspector } from "../src/ClipInspector.js";
import { ClipMenu } from "../src/ClipMenu.js";
import { clipRateChange, currentClipRate, type GainPreview } from "../src/clipProperties.js";
import type { ProjectView } from "../src/connection.js";
import type { ClipView } from "../src/timeline.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const video: ClipView = {
  id: "video",
  media_id: "source",
  occurrence_id: "pair",
  label: null,
  enabled: true,
  speed: "1",
  timeline_in: { t: "1s" },
  timeline_out: { t: "51/25s" },
  source_in: { t: "2s" },
  source_out: { t: "76/25s" },
};
const audio = { ...video, id: "audio" };
const project: ProjectView = {
  id: "timeline",
  name: "测试",
  revision: { id: "revision", seq: 0 },
  edit_rate: "25",
  start_timecode: "01:00:00:00",
  drop_frame: false,
  duration: video.timeline_out,
  cues: [],
  markers: [],
  styles: [],
  media: [{ id: "source", kind: "video", name: "素材", duration: "5s" }],
  tracks: [
    { id: "v", name: "视频 A", kind: "video", enabled: true, clips: [video] },
    { id: "a", name: "声音 A", kind: "audio", enabled: true, clips: [audio, { ...audio, id: "audio2" }] },
  ],
  clipProperties: { video: { transform: { scale: 2, position: [3, 4], crop: { left: 0.1 } } } },
};

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let trigger: HTMLButtonElement;
const edit = vi.fn();
const inspect = vi.fn();
const copy = vi.fn();
const preview = vi.fn();

beforeEach(() => {
  host = document.createElement("div");
  trigger = document.createElement("button");
  document.body.append(host, trigger);
  root = createRoot(host);
  vi.stubGlobal("navigator", Object.assign(Object.create(navigator), { clipboard: { writeText: copy } }));
  vi.clearAllMocks();
});

afterEach(async () => {
  await act(() => root.unmount());
  host.remove();
  trigger.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function mountMenu(view = project, ids = ["video", "audio"], blocked?: string, x = 20, y = 30) {
  function Menu() {
    const [open, setOpen] = useState(true);
    return (
      open && (
        <ClipMenu
          anchor={{ element: trigger, x, y }}
          project={view}
          ids={ids}
          keymap={{ lift_delete: "⇧Delete", ripple_delete: "Delete" }}
          blocked={blocked}
          edit={edit}
          inspect={inspect}
          close={() => setOpen(false)}
          copyError={vi.fn()}
        />
      )
    );
  }
  return act(() => root.render(<Menu />));
}

function mountInspector(ids: string[], blocked?: string, view = project) {
  function Inspector() {
    const [value, setValue] = useState<GainPreview | null>(null);
    const [previewGain] = useState(() => (next: GainPreview | null) => {
      preview(next);
      setValue(next);
    });
    return (
      <ClipInspector
        project={view}
        ids={ids}
        blocked={blocked}
        gainPreview={value}
        previewGain={previewGain}
        edit={edit}
      />
    );
  }
  return act(() => root.render(<Inspector />));
}

function required<T>(element: T | null | undefined, label: string): T {
  if (element == null) throw new Error(`Missing ${label}`);
  return element;
}
const button = (label: string) =>
  required(
    [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((item) =>
      item.textContent?.startsWith(label),
    ),
    label,
  );
const field = (label: string) =>
  required(
    [...host.querySelectorAll("label")].find((item) => item.textContent?.startsWith(label))?.querySelector("input"),
    label,
  );
const click = (element: HTMLElement) => act(() => element.click());
const key = (element: Element, name: string) =>
  act(() => {
    element.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true }));
  });
function input(element: HTMLInputElement, value: string) {
  return act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  });
}
async function save(label: string, value: string) {
  const element = field(label);
  await act(() => element.focus());
  await input(element, value);
  await key(element, "Enter");
}

it.each([
  ["删除留空隙", [{ op: "remove", clip_ids: ["video", "audio"] }]],
  ["删除并合拢", [{ op: "remove", clip_ids: ["video", "audio"], ripple: true }]],
  [
    "停用片段",
    [
      { op: "set_clip", clip_id: "video", enabled: false },
      { op: "set_clip", clip_id: "audio", enabled: false },
    ],
  ],
  [
    "允许音画不同步",
    [
      { op: "set_clip", clip_id: "video", sync_broken: true },
      { op: "set_clip", clip_id: "audio", sync_broken: true },
    ],
  ],
])("%s creates one edit for the selection", async (label, ops) => {
  await mountMenu();
  await click(button(label));
  expect(edit).toHaveBeenCalledExactlyOnceWith(label, ops);
  expect(document.querySelector('[role="menu"]')).toBeNull();
  expect(document.activeElement).toBe(trigger);
});

it("re-enables a disabled clip and can restore synchronization checking", async () => {
  const disabled = { ...video, enabled: false };
  await mountMenu(
    {
      ...project,
      tracks: project.tracks.map((track) => (track.kind === "video" ? { ...track, clips: [disabled] } : track)),
    },
    ["video"],
  );
  await click(button("启用片段"));
  expect(edit).toHaveBeenLastCalledWith("启用片段", [{ op: "set_clip", clip_id: "video", enabled: true }]);
  await mountMenu({ ...project, clipProperties: { video: { sync_broken: true } } }, ["video"]);
  await click(button("检查音画同步"));
  expect(edit).toHaveBeenLastCalledWith("检查音画同步", [{ op: "set_clip", clip_id: "video", sync_broken: null }]);
});

it("copies every selected timeline timecode and opens the inspector", async () => {
  await mountMenu();
  await click(button("复制时码"));
  expect(copy).toHaveBeenCalledWith("01:00:01:00\n01:00:01:00");
  await mountMenu();
  await click(button("在属性里编辑"));
  expect(inspect).toHaveBeenCalledOnce();
  expect(edit).not.toHaveBeenCalled();
});

it("shows configured keys, flips at the edges, moves focus, and dismisses on Escape or outside", async () => {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ width: 160, height: 100 } as DOMRect);
  await mountMenu(project, ["video"], undefined, innerWidth - 5, innerHeight - 5);
  const menu = required(document.querySelector<HTMLElement>('[role="menu"]'), "menu");
  expect(menu.style.left).toBe(`${innerWidth - 165}px`);
  expect(menu.style.top).toBe(`${innerHeight - 105}px`);
  const lift = button("删除留空隙");
  expect(lift.querySelector("kbd")?.textContent).toBe("⇧⌫");
  expect(document.activeElement).toBe(lift);
  await key(lift, "ArrowDown");
  const ripple = button("删除并合拢");
  expect(document.activeElement).toBe(ripple);
  await key(ripple, "Escape");
  expect(document.activeElement).toBe(trigger);
  expect(menu.isConnected).toBe(false);

  await mountMenu();
  await act(() => trigger.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true })));
  expect(document.querySelector('[role="menu"]')).toBeNull();
  await mountMenu();
  await key(button("删除留空隙"), "Backspace");
  expect(edit).toHaveBeenCalledExactlyOnceWith("删除并合拢", [
    { op: "remove", clip_ids: ["video", "audio"], ripple: true },
  ]);
});

it("disables writes with a reason in a read-only view", async () => {
  const reason = "返回当前工程后编辑片段";
  await mountMenu(project, ["video"], reason);
  const item = button("删除并合拢");
  expect(item.getAttribute("aria-disabled")).toBe("true");
  expect(item.textContent).toContain(reason);
  await click(item);
  await mountInspector(["audio"], reason);
  expect(field("名字").disabled).toBe(true);
  expect(field("倍速").disabled).toBe(true);
  expect(field("启用").disabled).toBe(true);
  expect(edit).not.toHaveBeenCalled();
});

it("previews a multi-clip slider change and commits once on release", async () => {
  await mountInspector(["audio", "audio2"]);
  const slider = required(host.querySelector<HTMLInputElement>('input[type="range"]'), "gain slider");
  expect(host.textContent).not.toContain("名字");
  expect(host.textContent).not.toContain("位置大小");
  await input(slider, "-5");
  await input(slider, "-6");
  expect(preview).toHaveBeenLastCalledWith({ ids: ["audio", "audio2"], db: -6 });
  expect(field("音量").value).toBe("-6");
  expect(edit).not.toHaveBeenCalled();
  await act(() => {
    slider.dispatchEvent(new MouseEvent("pointerup", { bubbles: true }));
    slider.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
  });
  expect(edit).toHaveBeenCalledExactlyOnceWith("把片段音量改成 -6 dB", [
    { op: "set_clip", clip_id: "audio", gain_db: -6 },
    { op: "set_clip", clip_id: "audio2", gain_db: -6 },
  ]);
});

it("writes name, enabled, numeric gain, and rational speed changes", async () => {
  await mountInspector(["audio"]);
  await save("名字", "旁白");
  expect(edit).toHaveBeenLastCalledWith("重命名片段", [{ op: "set_clip", clip_id: "audio", label: "旁白" }]);
  await click(field("启用"));
  expect(edit).toHaveBeenLastCalledWith("停用片段", [{ op: "set_clip", clip_id: "audio", enabled: false }]);
  await save("音量", "12");
  expect(edit).toHaveBeenLastCalledWith("把片段音量改成 12 dB", [{ op: "set_clip", clip_id: "audio", gain_db: 12 }]);
  await save("倍速", "1.25");
  expect(edit).toHaveBeenLastCalledWith("把片段倍速改成 1.25", [
    {
      op: "set_clip",
      clip_id: "audio",
      time_map: [
        { at: "0s", source: "2s", interp: "linear" },
        { at: "26/25s", source: "33/10s", interp: "linear" },
      ],
    },
  ]);
  await save("倍速", "4");
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("没有足够素材");
  expect(edit).toHaveBeenCalledTimes(4);
});

it("preserves transform fields and supports exact reverse or clearing a constant map", async () => {
  await mountInspector(["video"]);
  await save("横向位置", "-2");
  expect(edit).toHaveBeenCalledExactlyOnceWith("调整片段横向位置", [
    {
      op: "set_clip",
      clip_id: "video",
      transform: { scale: 2, position: [-2, 4], crop: { left: 0.1 } },
    },
  ]);
  expect(clipRateChange(video, "-3/2", "5s").time_map?.at(-1)).toMatchObject({ at: "26/25s", source: "11/25s" });
  expect(clipRateChange(video, "1.00", "5s").time_map).toBeNull();
});

it("recognizes a constant map with extra linear points and lets the user clear a 1× map", async () => {
  const time_map = [
    { at: { t: "1s" }, source: { t: "2s" }, interp: "linear" },
    { at: { t: "38/25s" }, source: { t: "63/25s" }, interp: "linear" },
    { at: { t: "51/25s" }, source: { t: "76/25s" }, interp: "linear" },
  ];
  const mapped = { ...video, speed: "map", time_map };
  expect(currentClipRate(mapped)).toBe("1");
  await mountInspector(["video"], undefined, {
    ...project,
    tracks: project.tracks.map((track) => (track.kind === "video" ? { ...track, clips: [mapped] } : track)),
  });
  await save("倍速", "1.0");
  expect(edit).toHaveBeenCalledExactlyOnceWith("把片段倍速改成 1.0", [
    { op: "set_clip", clip_id: "video", time_map: null },
  ]);
});
