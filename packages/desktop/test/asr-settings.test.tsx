// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { defaultPreferences } from "../../app-host/src/preferences.js";
import { AsrSettings } from "../src/AsrSettings.js";
import type { HostPush } from "../src/connection.js";
import { useSubtitlePanel } from "../src/SubtitlePanel.js";
import { initialState } from "../src/state.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
});
async function mount(supported = true, ready = false) {
  let status = {
    supported,
    recommended: "1.7b",
    api_key_set: false,
    models: [
      {
        id: "1.7b",
        state: ready ? "ready" : "downloading",
        bytes_done: 1_700_000_000,
        bytes_total: 3_800_000_000,
        error: null,
      },
      { id: "0.6b", state: "missing", bytes_done: 0, bytes_total: 0, error: null },
    ],
  };
  let listener: ((event: HostPush) => void) | undefined;
  const subscribe = (next: (event: HostPush) => void) => {
    listener = next;
    return () => {
      listener = undefined;
    };
  };
  const call = vi.fn(async (verb: string, request: Record<string, unknown>): Promise<unknown> => {
    if (verb === "asr_status") return structuredClone(status);
    if (verb === "asr_key_set") {
      status.api_key_set = request.key !== null;
      return null;
    }
    if (verb === "asr_test")
      return {
        ok: true,
        audio_seconds: 5,
        used_seconds: request.mode === "local" ? 1.2 : 2.1,
        text: "今天我们来试一下字幕识别。",
      };
    return null;
  });
  const save = vi.fn();
  function Harness() {
    const [prefs, setPrefs] = useState(() => {
      const prefs = structuredClone(defaultPreferences);
      prefs.asr.model = "1.7b";
      prefs.asr.mode = "local";
      return prefs;
    });
    return (
      <AsrSettings
        call={call}
        subscribe={subscribe}
        prefs={prefs}
        save={async (patch) => {
          save(patch);
          setPrefs((current) => ({ ...current, asr: { ...current.asr, ...(patch.asr as object) } }));
        }}
      />
    );
  }
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(async () => root.render(<Harness />));
  cleanups.push(async () => {
    await act(async () => root.unmount());
    expect(listener).toBeUndefined();
  });
  const button = (label: string) => {
    const node = Array.from(container.querySelectorAll("button")).find(
      (node) => node.getAttribute("aria-label") === label || node.textContent === label,
    );
    if (!node) throw new Error(`Missing ${label}`);
    return node;
  };
  const click = async (label: string) => {
    await act(async () => button(label).click());
  };
  const input = async (value: string) => {
    const node = container.querySelector("input");
    if (!node) throw new Error("Missing key");
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(node, value);
      node.dispatchEvent(new Event("input", { bubbles: true }));
    });
    return node;
  };
  const push = async (event: HostPush) => {
    await act(async () => listener?.(event));
  };
  return {
    container,
    call,
    click,
    button,
    input,
    push,
    save,
    setStatus: (next: typeof status) => {
      status = next;
    },
  };
}
it("places download status and decimal GB counts at opposite ends above the progress bar", async () => {
  const h = await mount();
  const style = document.createElement("style");
  style.textContent = readFileSync("packages/desktop/src/settings.css", "utf8");
  document.head.append(style);
  document.body.append(h.container);
  try {
    const progress = h.container.querySelector("progress");
    await vi.waitFor(
      () => {
        expect(progress?.getAttribute("aria-label")).toBe("高精度下载进度");
        expect(progress?.value).toBe(1_700_000_000);
        expect(progress?.max).toBe(3_800_000_000);
      },
      { timeout: 5000 },
    );
    const row = progress?.previousElementSibling;
    await vi.waitFor(
      () => {
        expect(Array.from(row?.children ?? [], (node) => node.textContent)).toEqual(["下载中 44%", "1.7 GB / 3.8 GB"]);
        expect(getComputedStyle(row as Element).display).toBe("flex");
        expect(getComputedStyle(row as Element).justifyContent).toBe("space-between");
        expect(getComputedStyle(progress?.parentElement as Element).flexDirection).toBe("column");
        expect(getComputedStyle(progress as Element).height).toBe("4px");
      },
      { timeout: 5000 },
    );
  } finally {
    style.remove();
    h.container.remove();
  }
}, 20_000);
it("formats progress pushes in decimal GB, including zero and complete downloads", async () => {
  const h = await mount();
  for (const [done, total, text] of [
    [0, 0, "0.0 GB / 0.0 GB"],
    [0, 2_300_000_000, "0.0 GB / 2.3 GB"],
    [2_300_000_000, 2_300_000_000, "2.3 GB / 2.3 GB"],
  ] as const) {
    await h.push({
      type: "asr_model_progress",
      id: "0.6b",
      state: "downloading",
      bytes_done: done,
      bytes_total: total,
      error: null,
    });
    const model = h.button("使用省内存").parentElement;
    await vi.waitFor(
      () => {
        expect(model?.textContent).toContain(text);
        expect(model?.querySelector("progress")?.value).toBe(done);
        expect(model?.querySelector("progress")?.max).toBe(total || 1);
      },
      { timeout: 5000 },
    );
  }
}, 20_000);
it("renders download and queued progress, cancels, selects, downloads and receives ready pushes", async () => {
  const h = await mount();
  await vi.waitFor(
    () => {
      expect(h.container.textContent).toContain("下载中 44%");
      expect(h.button("开始测试").disabled).toBe(true);
      expect(h.container.textContent).toContain("模型下载好后可以测试。");
    },
    { timeout: 5000 },
  );
  await h.click("取消");
  await vi.waitFor(
    () => {
      expect(h.call).toHaveBeenCalledWith("asr_model_cancel", { model: "1.7b" });
    },
    { timeout: 5000 },
  );
  await h.click("使用省内存");
  await vi.waitFor(
    () => {
      expect(h.save).toHaveBeenCalledWith({ asr: { model: "0.6b" } });
    },
    { timeout: 5000 },
  );
  await h.click("下载");
  await vi.waitFor(
    () => {
      expect(h.call).toHaveBeenCalledWith("asr_model_download", { model: "0.6b" });
    },
    { timeout: 5000 },
  );
  await h.push({
    type: "asr_model_progress",
    id: "0.6b",
    state: "queued",
    bytes_done: 0,
    bytes_total: 20,
    error: null,
  });
  await vi.waitFor(
    () => {
      expect(h.container.textContent).toContain("排队中");
    },
    { timeout: 5000 },
  );
  await h.push({
    type: "asr_model_progress",
    id: "0.6b",
    state: "ready",
    bytes_done: 20,
    bytes_total: 20,
    error: null,
  });
  await vi.waitFor(
    () => {
      expect(h.container.textContent).toContain("已下载");
      expect(h.button("开始测试").disabled).toBe(false);
    },
    { timeout: 5000 },
  );
  await h.click("删除省内存");
  await vi.waitFor(
    () => {
      expect(h.call).toHaveBeenCalledWith("asr_model_delete", { model: "0.6b" });
    },
    { timeout: 5000 },
  );
}, 20_000);
it("renders local success and exact API success/failure states, saves and clears keys, and toggles visibility", async () => {
  const h = await mount(true, true);
  await h.click("开始测试");
  await vi.waitFor(
    () => {
      expect(h.container.textContent).toContain("通过 · 5 秒语音，用 1.2 秒识别完");
    },
    { timeout: 5000 },
  );
  await h.click("API 识别");
  await vi.waitFor(
    () => {
      expect(h.save).toHaveBeenCalledWith({ asr: { mode: "api" } });
      expect(h.container.textContent).toContain("声音会上传到火山引擎识别，不占这台电脑的内存，按用量计费。");
    },
    { timeout: 5000 },
  );
  const input = await h.input("session-key");
  await vi.waitFor(
    () => {
      expect(input.type).toBe("password");
    },
    { timeout: 5000 },
  );
  await h.click("显示 API Key");
  await vi.waitFor(
    () => {
      expect(input.type).toBe("text");
    },
    { timeout: 5000 },
  );
  await h.click("开始测试");
  await vi.waitFor(
    () => {
      expect(h.call).toHaveBeenCalledWith("asr_key_set", { key: "session-key" });
      expect(h.call).toHaveBeenCalledWith("asr_test", { mode: "api" });
      expect(h.container.textContent).toContain("通过 · 5 秒语音，用 2.1 秒识别完");
      expect(h.container.textContent).toContain("识别结果：今天我们来试一下字幕识别。");
    },
    { timeout: 5000 },
  );
  h.call.mockResolvedValueOnce({ ok: false, code: "E_ASR_CLOUD_AUTH", reason: "API Key 不对。检查后再测一次。" });
  await h.click("再测一次");
  await vi.waitFor(
    () => {
      expect(h.container.textContent).toContain("没有通过");
      expect(h.container.textContent).toContain("API Key 不对。检查后再测一次。");
    },
    { timeout: 5000 },
  );
  await h.input("");
  await act(async () => input.dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
  await vi.waitFor(
    () => {
      expect(h.call).toHaveBeenCalledWith("asr_key_set", { key: null });
    },
    { timeout: 5000 },
  );
}, 20_000);
it("shows only the Windows sentence and disables transcription in the subtitle panel", async () => {
  const h = await mount(false);
  await vi.waitFor(
    () => {
      expect(h.container.textContent).toBe("这个版本的 Windows 版不能识别字幕");
      expect(h.container.querySelector("button")).toBeNull();
    },
    { timeout: 5000 },
  );
  const container = document.createElement("div");
  const root = createRoot(container);
  function Panel() {
    const panel = useSubtitlePanel({
      project: {
        id: "tl_test",
        name: "test",
        revision: { id: "rev_test", seq: 1 },
        edit_rate: "25",
        start_timecode: "00:00:00:00",
        drop_frame: false,
        duration: { t: "1s" },
        media: [{ id: "med_a", kind: "audio", audio: { channels: 1, sample_rate: "16000" } }],
        tracks: [],
        cues: [],
        styles: [],
        markers: [],
      },
      state: { ...initialState(), sub: "recognition" },
      update: vi.fn(),
      call: h.call,
      promptAi: vi.fn(),
    });
    return panel.controls;
  }
  await act(async () => root.render(<Panel />));
  cleanups.push(async () => {
    await act(async () => root.unmount());
  });
  const recognize = container.querySelector<HTMLButtonElement>(".zc-sub-recognize");
  await vi.waitFor(
    () => {
      expect(recognize).not.toBeNull();
      expect(recognize?.disabled).toBe(true);
    },
    { timeout: 5000 },
  );
}, 20_000);
