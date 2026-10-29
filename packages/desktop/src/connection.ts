import type { UiState, UiVerb } from "../../app-host/src/ui.js";

import type { PreviewData, TimelineView } from "./timeline.js";
export interface ProjectView extends TimelineView, PreviewData {
  historyBatches?: string[];
  name: string;
  revision: { id: string; seq: number };
}
interface ResultEnvelope {
  ok: boolean;
  result: unknown;
  error: { message: string; code?: string } | null;
}
export function connectHost(
  config: { port: number; token: string },
  handlers: {
    ui: (verb: UiVerb, request: Record<string, unknown>) => UiState | Promise<UiState>;
    project: (path: string, view: ProjectView) => void;
    chat?: (notice: import("./AiPanel.js").AiNotice) => void;
    aiChanged?: () => void;
    icon: (value: string | null) => void;
    error: (message: string, detail?: string) => void;
  },
): (() => void) & { call: (verb: string, request: Record<string, unknown>) => Promise<unknown> } {
  const socket = new WebSocket(`ws://127.0.0.1:${config.port}/?token=${encodeURIComponent(config.token)}`);
  let sequence = 0;
  let project: string | null = null;
  const pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  const call = (verb: string, request: Record<string, unknown>) =>
    new Promise<unknown>((resolve, reject) => {
      const id = String(++sequence);
      pending.set(id, { resolve, reject });
      socket.send(
        JSON.stringify(
          verb === "preview_data"
            ? { id, type: "preview_data", at_revision: request.at_revision }
            : { id, verb, request },
        ),
      );
    });
  async function refresh() {
    if (!project) return;
    const path = project;
    const brief = (await call("inspect", { project: path, view: "brief" })) as {
      project: Pick<ProjectView, "name" | "revision">;
    };
    const timeline = (await call("inspect", { project: path, view: "timeline" })) as TimelineView;
    const preview = (await call("preview_data", {})) as PreviewData;
    handlers.project(path, { ...timeline, ...preview, name: brief.project.name, revision: brief.project.revision });
  }
  socket.onopen = () => socket.send(JSON.stringify({ type: "ui_ready" }));
  let uiQueue = Promise.resolve();
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.type === "bootstrap") {
      project = message.project;
      handlers.icon(message.fcpIcon);
      void refresh().catch((error: Error) =>
        handlers.error(`工程文件打不开：${error.message}`, String(error.cause ?? error.message)),
      );
    } else if (message.type === "chat_event") {
      handlers.chat?.(message);
    } else if (message.type === "ai_changed") {
      handlers.aiChanged?.();
    } else if (message.type === "project_changed") {
      void refresh().catch((error: Error) =>
        handlers.error(`工程文件打不开：${error.message}`, String(error.cause ?? error.message)),
      );
    } else if (message.type === "ui_request") {
      uiQueue = uiQueue
        .then(async () => {
          const result = await handlers.ui(message.verb, message.request);
          socket.send(JSON.stringify({ type: "ui_result", id: message.id, result }));
        })
        .catch(() => handlers.error("界面操作失败，请重试"));
    } else if (message.envelope) {
      const item = pending.get(message.id);
      pending.delete(message.id);
      const envelope = message.envelope as ResultEnvelope;
      if (envelope.ok) item?.resolve(envelope.result);
      else
        item?.reject(
          new Error(
            !envelope.error?.code
              ? (envelope.error?.message ?? "请求失败")
              : envelope.error?.code === "E_VALIDATION"
                ? "工程文件无效"
                : envelope.error?.code === "E_NOT_FOUND"
                  ? "找不到工程文件"
                  : "请求失败，请检查工程后重试",
            { cause: `${envelope.error?.code ?? ""} ${envelope.error?.message ?? ""}`.trim() },
          ),
        );
    }
  };
  socket.onerror = () => handlers.error("无法连接本机宿主进程");
  socket.onclose = () => {
    for (const item of pending.values()) item.reject(new Error("宿主连接已断开"));
    pending.clear();
    handlers.error("宿主连接已断开");
  };
  return Object.assign(
    () => {
      socket.onclose = null;
      socket.close();
    },
    { call },
  );
}
