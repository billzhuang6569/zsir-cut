// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import type { ProjectChanged } from "../../app-host/src/revision-events.js";
import { connectHost } from "../src/connection.js";
import { initialState } from "../src/state.js";

afterEach(() => vi.unstubAllGlobals());
it("exposes revision events to subscribers while refreshing the project and subtitle progress", async () => {
  let socket: FakeSocket | undefined;
  const requests: string[] = [];
  const messages: Record<string, unknown>[] = [];
  class FakeSocket {
    readyState = 1;
    onmessage: ((event: MessageEvent) => void) | null = null;
    onclose = null;
    constructor() {
      socket = this;
    }
    receive(value: unknown) {
      this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(value) }));
    }
    send(raw: string) {
      const message = JSON.parse(raw);
      messages.push(message);
      requests.push(message.verb ?? message.type);
      if (message.verb === "session_approve") {
        queueMicrotask(() =>
          this.receive({
            id: message.id,
            envelope: { ok: false, error: { code: "E_CONFLICT", message: "Session replay failed" } },
          }),
        );
        return;
      }
      const result =
        message.request?.view === "brief"
          ? { project: { name: "项目", revision: { id: "rev_2", seq: 2 } }, transcripts: [] }
          : message.type === "preview_data"
            ? { media: [], cues: [], styles: [] }
            : { tracks: [], markers: [] };
      queueMicrotask(() => this.receive({ id: message.id, envelope: { ok: true, result } }));
    }
    close() {}
  }
  vi.stubGlobal("WebSocket", FakeSocket);
  const previewCache = vi.fn();
  window.addEventListener("desktop-preview-cache", previewCache);
  const project = vi.fn();
  const projectChanged = vi.fn();
  const aiChanged = vi.fn();
  const error = vi.fn();
  const disconnect = connectHost(
    { port: 1, token: "test" },
    {
      ui: initialState,
      project,
      projectChanged,
      aiChanged,
      icon: vi.fn(),
      error,
    },
  );
  try {
    const status = {
      type: "preview_cache",
      segments: [{ clip_id: "c", key: "key", state: "ready" }],
      directory_ok: true,
      projects: [],
    };
    socket?.receive(status);
    expect(previewCache.mock.calls[0]?.[0].detail).toEqual(status);
    socket?.receive({ type: "bootstrap", project: "/project.zcut.json" });
    await vi.waitFor(() => expect(project).toHaveBeenCalledTimes(2));
    project.mockClear();
    requests.length = 0;
    const payload: ProjectChanged = {
      type: "project_changed",
      target: "session",
      session_id: "ses_test",
      revision: { seq: 2, id: "rev_2" },
      verb: "edit",
      label: "草稿",
      reason: "调整开头",
      author: { kind: "agent", name: "test" },
      batch: null,
      summary: { marker: { added: 1, removed: 0, changed: 0 } },
      changes: [{ key: "mrk_test", entity: "marker" }],
      truncated: false,
    };
    const subscriber = vi.fn();
    const unsubscribe = disconnect.subscribe(subscriber);
    socket?.receive(payload);
    expect(subscriber).toHaveBeenCalledExactlyOnceWith(payload);
    unsubscribe();
    expect(projectChanged).toHaveBeenCalledExactlyOnceWith(payload);
    await vi.waitFor(() => expect(project).toHaveBeenCalledTimes(1));
    expect(requests).toEqual(["inspect", "inspect", "preview_data"]);
    socket?.receive({ type: "ai_changed", refresh: true });
    await vi.waitFor(() => expect(project).toHaveBeenCalledTimes(2));
    expect(aiChanged).toHaveBeenCalledTimes(1);
    expect(projectChanged).toHaveBeenCalledTimes(1);
    expect(error).not.toHaveBeenCalled();
    await disconnect.call("preview_data", { session_id: "ses_test", at_revision: "rev_draft" });
    expect(messages.at(-1)).toMatchObject({ type: "preview_data", session_id: "ses_test", at_revision: "rev_draft" });
    expect(messages.at(-1)).not.toHaveProperty("verb");
    const diagnostic = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(disconnect.call("session_approve", { session_id: "ses_test" })).rejects.toMatchObject({
        code: "E_CONFLICT",
        cause: "E_CONFLICT Session replay failed",
      });
    } finally {
      diagnostic.mockRestore();
    }
  } finally {
    window.removeEventListener("desktop-preview-cache", previewCache);
    disconnect();
  }
});
