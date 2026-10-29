import type { UiState, UiVerb } from "../../app-host/src/ui.js";

export interface ProjectView {
  name: string;
  revision: { id: string; seq: number };
  tracks: { id: string; name: string; kind: "video" | "audio" | "subtitle" }[];
}
interface ResultEnvelope {
  ok: boolean;
  result: unknown;
  error: { message: string } | null;
}
export function connectHost(
  config: { port: number; token: string },
  handlers: {
    ui: (verb: UiVerb, request: Record<string, unknown>) => UiState;
    project: (path: string, view: ProjectView) => void;
    icon: (value: string | null) => void;
    error: (message: string) => void;
  },
): () => void {
  const socket = new WebSocket(`ws://127.0.0.1:${config.port}/?token=${encodeURIComponent(config.token)}`);
  let sequence = 0;
  let project: string | null = null;
  const pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  const call = (verb: string, request: Record<string, unknown>) =>
    new Promise<unknown>((resolve, reject) => {
      const id = String(++sequence);
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, verb, request }));
    });
  async function refresh() {
    if (!project) return;
    const path = project;
    const brief = (await call("inspect", { project: path, view: "brief" })) as { project: Omit<ProjectView, "tracks"> };
    const timeline = (await call("inspect", { project: path, view: "timeline" })) as Pick<ProjectView, "tracks">;
    handlers.project(path, { ...brief.project, tracks: timeline.tracks });
  }
  socket.onopen = () => socket.send(JSON.stringify({ type: "ui_ready" }));
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.type === "bootstrap") {
      project = message.project;
      handlers.icon(message.fcpIcon);
      void refresh().catch((error: Error) => handlers.error(error.message));
    } else if (message.type === "project_changed") {
      void refresh().catch((error: Error) => handlers.error(error.message));
    } else if (message.type === "ui_request") {
      const result = handlers.ui(message.verb, message.request);
      socket.send(JSON.stringify({ type: "ui_result", id: message.id, result }));
    } else if (message.envelope) {
      const item = pending.get(message.id);
      pending.delete(message.id);
      const envelope = message.envelope as ResultEnvelope;
      if (envelope.ok) item?.resolve(envelope.result);
      else item?.reject(new Error(envelope.error?.message ?? "宿主请求失败"));
    }
  };
  socket.onerror = () => handlers.error("无法连接本机宿主进程");
  socket.onclose = () => {
    for (const item of pending.values()) item.reject(new Error("宿主连接已断开"));
    pending.clear();
    handlers.error("宿主连接已断开");
  };
  return () => {
    socket.onclose = null;
    socket.close();
  };
}
