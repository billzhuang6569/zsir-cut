// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { UiState } from "../../app-host/src/ui.js";
import { connectHost, type ProjectView, requestError } from "../src/connection.js";
import { applyUi, initialState } from "../src/state.js";
import { SettingsPage, useVoicePanel } from "../src/VoicePanel.js";

const voices = [{ id: "voc_test", name: "示例音色" }];
const settings = { voice: { model: "s2.1-pro" }, network: { proxy: null } };
const cleanup: (() => Promise<void>)[] = [];
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
    configurable: true,
    value: function (this: HTMLDialogElement) {
      this.open = true;
    },
  });
});
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
  vi.restoreAllMocks();
});
async function mount(responder: (verb: string, request: Record<string, unknown>) => unknown, settingsPage = false) {
  const call = vi.fn(async (verb: string, request: Record<string, unknown>) => responder(verb, request));
  let state: UiState = { ...initialState(), project: "/project.zcut.json", panel: "voice", sub: "clone" };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  function Harness() {
    const [ui, update] = useState(state);
    state = ui;
    const controls = useVoicePanel({
      call,
      state: ui,
      update,
      project: { revision: { id: "rev_1", seq: 1 } } as ProjectView,
      config: { port: 1234, token: "test-token" },
    });
    return settingsPage ? <SettingsPage call={call} close={() => {}} /> : controls;
  }
  await act(async () => root.render(<Harness />));
  cleanup.push(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  const find = (label: string) => {
    const element = container.querySelector<HTMLInputElement>(`[aria-label="${label}"]`);
    if (!element) throw new Error(`Missing ${label}`);
    return element;
  };
  const click = async (label: string) => {
    const element = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === label || button.getAttribute("aria-label") === label,
    );
    if (!element) throw new Error(`Missing ${label}`);
    await act(async () => element.click());
  };
  const input = async (label: string, value: string) => {
    const element = find(label);
    await act(async () => {
      const prototype =
        element.tagName === "TEXTAREA"
          ? HTMLTextAreaElement.prototype
          : element.tagName === "SELECT"
            ? HTMLSelectElement.prototype
            : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(element, value);
      element.dispatchEvent(new Event(element.tagName === "SELECT" ? "change" : "input", { bubbles: true }));
    });
  };
  return { call, container, click, input, find, state: () => state };
}
const respond = (verb: string) => (verb === "voice_list" ? { voices } : {});
it("exposes all voice sub-pages through UI state and defaults to clone", () => {
  for (const sub of ["clone", "generate", "results"]) {
    const state = applyUi(initialState(), "ui_show_panel", { panel: "voice", sub });
    expect(applyUi(state, "ui_state", {})).toMatchObject({ panel: "voice", sub });
  }
  expect(applyUi(initialState(), "ui_show_panel", { panel: "voice" }).sub).toBe("clone");
});
it("clones through a global job, refreshes voices, and exposes only the authenticated sample URL", async () => {
  const h = await mount((verb) => {
    if (verb === "voice_clone") return { job_id: "job_clone" };
    if (verb === "job_status")
      return {
        state: "succeeded",
        progress: 1,
        envelope: { ok: true, result: { warnings: [{ code: "W_VOICE_SAMPLE_TRIMMED" }] } },
      };
    return respond(verb);
  });
  await h.input("参考音频路径", "/sample.wav");
  await h.input("音色名称", "新音色");
  await h.click("克隆音色");
  expect(h.call).toHaveBeenCalledWith("voice_clone", { name: "新音色", file: "/sample.wav" });
  expect(h.call).toHaveBeenCalledWith("job_status", { job_id: "job_clone" });
  expect(h.container.textContent).toContain("前 60 秒");
  const audio = h.container.querySelector("audio");
  expect(audio?.src).toContain("/voice-sample?token=test-token&voice_id=voc_test");
  expect(audio?.preload).toBe("none");
  expect(h.container.textContent).not.toContain("voc_test");
});
it("renames one voice and requires explicit remote-deletion confirmation", async () => {
  const h = await mount(respond);
  await h.click("改名「示例音色」");
  await h.input("新音色名称", "新的名称");
  await h.click("保存名称");
  expect(h.call).toHaveBeenCalledWith("voice_edit", { ops: [{ op: "rename", id: "voc_test", name: "新的名称" }] });
  h.call.mockClear();
  await h.click("删除「示例音色」");
  expect(h.call).not.toHaveBeenCalled();
  expect(h.container.querySelector("dialog")?.textContent).toContain("fish.audio 上的音色");
  await h.click("取消");
  expect(h.call).not.toHaveBeenCalled();
  await h.click("删除「示例音色」");
  await h.click("确认删除");
  expect(h.call).toHaveBeenCalledWith("voice_edit", { ops: [{ op: "delete", id: "voc_test" }] });
});
it("generates free items with a human revision request, omitted defaults, and project-scoped polling", async () => {
  const h = await mount((verb) => {
    if (verb === "voice_generate") return { job_id: "job_generate" };
    if (verb === "job_status") return { state: "succeeded", progress: 1, envelope: { ok: true, result: {} } };
    return respond(verb);
  });
  await h.click("生成");
  expect(h.state().sub).toBe("generate");
  expect(h.container.querySelector("details")?.open).toBe(false);
  await h.input("配音文字 1", "第一段");
  await h.click("添加文字");
  await h.input("配音文字 2", "第二段");
  await h.click("生成配音");
  expect(h.call).toHaveBeenCalledWith("voice_generate", {
    project: "/project.zcut.json",
    base_revision: "rev_1",
    idempotency_key: expect.any(String),
    author: { kind: "human", name: "桌面用户" },
    label: "生成配音",
    voice_id: "voc_test",
    items: [{ text: "第一段" }, { text: "第二段" }],
  });
  expect(h.call).toHaveBeenCalledWith("job_status", { project: "/project.zcut.json", job_id: "job_generate" });
  expect(h.container.textContent).toContain("配音已加入项目素材");
  await h.input("模型", "drama-3");
  await h.input("语速", "1.2");
  await h.input("音量（dB）", "-2");
  await h.input("温度", "0");
  await h.input("采样范围", "0.8");
  await h.input("响度归一化", "false");
  await h.click("生成配音");
  expect(h.call).toHaveBeenCalledWith(
    "voice_generate",
    expect.objectContaining({
      model: "drama-3",
      params: { speed: 1.2, volume: -2, temperature: 0, top_p: 0.8, normalize_loudness: false },
    }),
  );
  await h.click("结果");
  expect(h.container.textContent).toContain("V1.4");
});
it("renders long-job progress and safe failure text without displaying upstream messages", async () => {
  let finish: (value: unknown) => void = () => {};
  const h = await mount((verb) => {
    if (verb === "voice_clone") return { job_id: "job_clone" };
    if (verb === "job_status")
      return new Promise((resolve) => {
        finish = resolve;
      });
    return respond(verb);
  });
  await h.input("参考音频路径", "/sample.wav");
  await h.click("克隆音色");
  expect(h.container.querySelector("progress")).not.toBeNull();
  await act(async () =>
    finish({
      state: "failed",
      progress: 1,
      envelope: { ok: false, error: { code: "E_VOICE_AUTH", message: "unsafe upstream text" } },
    }),
  );
  expect(h.container.textContent).toContain("请在设置中");
  expect(h.container.textContent).not.toContain("unsafe upstream text");
  expect(h.container.querySelector("progress")).toBeNull();
});
it("stores a password, clears the draft, and shows only the saved status with replace/clear actions", async () => {
  let keySet = false;
  const h = await mount((verb, request) => {
    if (verb === "settings_get") return { settings, voice_key_set: keySet };
    if (verb === "settings_set") keySet = request.voice_key !== null;
    return respond(verb);
  }, true);
  expect(h.find("fish.audio API Key").type).toBe("password");
  await h.input("fish.audio API Key", "test-only-placeholder");
  await h.input("默认模型", "s2-pro");
  await h.input("代理地址", "http://127.0.0.1:7897");
  await h.click("保存");
  expect(h.call).toHaveBeenCalledWith("settings_set", {
    voice_key: "test-only-placeholder",
    voice: { model: "s2-pro" },
    network: { proxy: "http://127.0.0.1:7897" },
  });
  expect(h.container.textContent).toContain("已设置");
  expect(h.container.querySelector('input[type="password"]')).toBeNull();
  await h.click("更换");
  expect(h.find("fish.audio API Key").value).toBe("");
  await h.click("保存");
  expect(h.call.mock.calls.filter(([verb]) => verb === "settings_set").at(-1)?.[1]).not.toHaveProperty("voice_key");
  await h.click("清除");
  expect(h.call).toHaveBeenCalledWith("settings_set", { voice_key: null });
  expect(h.find("fish.audio API Key").value).toBe("");
});
it.each(["E_VOICE_AUTH", "E_VOICE_PAYMENT", "E_VOICE_UPSTREAM"])("maps %s without including upstream text", (code) => {
  const text = requestError({ ok: false, result: null, error: { code, message: "unsafe upstream text" } });
  expect(text).not.toContain("unsafe upstream text");
  expect(text).toMatch(/fish.audio/);
});

it.each(["settings_set", "voice_clone", "voice_generate"])(
  "redacts transport errors for %s before logging or returning a cause",
  async (verb) => {
    class FakeSocket {
      onmessage: ((event: MessageEvent) => void) | null = null;
      onclose = null;
      send(raw: string) {
        const request = JSON.parse(raw);
        queueMicrotask(() =>
          this.onmessage?.(
            new MessageEvent("message", {
              data: JSON.stringify({
                id: request.id,
                envelope: { ok: false, error: { code: "E_VOICE_UPSTREAM", message: "unsafe upstream text" } },
              }),
            }),
          ),
        );
      }
      close() {}
    }
    vi.stubGlobal("WebSocket", FakeSocket);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const host = connectHost(
      { port: 1, token: "test" },
      { ui: initialState, project: vi.fn(), icon: vi.fn(), error: vi.fn() },
    );
    try {
      await expect(host.call(verb, {})).rejects.toMatchObject({
        message: expect.not.stringContaining("unsafe upstream text"),
        cause: expect.not.stringContaining("unsafe upstream text"),
      });
      expect(JSON.stringify(log.mock.calls)).not.toContain("unsafe upstream text");
    } finally {
      host();
      vi.unstubAllGlobals();
    }
  },
);
