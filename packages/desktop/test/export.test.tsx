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
import { recordingCanvas } from "./canvas.js";

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
async function mount(
  options: {
    losses?: string;
    polling?: boolean;
    fail?: boolean;
    jobError?: { code: string; message: string };
    rejection?: string;
    project?: ProjectView;
    config?: { port: number; token: string };
    report?: unknown;
  } = {},
) {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => recordingCanvas().context);
  let poll = 0;
  const call = vi.fn(async (verb: string, request: Record<string, unknown>): Promise<unknown> => {
    if (verb === "export_preferences")
      return request.value ?? { fcp: "/tmp/交接", resolve: "/tmp/交接", premiere: "/tmp/交接", direct: "/tmp/直接" };
    if (verb === "export") {
      if (!request.dry_run && options.rejection) throw new Error(options.rejection);
      return request.dry_run
        ? (options.report ?? {
            items: options.losses
              ? [
                  {
                    feature: "speed_segmented",
                    status: "approximated",
                    severity: options.losses,
                    consequence: "变速需要近似",
                  },
                ]
              : [],
          })
        : { job_id: "job_one" };
    }
    if (verb === "job_status") {
      if (options.jobError) return { state: "failed", progress: 1, envelope: { ok: false, error: options.jobError } };
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
        project={options.project ?? project}
        state={ui}
        update={update}
        call={call}
        config={options.config}
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
    if (label.startsWith("导出到 ")) {
      const selector = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
        (button) => button.getAttribute("aria-label") === label.replace("导出到 ", "选择 "),
      );
      if (selector?.disabled) return;
      await act(async () => selector?.click());
    }
    if (label === "新建叠层" || label.startsWith("编辑叠层") || label.startsWith("删除叠层")) {
      const selector = [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
        button.textContent?.includes("只有字幕的透明视频"),
      );
      await act(async () => selector?.click());
    }

    const button = [...container.querySelectorAll<HTMLButtonElement>("button")]
      .reverse()
      .find((b) => b.getAttribute("aria-label") === label || b.textContent === label);
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
  await ui.click("新建叠层");
  const overlayCard = ui.container.querySelector('[data-destination="overlays"]');
  expect(overlayCard?.querySelector(".zc-file")?.textContent).toContain("MOV");
  expect(overlayCard?.querySelector(".zc-overlay-content .zc-overlay-row")).not.toBeNull();
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
  await ui.click("选择 Final Cut Pro");
  await ui.click("选择");
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
  await ui.click("只要文件字幕 SRT、音频 WAV");
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

it("shows project summary values and the first timeline clip thumbnail", async () => {
  const view: ProjectView = {
    ...project,
    name: "成片测试",
    duration: { t: "216001/2000s" },
    revision: { id: "rev_13", seq: 13 },
    edit_rate: "25",
    cues: Array.from({ length: 67 }, (_, i) => ({
      cue_id: `cue_${i}`,
      track_id: "trk_sub",
      start: "0s",
      end: "1s",
      text: "字幕",
      style_id: "sty_default",
      piece: 0,
    })),
    tracks: [
      {
        id: "trk_video",
        name: "视频 A",
        kind: "video",
        enabled: true,
        clips: [
          {
            id: "clp_first",
            media_id: "med_first",
            label: null,
            enabled: true,
            timeline_in: { t: "2s" },
            timeline_out: { t: "10s" },
            source_in: { t: "5s" },
            source_out: { t: "13s" },
            speed: "1",
          },
        ],
      },
    ],
  };
  const ui = await mount({ project: view, config: { port: 1234, token: "test" } });
  const summary = ui.container.querySelector('[aria-label="成片信息"]');
  for (const value of ["成片测试", "01:48", "1 分 48 秒", "1080p", "25 帧/秒", "67 条字幕", "第 13 版 · 已保存"])
    expect(summary?.textContent).toContain(value);
  expect(summary?.querySelector(".zc-dot.is-approved")).not.toBeNull();
  const url = new URL(summary?.querySelector("img")?.src ?? "");
  expect(url.pathname).toContain("thumb");
  expect(url.searchParams.get("media_id")).toBe("med_first");
  expect(url.searchParams.get("at")).toBe("5s");
});
it("formats fractional fps and duration without the project's starting timecode", async () => {
  const ui = await mount();
  const summary = ui.container.querySelector('[aria-label="成片信息"]');
  expect(summary?.textContent).toContain("29.97 帧/秒");
  expect(summary?.textContent).toContain("10 秒");
  expect(summary?.textContent).toContain("00:10");
  expect(summary?.textContent).toContain("0 条字幕");
  expect(summary?.querySelector("img")).toBeNull();
});

it("selects a destination before exporting and lays out the summary, report and location in canvas order", async () => {
  const h = await mount({ losses: "warning" });
  expect(h.container.querySelector(".zc-dialog .zc-export-header h2")?.textContent).toBe("导出");
  expect(h.container.querySelectorAll(".zc-export-left .zc-dest")).toHaveLength(5);
  expect(h.container.querySelector(".zc-export-left > [aria-label='成片信息']")).not.toBeNull();
  await h.click("选择 DaVinci Resolve");
  expect(h.call.mock.calls.filter(([verb, request]) => verb === "export" && !request.dry_run)).toHaveLength(0);
  expect(h.container.querySelector(".zc-export-right h3")?.textContent).toContain("DaVinci Resolve");
  expect(h.container.querySelector(".zc-export-right .zc-export-file-card")?.textContent).toContain("OTIO");
  expect(h.container.querySelector(".zc-export-losses")?.textContent).toContain("近似");
  expect(h.container.querySelector(".zc-export-footer input")?.getAttribute("aria-label")).toBe(
    "DaVinci Resolve保存位置",
  );
  expect(h.container.querySelector(".zc-export-footer .is-primary")?.textContent).toContain("导出到 DaVinci Resolve");
});

it("groups four marker level losses into exactly one capability row", async () => {
  const h = await mount({
    report: {
      items: Array.from({ length: 4 }, (_, index) => ({
        entity_id: `mrk_${index}`,
        feature: "marker_level",
        status: "approximated",
        severity: "warning",
        consequence: "目标格式的章节标记不区分层级",
      })),
    },
  });
  await h.click("选择 Final Cut Pro");
  const rows = h.container.querySelectorAll(".zc-export-losses .zc-row");
  expect(rows).toHaveLength(1);
  expect(rows[0]?.textContent).toBe("章节层级 4 个目标格式的章节标记不区分层级近似");
  expect(rows[0]?.querySelector("small")?.textContent).toBe("目标格式的章节标记不区分层级");
  expect(rows[0]?.querySelector(".zc-meta")?.textContent).toBe("近似");
});

it("groups by feature and status, puts errors first and reads preserved counts without showing feature IDs", async () => {
  const h = await mount({
    report: {
      summary: { preserved_by_feature: { clip_cut: 3, subtitle_text_timing: 67, marker: 0, future_feature: 1 } },
      items: [
        { feature: "clip_cut", status: "approximated", severity: "info", consequence: "时间需要对齐到帧" },
        { feature: "subtitle_style", status: "unsupported", severity: "warning", consequence: "字幕样式无法带入" },
        { feature: "subtitle_style", status: "baked", severity: "info", consequence: "透明字幕已渲染" },
        { feature: "subtitle_style", status: "unsupported", severity: "error", consequence: "字幕动画无法带入" },
      ],
    },
  });
  await h.click("选择 Final Cut Pro");
  const rows = [...h.container.querySelectorAll(".zc-export-losses .zc-row")].map((row) => row.textContent);
  expect(rows).toEqual([
    "字幕样式 2 项字幕样式无法带入；字幕动画无法带入带不过去",
    "剪辑点与顺序 1 项时间需要对齐到帧近似",
    "字幕样式 1 项透明字幕已渲染近似 · 已烘焙",
    "剪辑点与顺序 3 项原样",
    "67 条字幕原样",
    "其他内容 1 项原样",
  ]);
  expect(h.container.querySelector(".zc-export-losses .zc-row .is-danger")).not.toBeNull();
  expect(h.container.textContent).not.toMatch(/clip_cut|subtitle_text_timing|subtitle_style|future_feature/);
});

for (const destination of ["Final Cut Pro", "DaVinci Resolve", "Premiere Pro"]) {
  it(`keeps ${destination} validation failures by the save location outside the scrolling losses`, async () => {
    const message = 'Exchange validation failed: cutting list: [{"row":17,"clip_id":"clp_bad"}]';
    const ui = await mount({
      jobError: { code: "E_IO", message },
      report: {
        items: Array.from({ length: 100 }, (_, i) => ({
          feature: `extra_${i}`,
          status: "approximated",
          severity: "warning",
          consequence: "检查说明",
        })),
      },
    });
    await ui.click(`导出到 ${destination}`);
    const footer = ui.container.querySelector(".zc-export-footer");
    expect(footer?.textContent).toContain("存到");
    expect(footer?.querySelector('[role="alert"]')?.textContent).toBe(
      "导出未通过剪辑点校验，文件未生成。请保留工程并反馈此问题。",
    );
    expect(footer?.querySelector('[role="alert"]')?.textContent).not.toContain("row");
    expect(ui.container.querySelector('.zc-export-right [role="alert"]')).toBeNull();
    const details = footer?.querySelector("details");
    expect(details?.open).toBe(false);
    expect(details?.querySelector("pre")?.textContent).toBe(message);
    expect(ui.state().export?.active).toBeNull();
    expect(ui.container.textContent).not.toContain("导出完成");
  });
}
it("summarizes rejected export calls and preserves their full error only in collapsed details", async () => {
  const ui = await mount({ rejection: 'E_IO: {"private":"diagnostic"}' });
  await ui.click("直接导出");
  const footer = ui.container.querySelector(".zc-export-footer");
  expect(footer?.querySelector('[role="alert"]')?.textContent).toBe("导出失败，请检查素材、保存位置与工程状态后重试");
  expect(footer?.querySelector("details")?.open).toBe(false);
  expect(footer?.querySelector("pre")?.textContent).toBe('E_IO: {"private":"diagnostic"}');
});
