import { useCallback, useEffect, useRef, useState } from "react";
import type { ProjectChanged } from "../../app-host/src/revision-events.js";
import { UI_VERBS, type UiState, type UiVerb } from "../../app-host/src/ui.js";

import type { UiState as DesktopUiState } from "./state.js";
import type { PreviewData, TimelineView, TranscriptView } from "./timeline.js";
export interface ProjectView extends TimelineView, PreviewData {
  historyBatches?: string[];
  name: string;
  revision: { id: string; seq: number };
}
export const DESKTOP_AUTHOR = { kind: "human", name: "桌面用户" } as const;

interface ResultEnvelope {
  ok: boolean;
  result: unknown;
  error: { message: string; code?: string; details?: { manual?: string } } | null;
  verification?: { issues: { code: string; severity: string }[] };
}
export function requestError(envelope: ResultEnvelope) {
  const code = envelope.error?.code;
  const message = envelope.error?.message ?? "";
  if (code === "E_VOICE_AUTH") return "请在设置中添加或更换 fish.audio API Key";
  if (code === "E_VOICE_PAYMENT") return "fish.audio 余额不足，请充值后重试";
  if (code === "E_VOICE_UPSTREAM") return "暂时无法连接 fish.audio，请稍后重试或检查代理设置";
  if (code === "E_CONFLICT") return "工程刚被别处改过，已刷新，请重试";
  if (
    code === "E_OVERLAP" ||
    envelope.verification?.issues.some((issue) => issue.severity === "error" && issue.code === "E_OVERLAP")
  )
    return "会和其他片段重叠";
  if (code === "E_VALIDATION") {
    switch (message) {
      case "Destination track kind differs":
        return "只能移到同类轨道";
      case "Track change requires a single requested clip":
        return "跨轨移动时只能选择一个片段";
      case "Linked group has multiple clips of this track kind":
        return "联动组中有多个同类片段，不能跨轨移动";
      case "Project file is invalid":
        return "工程文件无效";
    }
    if (message.includes("/author") && message.includes("name")) return "操作发起人的姓名缺失，无法继续，请重试";
  }
  if (code === "E_NOT_FOUND") return "找不到工程文件";
  return "没能完成这次修改";
}

export interface PermissionRequest {
  type: "permission_request";
  id: string;
  verb: string;
  title: string;
  detail: string;
  target: string | null;
  command: Record<string, unknown>;
}
export type HostPush = { type: string; [key: string]: unknown };
export type Subscribe = (listener: (message: HostPush) => void) => () => void;

export function connectHost(
  config: { port: number; token: string },
  handlers: {
    ui: (verb: UiVerb, request: Record<string, unknown>) => UiState | Promise<UiState>;
    project: (path: string | null, view: ProjectView | null) => void;
    chat?: (notice: import("./AiPanel.js").AiNotice) => void;
    aiChanged?: () => void;
    projectChanged?: (event: ProjectChanged) => void;
    permission?: (request: PermissionRequest) => void;
    icon: (value: string | null) => void;
    error: (message: string, detail?: string) => void;
  },
): (() => void) & { call: (verb: string, request: Record<string, unknown>) => Promise<unknown>; subscribe: Subscribe } {
  const socket = new WebSocket(`ws://127.0.0.1:${config.port}/?token=${encodeURIComponent(config.token)}`);
  const listeners = new Set<(message: HostPush) => void>();
  // The host accepts UI-only verbs after bootstrap, not merely after socket open.
  let ready = false;
  const queued: string[] = [];
  let sequence = 0;
  let project: string | null = null;
  let generation = 0;
  const pending = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (error: Error) => void; verb: string }
  >();
  const call = (verb: string, request: Record<string, unknown>): Promise<unknown> => {
    if (UI_VERBS.includes(verb as UiVerb)) return Promise.resolve().then(() => handlers.ui(verb as UiVerb, request));
    return new Promise<unknown>((resolve, reject) => {
      if (socket.readyState > 1) {
        reject(new Error("宿主连接已断开"));
        return;
      }
      const id = String(++sequence);
      pending.set(id, { resolve, reject, verb });
      const message = JSON.stringify(
        verb === "preview_data"
          ? { id, type: "preview_data", at_revision: request.at_revision }
          : { id, verb, request },
      );
      if (ready) socket.send(message);
      else queued.push(message);
    });
  };
  async function refresh() {
    if (!project) return;
    const path = project;
    const epoch = generation;
    const brief = (await call("inspect", { project: path, view: "brief" })) as {
      project: Pick<ProjectView, "name" | "revision">;
      transcripts: { id: string }[];
    };
    if (epoch !== generation) return;
    const timeline = (await call("inspect", { project: path, view: "timeline" })) as TimelineView;
    if (epoch !== generation) return;
    const preview = (await call("preview_data", {})) as PreviewData;
    if (epoch !== generation) return;
    const transcripts = await Promise.all(
      (brief.transcripts ?? []).map(async ({ id }) => {
        const { entity } = (await call("inspect", { project: path, view: "entity", id })) as {
          entity: TranscriptView;
        };
        return {
          id: entity.id,
          media_id: entity.media_id,
          tokens: entity.tokens,
          cues: entity.cues,
          ...(entity.ext ? { ext: entity.ext } : {}),
        };
      }),
    );
    if (epoch !== generation) return;
    handlers.project(path, {
      ...timeline,
      ...preview,
      transcripts,
      name: brief.project.name,
      revision: brief.project.revision,
    });
  }
  socket.onopen = () => socket.send(JSON.stringify({ type: "ui_ready" }));
  let uiQueue = Promise.resolve();
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (["agents_changed", "agents_output", "preview_cache"].includes(message.type)) {
      for (const listener of listeners) listener(message);
    }
    if (message.type === "bootstrap") {
      ready = true;
      for (const request of queued.splice(0)) socket.send(request);
      generation++;
      project = message.project;
      window.dispatchEvent(new Event("desktop-host-ready"));
      handlers.icon(message.fcpIcon);
      handlers.project(project, null);
      void refresh().catch((error: Error) =>
        handlers.error(`工程文件打不开：${error.message}`, String(error.cause ?? error.message)),
      );
    } else if (message.type === "chat_event") {
      handlers.chat?.(message);
    } else if (message.type === "permission_request") {
      handlers.permission?.(message);
    } else if (message.type === "ai_changed") {
      handlers.aiChanged?.();
    }
    if (message.type === "project_changed" || (message.type === "ai_changed" && message.refresh)) {
      if (message.type === "project_changed") handlers.projectChanged?.(message);
      void refresh().catch((error: Error) =>
        handlers.error(`工程文件打不开：${error.message}`, String(error.cause ?? error.message)),
      );
    } else if (message.type === "ui_request") {
      uiQueue = uiQueue
        .then(async () => {
          const result = await handlers.ui(message.verb, message.request);
          socket.send(
            JSON.stringify({
              type: "ui_result",
              id: message.id,
              result: {
                ...result,
                history: {
                  ...result.history,
                  open: result.history?.open ?? false,
                  viewing: result.history?.revision ?? null,
                },
              },
            }),
          );
        })
        .catch(() => handlers.error("界面操作失败，请重试"));
    } else if (message.envelope) {
      const item = pending.get(message.id);
      pending.delete(message.id);
      const envelope = message.envelope as ResultEnvelope;
      if (envelope.ok) {
        item?.resolve(envelope.result);
        if (item?.verb === "prefs_set") window.dispatchEvent(new Event("desktop-prefs-changed"));
      } else {
        const sensitive =
          item?.verb.startsWith("voice_") ||
          item?.verb.startsWith("settings_") ||
          envelope.error?.code?.startsWith("E_VOICE_");
        const detail = sensitive
          ? requestError(envelope)
          : JSON.stringify({ error: envelope.error, verification: envelope.verification });
        console.error("宿主请求失败", detail);
        const error = new Error(requestError(envelope), {
          cause: sensitive
            ? requestError(envelope)
            : `${envelope.error?.code ?? ""} ${envelope.error?.message ?? ""}`.trim(),
        });
        Object.assign(error, { manual: envelope.error?.details?.manual });
        if (envelope.error?.code === "E_CONFLICT") {
          void refresh().then(
            () => item?.reject(error),
            (refreshError) => {
              console.error("工程刷新失败", refreshError);
              item?.reject(new Error("工程刚被别处改过，刷新失败，请重新打开工程", { cause: error.cause }));
            },
          );
        } else item?.reject(error);
      }
    }
  };
  socket.onerror = () => handlers.error("无法连接本机宿主进程");
  socket.onclose = () => {
    for (const item of pending.values()) item.reject(new Error("宿主连接已断开"));
    pending.clear();
    queued.length = 0;
    handlers.error("宿主连接已断开");
  };
  return Object.assign(
    () => {
      socket.onclose = null;
      for (const item of pending.values()) item.reject(new Error("宿主连接已断开"));
      pending.clear();
      queued.length = 0;
      socket.close();
    },
    {
      call,
      subscribe: (listener: (message: HostPush) => void) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    },
  );
}

interface TimelinePreferences {
  keymap: Record<string, string | null>;
  prefs: { ui: { snap: boolean; magnetic: boolean; track_height: "s" | "m" | "l" } };
}
export function useTimelinePreferences(
  call: (verb: string, request: Record<string, unknown>) => Promise<unknown>,
  error: (message: string) => void,
  state: DesktopUiState,
  update: (state: DesktopUiState) => void,
) {
  const latest = useRef({ state, update });
  latest.current = { state, update };
  const [preferences, setPreferences] = useState<TimelinePreferences | null>(null);
  const generation = useRef(0);
  const acceptPrefs = useCallback((value: TimelinePreferences) => {
    if (!value?.keymap || !value.prefs?.ui) return;
    generation.current++;
    setPreferences(value);
    if (latest.current.state.snap !== value.prefs.ui.snap)
      latest.current.update({ ...latest.current.state, snap: value.prefs.ui.snap });
  }, []);
  useEffect(() => {
    let active = true;
    const refresh = () => {
      const current = ++generation.current;
      void call("prefs_get", {})
        .then((result) => {
          const value = result as TimelinePreferences;
          if (active && current === generation.current) acceptPrefs(value);
        })
        .catch(() => {
          /* Bootstrap retries after the socket is ready. */
        });
    };
    refresh();
    window.addEventListener("desktop-host-ready", refresh);
    window.addEventListener("desktop-prefs-changed", refresh);
    window.addEventListener("focus", refresh);
    return () => {
      active = false;
      window.removeEventListener("desktop-host-ready", refresh);
      window.removeEventListener("desktop-prefs-changed", refresh);
      window.removeEventListener("focus", refresh);
    };
  }, [call, acceptPrefs]);
  const setUi = async (patch: Partial<TimelinePreferences["prefs"]["ui"]>) => {
    if (patch.snap !== undefined) update({ ...state, snap: patch.snap });
    try {
      const value = (await call("prefs_set", { patch: { ui: patch } })) as TimelinePreferences;
      acceptPrefs(value);
    } catch (cause) {
      error(cause instanceof Error ? cause.message : "偏好保存失败，请重试");
    }
  };
  return {
    keymap: preferences?.keymap ?? { open_settings: "⌘," },
    acceptPrefs,
    snap: state.snap ?? true,
    magnetic: preferences?.prefs.ui.magnetic ?? true,
    trackHeight: preferences?.prefs.ui.track_height ?? "m",
    setUi,
  };
}
