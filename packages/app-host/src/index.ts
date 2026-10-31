#!/usr/bin/env node
import { execFile } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, promisify } from "node:util";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { WebSocket, WebSocketServer } from "ws";
import { z } from "zod";
import type { DispatchOptions, Envelope, SubtitleStyle, Verb } from "../../core/dist/index.js";
import { Agents } from "./agents.js";
import { exportPreferences } from "./export-preferences.js";
import { mediaChannel, runFfmpeg } from "./media.js";
import { RecentProjects } from "./recent.js";
import { SubtitlePass, type SubtitlePassParams } from "./subtitle-pass.js";
import { DESKTOP_VERBS, type DesktopVerb, PANELS, SUBTITLE_VERBS, type SubtitleVerb, type UiEnvelope } from "./ui.js";

const {
  dispatch,
  commandSchemaForVerb,
  flattenMcpSchema,
  newId,
  VERBS,
  parseProject,
  projectSubtitles,
  validateProjectSemantics,
  displayRanges,
  openProject,
  printRational,
}: typeof import("../../core/dist/index.js") = await import(
  new URL(import.meta.url.endsWith(".ts") ? "../../core/src/index.ts" : "../../core/dist/index.js", import.meta.url)
    .href
);
export function subtitleStylesForPreview(styles: SubtitleStyle[]) {
  return styles.map((style) => ({
    ...style,
    ...(style.animation
      ? {
          animation: {
            ...style.animation,
            ...(style.animation.in
              ? { in: { ...style.animation.in, duration: printRational(style.animation.in.duration, true) } }
              : {}),
            ...(style.animation.out
              ? { out: { ...style.animation.out, duration: printRational(style.animation.out.duration, true) } }
              : {}),
          },
        }
      : {}),
  }));
}

const time = z.string().regex(/^(?:0|[1-9]\d*)(?:\/[1-9]\d*)?s$/);
const duration = time.refine((value) => !/^0(?:\/\d+)?s$/.test(value), "Duration must be positive");
const id = z.string().min(1).max(200);
const subtitleSchema = z.strictObject({
  transcript_id: id.optional(),
  cue_ids: z.array(id).min(1).optional(),
  request: z.string().max(200).optional(),
});
const uiSchemas = {
  subtitle_tidy: subtitleSchema,
  subtitle_proofread: subtitleSchema,
  ui_state: z.strictObject({}),
  ui_show_panel: z.strictObject({ panel: z.enum([...PANELS, "export", "history"]), sub: z.string().optional() }),
  ui_seek: z.union([z.strictObject({ at: time }), z.strictObject({ id })]),
  ui_select: z.strictObject({ ids: z.array(id) }),
  ui_play: z.strictObject({
    range: z.strictObject({ start: time, duration }).optional(),
    loop: z.boolean().optional(),
  }),
  ui_pause: z.strictObject({}),
};

const uiStateSchema = z.strictObject({
  project: z.string().nullable(),
  panel: z.enum(PANELS),
  sub: z.string().nullable(),
  playhead: z.union([z.strictObject({ at: time }), z.strictObject({ id })]),
  selected: z.array(id),
  playing: z.boolean(),
  range: z.strictObject({ start: time, duration }).nullable(),
  loop: z.boolean(),
  history: z.strictObject({ open: z.boolean(), revision: id.nullable(), label: z.string().nullable() }).optional(),
  export: z
    .strictObject({
      open: z.boolean(),
      sub: z.string().nullable(),
      srt: z.boolean(),
      wav: z.boolean(),
      active: z.string().nullable(),
    })
    .optional(),
  subtitleBrowser: z
    .strictObject({ search: z.string(), find: z.string(), replace: z.string(), matchCase: z.boolean() })
    .optional(),
  chapters: z.strictObject({ levels: z.union([z.literal(1), z.literal(2)]), timecodes: z.boolean() }).optional(),
  mediaBrowser: z
    .strictObject({ scope: z.string(), search: z.string(), size: z.number().int().min(110).max(280) })
    .optional(),
  preview: z.enum(["media", "timeline"]).optional(),
  media: z.strictObject({ id, at: time, in: time.nullable(), out: time.nullable() }).optional(),
});

function uiEnvelope(verb: DesktopVerb, code?: string, message = "", retryable = false): UiEnvelope {
  return {
    ok: !code,
    status: code ? (code === "E_VALIDATION" ? "rejected" : "failed") : "no_op",
    verb,
    request_id: newId("req_"),
    receipt: null,
    changes: [],
    verification: { level: "none", passed: !code, issues: [] },
    result: null,
    error: code ? { code, message, retryable } : null,
  };
}

export function createMcpServer(
  callUi: (verb: DesktopVerb, input: unknown) => Promise<UiEnvelope> = async (verb) =>
    uiEnvelope(verb, "E_APP_NOT_RUNNING", "桌面界面未连接", true),
  kernel: (verb: Verb, input: unknown) => Promise<Envelope> = (verb, input) => dispatch(verb, input),
): Server {
  const mcp = new Server({ name: "zsir-cut-desktop", version: "0.0.0" }, { capabilities: { tools: {} } });
  mcp.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: [
      ...VERBS.map((verb) => ({
        name: `zcut_${verb}`,
        inputSchema: flattenMcpSchema(commandSchemaForVerb(verb)) as { type: "object" },
      })),
      ...DESKTOP_VERBS.map((verb) => ({
        name: `zcut_${verb}`,
        inputSchema: { ...flattenMcpSchema(z.toJSONSchema(uiSchemas[verb])), type: "object" as const },
      })),
    ],
  }));
  mcp.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (!request.params.name.startsWith("zcut_")) throw new Error(`Unknown tool: ${request.params.name}`);
    const verb = request.params.name.slice("zcut_".length);
    let envelope: Envelope | UiEnvelope;
    if (DESKTOP_VERBS.includes(verb as DesktopVerb)) {
      const parsed = uiSchemas[verb as DesktopVerb].safeParse(request.params.arguments ?? {});
      envelope = parsed.success
        ? await callUi(verb as DesktopVerb, parsed.data)
        : uiEnvelope(verb as DesktopVerb, "E_VALIDATION", parsed.error.message);
    } else if (VERBS.includes(verb as Verb)) envelope = await kernel(verb as Verb, request.params.arguments ?? {});
    else throw new Error(`Unknown tool: ${request.params.name}`);
    return { content: [], structuredContent: envelope };
  });
  return mcp;
}

export async function readAiState(
  kernel: (verb: Verb, input: unknown) => Promise<Envelope>,
  project: string,
  batches: Iterable<string>,
) {
  const call = async (verb: Verb, input: Record<string, unknown>) => {
    const envelope = await kernel(verb, { ...input, project });
    if (!envelope.ok) throw new Error(envelope.error?.message ?? "AI state unavailable");
    return envelope.result as Record<string, unknown>;
  };
  const brief = await call("inspect", { view: "brief" });
  const sessions = await Promise.all(
    (brief.sessions as { id: string }[]).map(async ({ id }) => {
      const info = await call("inspect", { view: "session", session_id: id });
      let before: string | undefined;
      let revisionCount = 0;
      for (;;) {
        const history = await call("inspect", {
          view: "history",
          session_id: id,
          limit: 200,
          ...(before ? { before } : {}),
        });
        const entries = history.entries as { revision: string }[];
        revisionCount += entries.length;
        if (entries.length < 200) break;
        before = entries.at(-1)?.revision;
      }
      const diff = await call("diff", { session_id: id, from: info.base_revision, to: info.draft_revision });
      return { ...info, revision_count: revisionCount, changes: diff.changes };
    }),
  );
  const batchStates = await Promise.all([...batches].map((batch_id) => call("batch_status", { batch_id })));
  return { sessions, batches: batchStates };
}

export async function readHistoryBatches(root: string): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(join(root, "batches"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const states = await Promise.all(
    names
      .sort()
      .filter((name) => /^bat_[A-Za-z0-9_-]+$/.test(name))
      .map(async (name) => {
        try {
          const state = JSON.parse(await readFile(join(root, "batches", name, "state.json"), "utf8"));
          return state.target === null && state.state === "open" ? name : null;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
          throw error;
        }
      }),
  );
  return states.filter((id): id is string => id !== null);
}

export async function readFcpIcon(): Promise<string | null> {
  if (process.platform !== "darwin") return null;
  let directory: string | undefined;
  try {
    const run = promisify(execFile);
    const app = "/Applications/Final Cut Pro.app/Contents";
    const { stdout } = await run("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleIconFile", `${app}/Info.plist`]);
    const name = stdout.trim();
    if (!name || name.includes("/") || name.includes("\\")) return null;
    directory = await mkdtemp(join(tmpdir(), "zcut-icon-"));
    const output = join(directory, "fcp.png");
    await run("/usr/bin/sips", [
      "-s",
      "format",
      "png",
      `${app}/Resources/${name.endsWith(".icns") ? name : `${name}.icns`}`,
      "--out",
      output,
    ]);
    return `data:image/png;base64,${(await readFile(output)).toString("base64")}`;
  } catch {
    return null;
  } finally {
    if (directory) await rm(directory, { recursive: true, force: true });
  }
}

export async function startHost(
  options: {
    project?: string;
    port?: number;
    token?: string;
    dispatchOptions?: DispatchOptions;
    appDataDir?: string;
  } = {},
) {
  const token = options.token ?? randomBytes(32).toString("hex");
  if (!token) throw new Error("Token must not be empty");
  const recent = new RecentProjects(options.appDataDir);
  const loadPath = async (path: string) => {
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch {
      throw new Error("找不到或无法读取工程文件");
    }
    const parsed = parseProject(text);
    if (!parsed.ok) throw new Error("工程文件无效，可能已损坏或版本不兼容");
    return parsed.project;
  };
  const load = async () => {
    if (!options.project) throw new Error("No project");
    return loadPath(options.project);
  };
  const initialProject = options.project ? await load() : undefined;
  let serve = mediaChannel(options.project, token, load);
  let entryQueue = Promise.resolve();
  let projectEpoch = 0;
  const httpServers = new Set<Server>();
  const http = createHttpServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/recent-thumb") {
      void (async () => {
        if (url.searchParams.get("token") !== token) {
          response.writeHead(401).end();
          return;
        }
        const row = (await recent.list()).find((row) => row.path === url.searchParams.get("path") && row.exists);
        if (!row) {
          response.writeHead(404).end();
          return;
        }
        const project = await loadPath(row.path);
        const video = project.media.find((item) => item.kind === "video");
        if (!video) {
          response.writeHead(404).end();
          return;
        }
        const image = await runFfmpeg([
          "-i",
          resolve(dirname(row.path), video.path),
          "-frames:v",
          "1",
          "-vf",
          "scale=160:-1",
          "-f",
          "image2pipe",
          "-vcodec",
          "mjpeg",
          "pipe:1",
        ]);
        response.writeHead(200, { "Content-Type": "image/jpeg" }).end(image);
      })().catch(() => {
        if (!response.headersSent) response.writeHead(404);
        response.end();
      });
      return;
    }
    if (new URL(request.url ?? "/", "http://127.0.0.1").pathname !== "/mcp") {
      void serve(request, response);
      return;
    }
    const supplied = Buffer.from(request.headers.authorization ?? "");
    const expected = Buffer.from(`Bearer ${token}`);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      response.writeHead(401).end();
      return;
    }
    void (async () => {
      const server = createMcpServer(callUi, agentKernel);
      httpServers.add(server);
      const transport = new StreamableHTTPServerTransport();
      response.once("close", () => {
        httpServers.delete(server);
        void server.close();
      });
      // SDK callback declarations do not support exactOptionalPropertyTypes.
      await server.connect(transport as import("@modelcontextprotocol/sdk/shared/transport.js").Transport);
      await transport.handleRequest(request, response);
    })().catch(() => {
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  });
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  let ui: WebSocket | undefined;
  const pending = new Map<string, { resolve: (value: UiEnvelope) => void; timer: NodeJS.Timeout; verb: DesktopVerb }>();
  const disconnected = () => {
    for (const [key, item] of pending) {
      clearTimeout(item.timer);
      item.resolve(uiEnvelope(item.verb, "E_APP_NOT_RUNNING", "界面已断开", true));
      pending.delete(key);
    }
  };
  const batches = new Set<string>();
  let agents: Agents | undefined;
  let subtitlePass: SubtitlePass | undefined;
  const notify = (type: string) => {
    if (ui?.readyState === WebSocket.OPEN) ui.send(JSON.stringify({ type }));
  };
  const kernel = async (verb: Verb, input: unknown) => {
    const epoch = projectEpoch;
    const envelope = await dispatch(verb, input, options.dispatchOptions);
    if (epoch !== projectEpoch || verb === "create_project") return envelope;
    subtitlePass?.observe(verb, input, envelope);
    const job = verb === "job_status" ? (envelope.result as { envelope?: { receipt?: unknown } } | null) : null;
    if (envelope.receipt || job?.envelope?.receipt) notify("project_changed");
    const request = input as { batch?: { id?: string } };
    if (envelope.ok && request?.batch?.id) {
      batches.add(request.batch.id);
      if (!envelope.receipt) notify("project_changed");
    }
    if (["session_begin", "session_ask", "session_answer", "session_review", "session_approve", "edit"].includes(verb))
      notify("ai_changed");
    return envelope;
  };
  const agentKernel = async (verb: Verb, input: unknown) => {
    if (!options.project) throw new Error("No current project");
    const request = input as Record<string, unknown>;
    if (
      typeof request.project !== "string" ||
      resolve(dirname(resolve(options.project)), request.project) !== resolve(options.project)
    )
      throw new Error("Agent must use the current project");
    return kernel(verb, { ...request, project: options.project });
  };
  const callUi = async (verb: DesktopVerb, input: unknown): Promise<UiEnvelope> => {
    if (!ui || ui.readyState !== WebSocket.OPEN) return uiEnvelope(verb, "E_APP_NOT_RUNNING", "桌面界面未连接", true);
    if (SUBTITLE_VERBS.includes(verb as SubtitleVerb)) {
      const parsed = subtitleSchema.safeParse(input);
      if (!parsed.success) return uiEnvelope(verb, "E_VALIDATION", parsed.error.message);
      if (!subtitlePass) return uiEnvelope(verb, "E_VALIDATION", "请先打开工程");
      try {
        const result = await subtitlePass.start(verb as SubtitleVerb, parsed.data as SubtitlePassParams);
        return "code" in result
          ? uiEnvelope(verb, result.code, result.message, result.retryable)
          : { ...uiEnvelope(verb), status: "accepted", result };
      } catch (error) {
        return uiEnvelope(verb, "E_IO", error instanceof Error ? error.message : "无法读取字幕");
      }
    }
    const envelope = uiEnvelope(verb);
    const requestId = envelope.request_id;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(requestId);
        resolve(uiEnvelope(verb, "E_APP_NOT_RUNNING", "界面响应超时", true));
      }, 10000);
      pending.set(requestId, { resolve, timer, verb });
      ui?.send(JSON.stringify({ type: "ui_request", id: requestId, verb, request: input }));
    });
  };
  http.on("upgrade", (request, socket, head) => {
    const supplied = new URL(request.url ?? "/", "http://127.0.0.1").searchParams.get("token") ?? "";
    const left = Buffer.from(supplied);
    const right = Buffer.from(token);
    if (left.length !== right.length || !timingSafeEqual(left, right)) {
      socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      return;
    }
    sockets.handleUpgrade(request, socket, head, (client) => sockets.emit("connection", client));
  });
  sockets.on("connection", (client: WebSocket) => {
    client.on("error", () => client.close());
    client.on("close", () => {
      if (ui === client) {
        ui = undefined;
        disconnected();
      }
    });
    client.on("message", async (raw) => {
      const message = (() => {
        try {
          return JSON.parse(raw.toString());
        } catch {
          return null;
        }
      })();
      if (!message || typeof message !== "object" || Array.isArray(message)) {
        client.close(1008, "Invalid message");
        return;
      }
      try {
        if (message.type === "ui_ready") {
          if (ui && ui !== client) {
            client.close(1008, "UI already connected");
            return;
          }
          ui = client;
          client.send(
            JSON.stringify({ type: "bootstrap", project: options.project ?? null, fcpIcon: await readFcpIcon() }),
          );
          return;
        }
        if (
          typeof message.id === "string" &&
          ["project_open", "recent_projects", "recent_remove"].includes(message.verb)
        ) {
          if (client !== ui) throw new Error("界面未连接");
          const request = message.request ?? {};
          const operation = entryQueue.then(async () => {
            if (message.verb === "project_open") {
              if (request.path !== null && (typeof request.path !== "string" || !request.path.endsWith(".zcut.json")))
                throw new Error("请选择 .zcut.json 工程文件");
              await bind(request.path);
            }
            if (message.verb === "recent_remove") await recent.remove(request.path);
            client.send(JSON.stringify({ id: message.id, envelope: { ok: true, result: await recent.list() } }));
          });
          entryQueue = operation.catch(() => {});
          await operation;
          return;
        }
        if (message.type === "ui_result" && client === ui) {
          const item = pending.get(message.id);
          if (item) {
            clearTimeout(item.timer);
            pending.delete(message.id);
            const parsed = uiStateSchema.safeParse(message.result);
            item.resolve(
              parsed.success
                ? {
                    ...uiEnvelope(item.verb),
                    request_id: message.id,
                    result: {
                      ...parsed.data,
                      subtitlePass: subtitlePass?.state,
                      subtitle_pass: subtitlePass?.latest ?? null,
                      subtitle_selection: null,
                    },
                  }
                : uiEnvelope(item.verb, "E_INTERNAL", "Invalid UI state"),
            );
          }
          return;
        }
        if (message.type === "preview_data" && typeof message.id === "string") {
          const projectPath = options.project;
          if (!projectPath) throw new Error("No project");
          const project =
            typeof message.at_revision === "string"
              ? await openProject({ projectPath }).snapshotAt(message.at_revision)
              : await loadPath(projectPath);
          const timeline = project.timelines[0];
          const journal = await openProject({ projectPath }).journal();
          const lastRecognition = journal.findLast((entry) => entry.verb === "transcribe");
          const cues = timeline
            ? projectSubtitles(project, timeline.id).cues.map((cue) => ({
                ...cue,
                text_override: timeline.tracks.some(
                  (track) =>
                    track.kind === "subtitle" &&
                    track.id === cue.track_id &&
                    track.overrides.some(
                      (item) =>
                        item.occurrence_id === cue.occurrence_id &&
                        item.cue_id === cue.cue_id &&
                        item.text !== undefined,
                    ),
                ),
                transcript_id: project.transcripts.find((item) => item.cues.some((row) => row.id === cue.cue_id))?.id,
                tokens: project.transcripts
                  .find((item) => item.cues.some((row) => row.id === cue.cue_id))
                  ?.tokens.filter((token) => cue.token_ids.includes(token.id))
                  .map(({ id, text }) => ({ id, text })),
                start: printRational(cue.start, true),
                end: printRational(cue.end, true),
              }))
            : [];
          client.send(
            JSON.stringify({
              id: message.id,
              envelope: {
                ok: true,
                verification: {
                  level: "none",
                  passed: true,
                  issues:
                    subtitlePass?.state.warnings.map((warning) => ({
                      code: warning.code,
                      severity: "warning",
                      message: warning.reason,
                      ids: [warning.transcript_id],
                    })) ?? [],
                },
                result: {
                  historyBatches: await readHistoryBatches(join(dirname(resolve(projectPath)), ".zcut", project.id)),
                  media: project.media.map((item) => ({
                    uses: new Set(
                      timeline?.tracks.flatMap((track) =>
                        track.kind === "subtitle"
                          ? []
                          : track.clips.filter((clip) => clip.media_id === item.id).map((clip) => clip.occurrence_id),
                      ) ?? [],
                    ).size,
                    id: item.id,
                    name: item.path.split("/").at(-1),
                    kind: item.kind,
                    path: resolve(dirname(projectPath), item.path),
                    duration: printRational(item.duration, true),
                    start_timecode: item.start_timecode,
                    reel: item.reel,
                    video: item.video
                      ? {
                          ...item.video,
                          rate: printRational(item.video.rate),
                          pixel_aspect: item.video.pixel_aspect ? printRational(item.video.pixel_aspect) : undefined,
                        }
                      : undefined,
                    audio: item.audio
                      ? { ...item.audio, sample_rate: printRational(item.audio.sample_rate) }
                      : undefined,
                    organize: item.organize,
                  })),
                  subtitleOverlays:
                    project.subtitle_overlays?.map((item) => ({
                      ...item,
                      tail: printRational(item.tail ?? { numerator: 10n, denominator: 1n }, true),
                    })) ?? [],
                  cues,
                  styles: subtitleStylesForPreview(project.subtitle_styles),
                  subtitleTracks:
                    timeline?.tracks
                      .filter((track) => track.kind === "subtitle")
                      .map((track) => ({
                        id: track.id,
                        name: track.name,
                        default_style_id: track.default_style_id,
                      })) ?? [],
                  subtitlePass: subtitlePass?.state,
                  unprocessedTranscripts: project.transcripts
                    .filter((t) => t.cues.length && t.ext?.["zsir.subtitle_pass"] === undefined)
                    .map((t) => t.id),
                  recognition: project.recognition,
                  recognized: project.transcripts.some((item) => item.raw_runs.some((run) => run.kind === "asr")),
                  recognitionRevision: lastRecognition?.seq,
                  format: timeline ? { width: timeline.format.width, height: timeline.format.height } : undefined,
                  subtitleWarnings: [
                    ...validateProjectSemantics(project).filter((issue) => issue.code.startsWith("W_SUB_")),
                    ...project.transcripts.flatMap((transcript) =>
                      displayRanges(transcript).flatMap((row) =>
                        row.warnings.map((code) => ({ code, ids: [row.cue.id] })),
                      ),
                    ),
                  ],
                },
              },
            }),
          );
          return;
        }
        if (typeof message.id === "string" && typeof message.verb === "string" && message.verb.startsWith("chat_")) {
          try {
            if (!agents) throw new Error("未打开工程");
            const request = message.request ?? {};
            let result: unknown;
            if (message.verb === "chat_select") {
              if (!["claude", "codex"].includes(request.agent)) throw new Error("Invalid Agent");
              const changedAgent = agents.selected !== request.agent;
              agents.selected = request.agent;
              if (changedAgent) void subtitlePass?.retryFailed().catch(() => {});
              result = {};
            } else if (message.verb === "chat_subtitle_retry") {
              void subtitlePass?.retryFailed().catch(() => {});
              result = {};
            } else if (message.verb === "chat_agents") result = await agents.detect();
            else if (message.verb === "chat_list") result = await agents.list();
            else if (message.verb === "chat_history") result = await agents.history(request.id);
            else if (message.verb === "chat_send")
              result = await agents.send(request.agent, request.text, request.chat_id);
            else if (message.verb === "chat_stop") {
              await agents.stop();
              result = {};
            } else throw new Error("Unknown chat request");
            if (client.readyState === WebSocket.OPEN)
              client.send(JSON.stringify({ id: message.id, envelope: { ok: true, result } }));
          } catch (error) {
            if (client.readyState === WebSocket.OPEN)
              client.send(
                JSON.stringify({ id: message.id, envelope: { ok: false, error: { message: String(error) } } }),
              );
          }
          return;
        }
        if (typeof message.id === "string" && message.verb === "ai_state") {
          try {
            if (!options.project) throw new Error("未打开工程");
            const result = await readAiState(kernel, options.project, batches);
            if (client.readyState === WebSocket.OPEN)
              client.send(JSON.stringify({ id: message.id, envelope: { ok: true, result } }));
          } catch (error) {
            if (client.readyState === WebSocket.OPEN)
              client.send(
                JSON.stringify({ id: message.id, envelope: { ok: false, error: { message: String(error) } } }),
              );
          }
          return;
        }
        if (typeof message.id === "string" && message.verb === "export_preferences") {
          const project = await load();
          const result = await exportPreferences(options.project as string, project.id, message.request?.value);
          client.send(JSON.stringify({ id: message.id, envelope: { ok: true, result } }));
          return;
        }
        if (typeof message.id !== "string" || typeof message.verb !== "string") {
          client.close(1008, "Invalid message");
          return;
        }
        if (SUBTITLE_VERBS.includes(message.verb)) {
          const envelope = await callUi(message.verb as SubtitleVerb, message.request ?? {});
          if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify({ id: message.id, envelope }));
          return;
        }
        if (!VERBS.includes(message.verb)) throw new Error(`Unknown request: ${message.verb}`);
        const envelope = await kernel(message.verb as Verb, message.request);
        if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify({ id: message.id, envelope }));
      } catch (error) {
        if (typeof message.id === "string" && client.readyState === WebSocket.OPEN)
          client.send(JSON.stringify({ id: message.id, envelope: { ok: false, error: { message: String(error) } } }));
      }
    });
  });
  http.listen(options.port ?? 0, "127.0.0.1");
  await once(http, "listening");
  const address = http.address();
  if (!address || typeof address === "string") throw new Error("No host port");
  const bind = async (path: string | null) => {
    const next = path ? await loadPath(path) : undefined;
    if (path && next) await recent.add(path, next.name);
    await subtitlePass?.stop();
    subtitlePass = undefined;
    await agents?.stop();
    agents = undefined;
    projectEpoch++;
    batches.clear();
    disconnected();
    if (path) options.project = resolve(path);
    else delete options.project;
    serve = mediaChannel(path ?? undefined, token, path ? () => loadPath(path) : load);
    if (options.project && next)
      agents = new Agents({
        project: options.project,
        projectId: next.id,
        url: `http://127.0.0.1:${address.port}/mcp`,
        token,
        emit: (chat, event) => {
          if (ui?.readyState === WebSocket.OPEN) ui.send(JSON.stringify({ type: "chat_event", chat, event }));
          if (event.type === "end") notify("ai_changed");
        },
      });
    if (options.project && agents) {
      const currentAgents = agents;
      currentAgents.selected = (await currentAgents.list().catch(() => []))[0]?.agent;
      const project = options.project;
      subtitlePass = new SubtitlePass({
        project,
        load: () => loadPath(project),
        transcribed: async (revision) => {
          const entry = (await openProject({ projectPath: project }).journal()).find(
            (entry) => entry.verb === "transcribe" && entry.revision === revision,
          );
          return [
            ...new Set(
              entry?.changes
                ?.filter((change) => change.entity === "run" && change.after !== null)
                .map((change) => change.after_parent)
                .filter((id): id is string => typeof id === "string") ?? [],
            ),
          ];
        },
        dispatch: kernel,
        detect: () => currentAgents.detect(),
        selected: () => currentAgents.selected,
        run: (agent, prompt, signal) => currentAgents.subtitlePass(agent, prompt, signal),
        changed: () => notify("project_changed"),
      });
      void subtitlePass.open().catch(() => {});
    }
    if (ui?.readyState === WebSocket.OPEN)
      ui.send(JSON.stringify({ type: "bootstrap", project: options.project ?? null, fcpIcon: await readFcpIcon() }));
  };
  if (options.project && initialProject) await bind(options.project);
  const mcp = createMcpServer(callUi, agentKernel);
  return {
    port: address.port,
    token,
    mcp,
    close: async () => {
      await subtitlePass?.stop();
      await agents?.stop();
      await Promise.all([...httpServers].map((server) => server.close()));
      disconnected();
      for (const client of sockets.clients) client.terminate();
      await new Promise<void>((resolve) => sockets.close(() => resolve()));
      await new Promise<void>((resolve, reject) => http.close((error) => (error ? reject(error) : resolve())));
      await mcp.close();
    },
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const args = parseArgs({
      options: {
        project: { type: "string" },
        port: { type: "string" },
        token: { type: "string" },
        desktop: { type: "boolean" },
      },
      allowPositionals: true,
    });
    const project = args.values.project ?? args.positionals[0];
    const host = await startHost({
      ...(project ? { project } : {}),
      ...(args.values.port ? { port: Number(args.values.port) } : {}),
      ...(args.values.token ? { token: args.values.token } : {}),
    });
    if (args.values.desktop) process.stdout.write(`${host.port} ${host.token}\n`);
    await host.mcp.connect(new StdioServerTransport());
    const close = () => {
      void host.close().finally(() => process.exit());
    };
    process.once("SIGTERM", close);
    process.once("SIGINT", close);
    process.stdin.once("end", close);
  } catch (error) {
    process.stderr.write(`${String(error)}\n`);
    process.exitCode = 1;
  }
}
