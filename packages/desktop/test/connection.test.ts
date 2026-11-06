// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import type { ProjectChanged } from "../../app-host/src/revision-events.js";
import { connectHost } from "../src/connection.js";
import { initialState } from "../src/state.js";

afterEach(() => vi.unstubAllGlobals());
it("exposes revision events to subscribers while refreshing the project and subtitle progress", async () => {
  let socket: FakeSocket | undefined;
  const requests: string[] = [];
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
      requests.push(message.verb ?? message.type);
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
    socket?.receive(payload);
    expect(projectChanged).toHaveBeenCalledExactlyOnceWith(payload);
    await vi.waitFor(() => expect(project).toHaveBeenCalledTimes(1));
    expect(requests).toEqual(["inspect", "inspect", "preview_data"]);
    socket?.receive({ type: "ai_changed", refresh: true });
    await vi.waitFor(() => expect(project).toHaveBeenCalledTimes(2));
    expect(aiChanged).toHaveBeenCalledTimes(1);
    expect(projectChanged).toHaveBeenCalledTimes(1);
    expect(error).not.toHaveBeenCalled();
  } finally {
    disconnect();
  }
});
