// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { URL as NodeURL } from "node:url";
import { isTauri } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { actions, presets } from "../../app-host/src/keymap.js";
import { DesktopPreferences, defaultPreferences } from "../../app-host/src/preferences.js";
import { App } from "../src/App.js";
import type { HostPush } from "../src/connection.js";
import * as connection from "../src/connection.js";
import { SettingsPage } from "../src/SettingsPage.js";
import { recordedKey } from "../src/settings-keymap.js";
import { initialState } from "../src/state.js";
import { recordingCanvas } from "./canvas.js";

vi.mock("@tauri-apps/api/core", () => ({ isTauri: vi.fn(() => false) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ revealItemInDir: vi.fn() }));
const cleanup: (() => Promise<void>)[] = [];
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.mocked(isTauri).mockReturnValue(false);
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
  vi.unstubAllGlobals();
});
const agentList = () => ({
  npm: "/bin/npm" as string | null,
  agents: [
    {
      id: "claude",
      name: "Claude Code",
      found: true,
      version: "2.0.0",
      path: "/bin/claude",
      update_available: true,
      default: true,
    },
    { id: "codex", name: "Codex", found: false, version: null, path: null, update_available: false, default: false },
  ],
});
const cacheStatus = () => ({
  directory: "/cache",
  directory_ok: true,
  free_bytes: 100 * 1024 ** 3,
  used_bytes: 3 * 1024 ** 3,
  limit_bytes: 20 * 1024 ** 3,
  projects: [
    {
      project_id: "prj_test",
      name: "采访工程",
      path: "/project.json",
      bytes: 3 * 1024 ** 3,
      last_opened: "2026-11-06T00:00:00Z",
    },
  ],
});
async function mount(
  options: {
    npm?: boolean;
    cacheUnavailable?: boolean;
    failMove?: boolean;
    failSave?: boolean;
    earlyOutput?: boolean;
    initialPage?: "通用" | "Agent";
  } = {},
) {
  const dir = await mkdtemp(join(tmpdir(), "u312-settings-"));
  const prefs = new DesktopPreferences(dir);
  await prefs.load();
  await prefs.set({ preview_cache: { directory: "/cache" } });
  const agents = agentList();
  if (options.npm === false) agents.npm = null;
  let cache = cacheStatus();
  let listener: ((event: HostPush) => void) | undefined;
  const subscribe = vi.fn((value: (event: HostPush) => void) => {
    listener = value;
    return () => {
      listener = undefined;
    };
  });
  const respond = async (verb: string, request: Record<string, unknown>): Promise<unknown> => {
    if (verb === "prefs_get") return prefs.get();
    if (verb === "prefs_set") {
      if (options.failSave) throw new Error("unavailable");
      return (await prefs.set(request.patch)).result;
    }
    if (verb === "agents_list") return structuredClone(agents);
    if (verb === "agents_set_default") {
      for (const agent of agents.agents) agent.default = agent.id === request.id;
      return {};
    }
    if (verb === "agents_install" || verb === "agents_update") {
      if (options.npm === false) throw Object.assign(new Error("npm missing"), { manual: "手动安装说明" });
      if (options.earlyOutput)
        listener?.({ type: "agents_output", job_id: "job_install", line: "首行输出", stream: "stdout" });
      return { job_id: "job_install" };
    }
    if (verb === "preview_cache_status") {
      if (options.cacheUnavailable) throw new Error("unsupported");
      return cache;
    }
    if (verb === "preview_cache_move") {
      if (options.failMove) throw new Error("unavailable");
      await prefs.set({ preview_cache: { directory: request.directory } });
      cache = { ...cache, directory: request.directory as string, projects: [] };
      return {};
    }
    if (verb === "preview_cache_clear") {
      cache = { ...cache, used_bytes: 0, projects: [] };
      return {};
    }
    if (verb === "settings_get")
      return { settings: { voice: { model: "s2.1-pro" }, network: { proxy: null } }, voice_key_set: false };
    return {};
  };
  const pending = new Set<Promise<unknown>>();
  const call = vi.fn((verb: string, request: Record<string, unknown>) => {
    const result = respond(verb, request);
    pending.add(result);
    void result.then(
      () => pending.delete(result),
      () => pending.delete(result),
    );
    return result;
  });
  const settle = async () => {
    await act(async () => {
      do {
        await Promise.allSettled([...pending]);
      } while (pending.size);
    });
  };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const close = vi.fn();
  const openRecognition = vi.fn();
  const onPrefs = vi.fn();
  await act(async () =>
    root.render(
      <SettingsPage
        initialPage={options.initialPage ?? "Agent"}
        call={call}
        subscribe={subscribe}
        close={close}
        onPrefs={onPrefs}
        openRecognition={openRecognition}
        projectPath="/project.json"
      />,
    ),
  );
  cleanup.push(async () => {
    await settle();
    await act(async () => root.unmount());
    expect(listener).toBeUndefined();
    container.remove();
    await rm(dir, { recursive: true, force: true });
  });
  const find = (label: string) => {
    const element = container.querySelector<HTMLElement>(`[aria-label="${label}"]`);
    if (!element) throw new Error(`Missing ${label}`);
    return element;
  };
  const click = async (label: string) => {
    const element = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.getAttribute("aria-label") === label || button.textContent === label,
    );
    if (!element) throw new Error(`Missing ${label}`);
    await act(async () => element.click());
    await settle();
  };
  const input = async (label: string, value: string) => {
    const element = find(label);
    await act(async () => {
      const prototype = element.tagName === "SELECT" ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(element, value);
      element.dispatchEvent(new Event(element.tagName === "SELECT" ? "change" : "input", { bubbles: true }));
    });
    await settle();
  };
  const push = async (event: HostPush) => {
    await act(async () => listener?.(event));
  };
  return { call, container, click, input, find, push, prefs, onPrefs, close, openRecognition, settle };
}
it("shows missing Codex, installs with streamed output and reacts to agent changes", async () => {
  const h = await mount({ earlyOutput: true });
  expect(h.container.textContent).toContain("没有找到");
  expect(h.container.textContent).toContain("有新版");
  expect(h.container.textContent).toContain("/bin/claude");
  expect(h.container.textContent).not.toContain("登录");
  await h.click("安装 Codex");
  expect(h.call).toHaveBeenCalledWith("agents_install", { id: "codex" });
  expect(h.find("安装输出").textContent).toContain("首行输出");
  await h.push({ type: "agents_output", job_id: "job_other", line: "别的任务" });
  await h.push({ type: "agents_output", job_id: "job_install", line: "下载中", stream: "stdout" });
  await h.push({ type: "agents_output", job_id: "job_install", line: "正在安装", stream: "stderr" });
  expect(h.find("安装输出").textContent).toBe("首行输出\n下载中\n正在安装");
  await h.push({ type: "agents_output", job_id: "job_install", done: true, ok: true });
  expect(h.container.textContent).toContain("安装完成");
  const agents = agentList();
  Object.assign(agents.agents[1] as object, { found: true, version: "1.0.0", path: "/bin/codex" });
  await h.push({ type: "agents_changed", ...agents });
  expect(h.container.textContent).not.toContain("没有找到");
  expect(h.find("更新 Codex")).toBeTruthy();
  const details = h.container.querySelector("details");
  if (!details) throw new Error("Missing log");
  details.open = false;
  await h.push({ type: "agents_output", job_id: "job_install", line: "尾行" });
  expect(details.open).toBe(false);
});
it("updates, checks versions and saves the default agent using the right verbs", async () => {
  const h = await mount();
  await h.click("检查更新");
  expect(h.call).toHaveBeenCalledWith("agents_list", { refresh: true });
  await h.click("更新 Claude Code");
  expect(h.call).toHaveBeenCalledWith("agents_update", { id: "claude" });
  await h.push({ type: "agents_output", job_id: "job_install", done: true, ok: false });
  expect(h.container.textContent).toContain("安装未完成");
  const agents = agentList();
  Object.assign(agents.agents[1] as object, { found: true, default: true });
  for (const agent of agents.agents) if (agent.id === "claude") agent.default = false;
  await h.push({ type: "agents_changed", ...agents });
  await h.click("设为默认");
  expect(h.call).toHaveBeenCalledWith("agents_set_default", { id: "claude" });
});
it("provides manual instructions without npm, including host instructions", async () => {
  const h = await mount({ npm: false });
  expect(h.container.textContent).toContain("请先安装 Node.js");
  expect(h.container.textContent).toContain("npm install -g @openai/codex");
  await h.click("安装 Codex");
  expect(h.container.textContent).toContain("手动安装说明");
  expect(h.container.querySelector('[role="alert"]')).toBeNull();
});
it("searches Chinese action labels, records one chord, reports unbinding, and restores the selected defaults", async () => {
  const h = await mount();
  await h.click("快捷键");
  expect(h.container.querySelectorAll("table")).toHaveLength(3);
  await h.input("搜索快捷键", "切");
  expect(h.container.textContent).toContain("切割工具");
  expect(h.container.textContent).toContain("在播放头切一刀");
  expect(h.container.textContent).not.toContain("水平放大");
  await h.click("修改切割工具");
  await act(async () =>
    h.find("修改切割工具").dispatchEvent(new KeyboardEvent("keydown", { key: "a", code: "KeyA", bubbles: true })),
  );
  await h.settle();
  expect(h.call).toHaveBeenCalledWith("prefs_set", { patch: { keymap: { overrides: { tool_blade: "A" } } } });
  expect(h.container.textContent).toContain("已取消「选择工具」的快捷键");
  expect(h.prefs.get().keymap.tool_select).toBeNull();
  expect(h.onPrefs).toHaveBeenLastCalledWith(
    expect.objectContaining({ keymap: expect.objectContaining({ tool_blade: "A", tool_select: null }) }),
  );
  await h.click("恢复默认");
  expect(h.prefs.get().keymap).toEqual(presets.fcp);
  await h.input("搜索快捷键", "");
  await h.click("Premiere使用这套习惯");
  expect(h.call).toHaveBeenCalledWith("prefs_set", {
    patch: { keymap: { preset: "premiere", overrides: presets.premiere } },
  });
  expect(h.prefs.get().keymap).toEqual(presets.premiere);
  await h.click("Final Cut Pro使用这套习惯");
  expect(h.call).toHaveBeenCalledWith("prefs_set", { patch: { keymap: { preset: "fcp", overrides: presets.fcp } } });
  expect(Object.keys(h.prefs.get().keymap)).toEqual(actions);
});
it("cancels recording without writes and keeps saved preferences after failed writes", async () => {
  const h = await mount({ failSave: true });
  await h.click("快捷键");
  await h.click("修改切割工具");
  await act(async () =>
    h
      .find("修改切割工具")
      .dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })),
  );
  expect(h.call.mock.calls.some(([verb]) => verb === "prefs_set")).toBe(false);
  await h.click("Premiere使用这套习惯");
  expect(h.prefs.get().prefs.keymap.preset).toBe("fcp");
  expect(h.container.querySelector('[role="alert"]')?.textContent).toContain("未能完成");
});
it("writes every cache preference, clears one project and then all projects", async () => {
  const h = await mount();
  await h.click("预览与缓存");
  expect(h.container.textContent).toContain("100 GB");
  expect(h.container.textContent).toContain("采访工程");
  await h.input("缓存上限", "50");
  expect(h.call).toHaveBeenCalledWith("prefs_set", { patch: { preview_cache: { limit_gb: 50 } } });
  for (const quality of ["540p", "1080p", "720p"]) {
    await h.click(quality);
    expect(h.call).toHaveBeenCalledWith("prefs_set", { patch: { preview_cache: { quality } } });
  }
  await h.click("剪完自动在后台准备");
  expect(h.call).toHaveBeenCalledWith("prefs_set", { patch: { preview_cache: { auto: false } } });
  await h.click("用电池时暂停准备");
  expect(h.call).toHaveBeenCalledWith("prefs_set", { patch: { preview_cache: { pause_on_battery: false } } });
  await h.click("清掉采访工程");
  expect(h.call).toHaveBeenCalledWith("preview_cache_clear", { project_id: "prj_test" });
  expect(h.container.textContent).not.toContain("采访工程");
  await h.click("全部清空");
  expect(h.call).toHaveBeenCalledWith("preview_cache_clear", {});
});
it("moves the cache from browser path input, refreshes status, and receives cache pushes", async () => {
  const h = await mount();
  await h.click("预览与缓存");
  await h.input("缓存位置", "/new-cache");
  await h.push({ type: "preview_cache", ...cacheStatus(), used_bytes: 4 * 1024 ** 3 });
  expect((h.find("缓存位置") as HTMLInputElement).value).toBe("/new-cache");
  await h.click("换位置…");
  expect(h.call).toHaveBeenCalledWith("preview_cache_move", { directory: "/new-cache" });
  const verbs = h.call.mock.calls.map(([verb]) => verb);
  expect(verbs.slice(verbs.indexOf("preview_cache_move"))).toEqual([
    "preview_cache_move",
    "prefs_get",
    "preview_cache_status",
  ]);
  expect(h.container.textContent).not.toContain("采访工程");
  await h.push({ type: "preview_cache", ...cacheStatus(), used_bytes: 5 * 1024 ** 3 });
  expect(h.container.textContent).toContain("已用 5 GB");
});
it("uses the native directory picker and Finder, and treats cancellation as no change", async () => {
  const h = await mount();
  vi.mocked(isTauri).mockReturnValue(true);
  await h.click("预览与缓存");
  vi.mocked(open).mockResolvedValueOnce("/native-cache");
  await h.click("换位置…");
  expect(open).toHaveBeenCalledWith({ directory: true, multiple: false });
  expect(h.call).toHaveBeenCalledWith("preview_cache_move", { directory: "/native-cache" });
  await h.click("在访达中显示");
  expect(revealItemInDir).toHaveBeenCalledWith("/native-cache");
  vi.mocked(open).mockResolvedValueOnce(null);
  const count = h.call.mock.calls.length;
  await h.click("换位置…");
  expect(h.call.mock.calls).toHaveLength(count);
});
it("disables cache controls with one short message when cache verbs are unavailable", async () => {
  const h = await mount({ cacheUnavailable: true });
  await h.click("预览与缓存");
  expect(h.container.textContent?.match(/缓存暂不可用/g)).toHaveLength(1);
  expect(h.container.textContent).not.toContain("NaN");
  for (const control of h.container.querySelectorAll<HTMLInputElement>(
    ".zc-settings-body input, .zc-settings-body select, .zc-settings-body button",
  ))
    expect(control.matches(":disabled")).toBe(true);
  expect(h.container.querySelector('[role="alert"]')).toBeNull();
});
it("retains the current location on move failure", async () => {
  const h = await mount({ failMove: true });
  await h.click("预览与缓存");
  await h.input("缓存位置", "/unavailable");
  await h.click("换位置…");
  expect(h.prefs.get().prefs.preview_cache.directory).toBe("/cache");
  expect(h.container.querySelector('[role="alert"]')?.textContent).toContain("未能完成");
});
it("embeds existing voice settings and links to project recognition without nesting dialogs", async () => {
  const h = await mount();
  await h.click("语音");
  expect(h.container.querySelectorAll("dialog")).toHaveLength(1);
  await h.input("fish.audio API Key", "example-key");
  await h.click("保存");
  expect(h.call).toHaveBeenCalledWith("settings_set", expect.objectContaining({ voice_key: "example-key" }));
  await h.click("字幕识别");
  await h.click("打开字幕识别");
  expect(h.close).toHaveBeenCalledOnce();
  expect(h.openRecognition).toHaveBeenCalledOnce();
});
it.each([
  [{ key: "å", code: "KeyA", altKey: true }, "⌥A"],
  [{ key: "<", code: "Comma", shiftKey: true, metaKey: true }, "⇧⌘,"],
  [{ key: "ArrowLeft", ctrlKey: true, altKey: true }, "⌃⌥Left"],
  [{ key: "!", code: "Digit1", shiftKey: true }, "⇧1"],
  [{ key: "Shift" }, null],
])("records a supported single chord from %j", (event, expected) => {
  expect(recordedKey(new KeyboardEvent("keydown", event))).toBe(expected);
});
it("opens settings from Cmd+, the rail, and a changed open_settings binding", async () => {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => recordingCanvas().context);
  const call = vi.fn(async (verb: string) => {
    if (verb === "prefs_get")
      return {
        prefs: defaultPreferences,
        keymap: { ...presets.fcp, open_settings: "⌘." },
        preview_cache_directory: "/cache",
      };
    if (verb === "agents_list") return agentList();
    if (verb === "preview_cache_status") return cacheStatus();
    return {};
  });
  let handlers: Parameters<typeof connection.connectHost>[1] | undefined;
  vi.spyOn(connection, "connectHost").mockImplementation((_config, next) => {
    handlers = next;
    return Object.assign(() => {}, { call, subscribe: () => () => {} });
  });
  const container = document.createElement("div");
  const root = createRoot(container);
  cleanup.push(async () => {
    await act(async () => root.unmount());
  });
  await act(async () => root.render(<App config={{ port: 1, token: "test" }} />));
  await act(async () =>
    window.dispatchEvent(new KeyboardEvent("keydown", { key: ",", metaKey: true, cancelable: true })),
  );
  expect(container.querySelector('dialog[aria-label="设置"]')).not.toBeNull();
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="关闭"]')?.click());
  await act(async () => handlers?.project(null, null));
  await act(async () =>
    window.dispatchEvent(new KeyboardEvent("keydown", { key: ",", metaKey: true, cancelable: true })),
  );
  expect(container.querySelector("dialog")).toBeNull();
  await act(async () =>
    window.dispatchEvent(new KeyboardEvent("keydown", { key: ".", metaKey: true, cancelable: true })),
  );
  expect(container.querySelector("dialog")).not.toBeNull();
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="关闭"]')?.click());
  await act(async () =>
    handlers?.project("/project.json", {
      id: "tl_main",
      name: "工程",
      revision: { id: "rev_test", seq: 1 },
      edit_rate: "25",
      start_timecode: "00:00:00:00",
      drop_frame: false,
      duration: { t: "10s" },
      tracks: [],
      media: [],
      cues: [],
      styles: [],
      markers: [],
    }),
  );
  const railSettings = container.querySelector<HTMLButtonElement>('.zc-rail [aria-label="设置"]');
  expect(railSettings).not.toBeNull();
  await act(async () => railSettings?.click());
  expect(container.querySelector("dialog")).not.toBeNull();
  expect(container.querySelector('[aria-current="page"]')?.textContent).toBe("通用");
});
it("forwards the three settings pushes, unsubscribes, and preserves manual installation instructions", async () => {
  let socket: FakeSocket | undefined;
  class FakeSocket {
    readyState = 1;
    onmessage: ((event: MessageEvent) => void) | null = null;
    onclose = null;
    constructor() {
      socket = this;
    }
    send(raw: string) {
      const request = JSON.parse(raw);
      queueMicrotask(() =>
        socket?.onmessage?.(
          new MessageEvent("message", {
            data: JSON.stringify({
              type: "result",
              id: request.id,
              envelope: {
                ok: false,
                error: { code: "E_UNSUPPORTED", message: "没有找到 npm", details: { manual: "手动安装说明" } },
              },
            }),
          }),
        ),
      );
    }
    close() {}
  }
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.spyOn(console, "error").mockImplementation(() => {});
  const host = connection.connectHost(
    { port: 1, token: "test" },
    { ui: initialState, project: vi.fn(), icon: vi.fn(), error: vi.fn() },
  );
  socket?.onmessage?.(new MessageEvent("message", { data: JSON.stringify({ type: "bootstrap", project: null }) }));
  const listener = vi.fn();
  const stop = host.subscribe(listener);
  for (const type of ["agents_changed", "agents_output", "preview_cache"])
    socket?.onmessage?.(new MessageEvent("message", { data: JSON.stringify({ type }) }));
  expect(listener.mock.calls.map(([event]) => event.type)).toEqual([
    "agents_changed",
    "agents_output",
    "preview_cache",
  ]);
  stop();
  socket?.onmessage?.(new MessageEvent("message", { data: JSON.stringify({ type: "agents_output" }) }));
  expect(listener).toHaveBeenCalledTimes(3);
  await expect(host.call("agents_install", { id: "codex" })).rejects.toMatchObject({ manual: "手动安装说明" });
  host();
});

it("queues settings reads until bootstrap and renders the exact captured agents_list frame", async () => {
  const frame = readFileSync(new NodeURL("./fixtures/agents_list-response.json", import.meta.url), "utf8");
  let socket: FakeSocket | undefined;
  class FakeSocket {
    readyState = 0;
    onopen: (() => void) | null = null;
    onmessage: ((event: MessageEvent) => void) | null = null;
    onclose: (() => void) | null = null;
    send = vi.fn();
    constructor() {
      socket = this;
    }
    close() {
      this.readyState = 3;
      this.onclose?.();
    }
  }
  vi.stubGlobal("WebSocket", FakeSocket);
  const host = connection.connectHost(
    { port: 1, token: "test" },
    { ui: initialState, project: vi.fn(), icon: vi.fn(), error: vi.fn() },
  );
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  cleanup.push(async () => {
    await act(async () => root.unmount());
    host();
    container.remove();
  });
  const call = (verb: string, request: Record<string, unknown>) => {
    if (verb === "prefs_get")
      return Promise.resolve({ prefs: defaultPreferences, keymap: presets.fcp, preview_cache_directory: "/cache" });
    if (verb === "preview_cache_status") return Promise.reject(new Error("unsupported"));
    return host.call(verb, request);
  };
  await act(async () =>
    root.render(
      <SettingsPage
        initialPage="Agent"
        call={call}
        subscribe={host.subscribe}
        close={vi.fn()}
        onPrefs={vi.fn()}
        openRecognition={vi.fn()}
        projectPath={null}
      />,
    ),
  );
  expect(container.textContent).toContain("正在读取 Agent");
  expect(socket?.send).not.toHaveBeenCalled();
  if (!socket) throw new Error("Missing socket");
  socket.readyState = 1;
  socket.onopen?.();
  expect(socket.send.mock.calls.map(([raw]) => JSON.parse(raw))).toEqual([{ type: "ui_ready" }]);
  socket.onmessage?.(new MessageEvent("message", { data: JSON.stringify({ type: "bootstrap", project: null }) }));
  expect(JSON.parse(socket.send.mock.calls[1]?.[0] as string)).toEqual({ id: "1", verb: "agents_list", request: {} });
  await act(async () => socket?.onmessage?.(new MessageEvent("message", { data: frame })));
  expect(container.textContent).not.toContain("暂时无法读取 Agent");
  expect(container.textContent).toContain("已找到 · 2.1.318");
  expect(container.textContent).toContain("已找到 · 0.167.0");
  expect(container.textContent).not.toContain("(Claude Code)");
  expect(container.textContent).not.toContain("codex-cli");
  expect(container.textContent).toContain("/Users/billzhuang/.nvm/versions/node/v24.14.1/bin/claude");
  expect(container.querySelector('[aria-current="page"]')?.textContent).toBe("Agent");
  expect(document.activeElement).toBe(container.querySelector('[aria-current="page"]'));
  expect(container.querySelector(".zc-settings-agent .zc-chip")?.textContent).toBe("默认");
});
it.each(["close", "disconnect"])("rejects queued requests on %s before bootstrap", async (action) => {
  let socket: FakeSocket | undefined;
  class FakeSocket {
    readyState = 0;
    onclose: (() => void) | null = null;
    constructor() {
      socket = this;
    }
    close() {
      this.readyState = 3;
      this.onclose?.();
    }
  }
  vi.stubGlobal("WebSocket", FakeSocket);
  const host = connection.connectHost(
    { port: 1, token: "test" },
    { ui: initialState, project: vi.fn(), icon: vi.fn(), error: vi.fn() },
  );
  const pending = host.call("agents_list", {});
  if (action === "close") socket?.close();
  else host();
  await expect(pending).rejects.toThrow("宿主连接已断开");
  await expect(host.call("agents_list", {})).rejects.toThrow("宿主连接已断开");
  host();
});
