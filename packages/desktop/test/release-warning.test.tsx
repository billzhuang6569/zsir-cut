// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { App } from "../src/App.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
it("shows missing ffmpeg tools above the start page, copies the install command and clears on a healthy bootstrap", async () => {
  let socket: FakeSocket | undefined;
  class FakeSocket {
    readyState = 1;
    onmessage: ((event: MessageEvent) => void) | null = null;
    onclose = null;
    constructor() {
      socket = this;
    }
    receive(message: unknown) {
      this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(message) }));
    }
    send(raw: string) {
      const message = JSON.parse(raw);
      queueMicrotask(() =>
        this.receive({
          id: message.id,
          envelope: { ok: true, result: message.verb === "agents_list" ? { agents: [], npm: null } : [] },
        }),
      );
    }
    close() {}
  }
  vi.stubGlobal("WebSocket", FakeSocket);
  const writeText = vi.fn(async () => {});
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  const node = document.createElement("div");
  document.body.append(node);
  const root = createRoot(node);
  const bootstrap = (missing: string[]) =>
    act(() =>
      socket?.receive({
        type: "bootstrap",
        project: null,
        fcpIcon: null,
        mediaTools: { missing, install: "winget install Gyan.FFmpeg" },
      }),
    );
  try {
    await act(() => root.render(<App config={{ port: 1, token: "test" }} />));
    await bootstrap(["ffmpeg", "ffprobe"]);
    const warning = node.querySelector<HTMLElement>('[role="alert"]');
    expect(warning?.textContent).toContain("ffmpeg、ffprobe");
    expect(warning?.textContent).toContain("安装后重启应用");
    expect(warning?.closest("main")).toBeNull();
    expect(node.querySelector('[aria-label="开始页"]')).not.toBeNull();
    await act(() => warning?.querySelector<HTMLButtonElement>("button")?.click());
    expect(writeText).toHaveBeenCalledWith("winget install Gyan.FFmpeg");
    expect(warning?.textContent).toContain("已复制");
    await bootstrap([]);
    expect(node.querySelector('[role="alert"]')).toBeNull();
  } finally {
    await act(() => root.unmount());
    node.remove();
    vi.unstubAllGlobals();
    Reflect.deleteProperty(navigator, "clipboard");
  }
});
