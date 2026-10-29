// @vitest-environment jsdom
import { isTauri } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { UiState } from "../../app-host/src/ui.js";
import type { ProjectView } from "../src/connection.js";
import { ExportPanel } from "../src/ExportPanel.js";
import { applyUi, initialState } from "../src/state.js";

vi.mock("@tauri-apps/api/core", () => ({ isTauri: vi.fn(() => false) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ revealItemInDir: vi.fn(async () => {}) }));
const project: ProjectView = {
  id: "tl_main",
  name: "工程",
  revision: { id: "rev_1", seq: 1 },
  edit_rate: "30000/1001",
  start_timecode: "01:00:00:00",
  drop_frame: false,
  duration: { t: "1001/100s" },
  tracks: [],
  media: [],
  cues: [],
  styles: [],
  markers: [],
  format: { width: 1920, height: 1080 },
  subtitleTracks: [{ id: "trk_sub", name: "中文字幕", default_style_id: "sty_default" }],
  subtitleOverlays: [
    {
      id: "ovl_one",
      name: "中文字幕层",
      timeline_id: "tl_main",
      subtitle_track_id: "trk_sub",
      tail: "10s",
      output_path: "/tmp/字幕.mov",
      last_export: null,
    },
  ],
};
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
  vi.restoreAllMocks();
  vi.mocked(isTauri).mockReturnValue(false);
});
const done = {
  state: "succeeded",
  progress: 1,
  envelope: { ok: true, result: { files: [{ name: "主时间线_r1.srt" }] } },
};
async function mount(options: { losses?: string; polling?: boolean; fail?: boolean } = {}) {
  let poll = 0;
  const call = vi.fn(async (verb: string, request: Record<string, unknown>): Promise<unknown> => {
    if (verb === "export_preferences")
      return request.value ?? { fcp: "/tmp/交接", resolve: "/tmp/交接", premiere: "/tmp/交接", direct: "/tmp/直接" };
    if (verb === "export")
      return request.dry_run
        ? { items: options.losses ? [{ severity: options.losses, consequence: "变速需要近似" }] : [] }
        : { job_id: "job_one" };
    if (verb === "job_status") {
      if (options.fail) return { state: "failed", progress: 1, envelope: { ok: false, error: { message: "失败" } } };
      if (options.polling && poll++ === 0) return { state: "running", progress: 0.4, envelope: null };
      return done;
    }
    return {};
  });
  let state: UiState = applyUi({ ...initialState(), project: "/tmp/工程.zcut.json" }, "ui_show_panel", {
    panel: "export",
    sub: "direct",
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  function Harness() {
    const [ui, update] = useState(state);
    state = ui;
    return (
      <ExportPanel
        project={project}
        state={ui}
        update={update}
        call={call}
        config={undefined}
        fcpIcon="data:image/png;base64,a"
      />
    );
  }
  await act(async () => root.render(<Harness />));
  cleanup.push(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  const click = async (label: string) => {
    const button = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (b) => b.getAttribute("aria-label") === label || b.textContent === label,
    );
    if (!button) throw new Error(label);
    await act(async () => button.click());
  };
  const input = async (label: string, value: string) => {
    const node = container.querySelector<HTMLInputElement>(`[aria-label="${label}"]`);
    if (!node) throw new Error(label);
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(node, value);
      node.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };
  const submit = async () => {
    await act(async () =>
      container.querySelector("form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
    );
  };
  return { container, call, click, input, submit, state: () => state };
}
it("opens through ui_show_panel without replacing the function tab and exposes export settings", () => {
  const state = applyUi(initialState(), "ui_show_panel", { panel: "export", sub: "overlays" });
  expect(state.panel).toBe("ai");
  expect(applyUi(state, "ui_state", {}).export).toEqual({
    open: true,
    sub: "overlays",
    srt: true,
    wav: false,
    active: null,
  });
});
it("preflights exactly three destinations, shows warnings and requires explicit error loss acceptance", async () => {
  const ui = await mount({ losses: "error" });
  expect(ui.call.mock.calls.filter(([verb]) => verb === "export")).toHaveLength(3);
  expect(ui.call.mock.calls.filter(([verb]) => verb === "export").map(([, request]) => request)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ profile: "fcp-11-fcpxml-1.13", dry_run: true }),
      expect.objectContaining({ profile: "resolve-18.5-otio", dry_run: true }),
      expect.objectContaining({ profile: "premiere-25-xmeml-5", dry_run: true }),
    ]),
  );
  expect(ui.container.querySelectorAll('[aria-label="导出有损失"]')).toHaveLength(3);
  expect(ui.container.querySelector('[aria-label="导出有损失"]')?.getAttribute("title")).toBe("变速需要近似");
  await ui.click("导出到 Final Cut Pro");
  expect(ui.container.querySelector('[role="alertdialog"]')).not.toBeNull();
  expect(ui.call.mock.calls.some(([verb, r]) => verb === "export" && !r.dry_run)).toBe(false);
  await ui.click("取消");
  await ui.click("导出到 Final Cut Pro");
  await ui.click("接受损失并导出");
  expect(ui.call).toHaveBeenCalledWith(
    "export",
    expect.objectContaining({
      accept_losses: true,
      profile: "fcp-11-fcpxml-1.13",
      output: "/tmp/交接",
      author: { kind: "human", name: "桌面用户" },
      label: "导出文件",
    }),
  );
  expect(ui.container.textContent).toContain("导出完成");
});
it("warning losses export without an acceptance flag", async () => {
  const ui = await mount({ losses: "warning" });
  await ui.click("导出到 DaVinci Resolve");
  const request = ui.call.mock.calls.find(([verb, r]) => verb === "export" && !r.dry_run)?.[1];
  expect(request?.profile).toBe("resolve-18.5-otio");
  expect(request).not.toHaveProperty("accept_losses");
});
it.each(["srt", "wav", "both"])(
  "exports the %s selection and prevents turning off the last format",
  async (selection) => {
    const ui = await mount();
    expect(ui.container.querySelector<HTMLButtonElement>('[aria-label="导出 SRT"]')?.disabled).toBe(true);
    if (selection !== "srt") await ui.click("导出 WAV");
    if (selection === "wav") await ui.click("导出 SRT");
    await ui.click("直接导出");
    expect(ui.call.mock.calls.filter(([verb, r]) => verb === "export" && !r.dry_run).map(([, r]) => r.profile)).toEqual(
      selection === "both"
        ? ["direct-srt", "direct-audio-wav"]
        : [selection === "srt" ? "direct-srt" : "direct-audio-wav"],
    );
    expect(ui.container.textContent).toContain("/tmp/直接/主时间线_r1.srt");
    expect(ui.call).toHaveBeenCalledWith("export_preferences", {
      value: expect.objectContaining({ direct: "/tmp/直接" }),
    });
  },
);
it("creates, updates and removes overlays through labeled human edits, and exports to the original path", async () => {
  const ui = await mount();
  const overlayCard = ui.container.querySelector('[data-destination="overlays"]');
  expect(overlayCard?.querySelector(".zc-dest .zc-app-tile svg")).not.toBeNull();
  expect(overlayCard?.querySelector(".zc-dest .zc-dest-files")?.textContent).toContain("MOV");
  expect(overlayCard?.querySelector(".zc-overlay-content .zc-overlay-row")).not.toBeNull();
  await ui.click("新建叠层");
  const form = ui.container.querySelector("form");
  expect(form?.querySelector(".zc-btn-secondary .zc-icon")).not.toBeNull();
  expect(form?.querySelector(".zc-btn-primary .zc-icon")).not.toBeNull();
  expect(form?.querySelector(".zc-btn-primary")?.textContent).toContain("保存叠层");
  await ui.input("叠层名称", "英文字幕层");
  await ui.input("叠层保存位置", "/tmp/英文.mov");
  await ui.submit();
  expect(ui.call).toHaveBeenCalledWith(
    "edit",
    expect.objectContaining({
      label: "新建字幕叠层「英文字幕层」",
      base_revision: "rev_1",
      author: { kind: "human", name: "桌面用户" },
      ops: [
        {
          op: "add_overlay",
          name: "英文字幕层",
          timeline_id: "tl_main",
          subtitle_track_id: "trk_sub",
          output_path: "/tmp/英文.mov",
          tail: "10s",
        },
      ],
    }),
  );
  await ui.click("编辑叠层「中文字幕层」");
  await ui.input("叠层名称", "修正版");
  await ui.input("叠层尾长", "1/2s");
  await ui.submit();
  expect(ui.call).toHaveBeenCalledWith(
    "edit",
    expect.objectContaining({
      label: "修改字幕叠层「修正版」",
      ops: [{ op: "update_overlay", overlay_id: "ovl_one", name: "修正版", tail: "1/2s" }],
    }),
  );
  const row = ui.container.querySelector<HTMLButtonElement>(".zc-overlay-row > button");
  await act(async () => row?.click());
  expect(ui.call).toHaveBeenCalledWith(
    "export",
    expect.objectContaining({
      profile: "subtitle-overlay",
      overlay_id: "ovl_one",
      label: "覆盖导出字幕叠层「中文字幕层」",
    }),
  );
  expect(ui.call.mock.calls.find(([verb, r]) => verb === "export" && r.overlay_id)?.[1]).not.toHaveProperty("output");
  await ui.click("删除叠层「中文字幕层」");
  expect(ui.call).toHaveBeenCalledWith(
    "edit",
    expect.objectContaining({
      label: "删除字幕叠层「中文字幕层」",
      ops: [{ op: "remove_overlay", overlay_id: "ovl_one" }],
    }),
  );
});
it("shows job progress, blocks a second export and continues polling after closing the overlay", async () => {
  const ui = await mount({ polling: true });
  await ui.click("直接导出");
  expect(ui.container.querySelector("progress")?.value).toBe(0.4);
  expect(ui.state().export?.active).toBe("direct");
  await ui.click("导出到 Final Cut Pro");
  expect(ui.call.mock.calls.filter(([verb, r]) => verb === "export" && !r.dry_run)).toHaveLength(1);
  await ui.click("关闭导出");
  expect(ui.state().export?.open).toBe(false);
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 550));
  });
  expect(ui.state().export?.active).toBeNull();
});
it("renders failures without claiming completion and closes on Escape", async () => {
  const ui = await mount({ fail: true });
  await ui.click("直接导出");
  expect(ui.container.querySelector('[role="alert"]')?.textContent).toContain("导出失败");
  expect(ui.container.textContent).not.toContain("导出完成");
  await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
  expect(ui.container.querySelector('[role="dialog"]')).toBeNull();
});

it("uses native folder/save dialogs and reveals the actual exported file", async () => {
  vi.mocked(isTauri).mockReturnValue(true);
  vi.mocked(open).mockResolvedValue("/tmp/另存");
  vi.mocked(save).mockResolvedValue("/tmp/新叠层.mov");
  const ui = await mount();
  const change = ui.container.querySelector<HTMLButtonElement>('[data-destination="fcp"] .zc-export-location button');
  await act(async () => change?.click());
  expect(open).toHaveBeenCalledWith(expect.objectContaining({ directory: true, multiple: false }));
  expect(ui.call).toHaveBeenCalledWith("export_preferences", { value: expect.objectContaining({ fcp: "/tmp/另存" }) });
  await ui.click("新建叠层");
  await ui.click("选择保存位置");
  await ui.submit();
  expect(save).toHaveBeenCalledWith(
    expect.objectContaining({ filters: [{ name: "透明字幕视频", extensions: ["mov"] }] }),
  );
  expect(ui.call).toHaveBeenCalledWith(
    "edit",
    expect.objectContaining({ ops: [expect.objectContaining({ op: "add_overlay", output_path: "/tmp/新叠层.mov" })] }),
  );
  await ui.click("直接导出");
  await ui.click("在访达中显示");
  expect(revealItemInDir).toHaveBeenCalledWith("/tmp/直接/主时间线_r1.srt");
});
it("scrubs by rational frames and keeps playback hotkeys inside the export dialog", async () => {
  const ui = await mount();
  const slider = ui.container.querySelector<HTMLElement>('[aria-label="快速浏览成片"]');
  if (!slider) throw new Error("Missing preview");
  vi.spyOn(slider, "getBoundingClientRect").mockReturnValue({ left: 0, width: 100 } as DOMRect);
  await act(async () => slider.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: 50 })));
  expect(slider.getAttribute("aria-valuenow")).toBe("149");
  const background = vi.fn();
  window.addEventListener("keydown", background);
  await act(async () => slider.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })));
  expect(slider.getAttribute("aria-valuenow")).toBe("150");
  expect(background).not.toHaveBeenCalled();
  window.removeEventListener("keydown", background);
  expect(ui.container.textContent).not.toMatch(/ovl_|trk_|rev_|tl_|sty_/);
});

it("retains the export lock when job status is temporarily unavailable", async () => {
  const ui = await mount();
  const original = ui.call.getMockImplementation();
  let missed = false;
  ui.call.mockImplementation(async (verb, request) => {
    if (verb === "job_status" && !missed) {
      missed = true;
      throw new Error("连接中断");
    }
    return original?.(verb, request);
  });
  await ui.click("直接导出");
  expect(ui.state().export?.active).toBe("direct");
  expect(ui.container.textContent).toContain("暂时无法读取进度");
  await ui.click("导出到 Final Cut Pro");
  expect(ui.call.mock.calls.filter(([verb, r]) => verb === "export" && !r.dry_run)).toHaveLength(1);
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 550));
  });
  expect(ui.state().export?.active).toBeNull();
  expect(ui.container.textContent).toContain("导出完成");
});
