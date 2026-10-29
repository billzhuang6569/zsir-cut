#!/usr/bin/env node
import { execFile } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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
import type { DispatchOptions, Envelope, Verb } from "../../core/dist/index.js";
import { Agents } from "./agents.js";
import { mediaChannel } from "./media.js";
import { PANELS, UI_VERBS, type UiEnvelope, type UiVerb } from "./ui.js";

const {
  dispatch,
  commandSchemaForVerb,
  newId,
  VERBS,
  parseProject,
  projectSubtitles,
  printRational,
}: typeof import("../../core/dist/index.js") = await import(
  new URL(import.meta.url.endsWith(".ts") ? "../../core/src/index.ts" : "../../core/dist/index.js", import.meta.url)
    .href
);
const time = z.string().regex(/^(?:0|[1-9]\d*)(?:\/[1-9]\d*)?s$/);
const duration = time.refine((value) => !/^0(?:\/\d+)?s$/.test(value), "Duration must be positive");
const id = z.string().min(1).max(200);
const uiSchemas = {
  ui_state: z.strictObject({}),
  ui_show_panel: z.strictObject({ panel: z.enum(PANELS), sub: z.string().optional() }),
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
});

function uiEnvelope(verb: UiVerb, code?: string, message = "", retryable = false): UiEnvelope {
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
  callUi: (verb: UiVerb, input: unknown) => Promise<UiEnvelope> = async (verb) =>
    uiEnvelope(verb, "E_APP_NOT_RUNNING", "桌面界面未连接", true),
  kernel: (verb: Verb, input: unknown) => Promise<Envelope> = (verb, input) => dispatch(verb, input),
): Server {
  const mcp = new Server({ name: "zsir-cut-desktop", version: "0.0.0" }, { capabilities: { tools: {} } });
  mcp.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: [
      ...VERBS.map((verb) => ({ name: `zcut_${verb}`, inputSchema: commandSchemaForVerb(verb) as { type: "object" } })),
      ...UI_VERBS.map((verb) => ({
        name: `zcut_${verb}`,
        inputSchema: { ...z.toJSONSchema(uiSchemas[verb]), type: "object" as const },
      })),
    ],
  }));
  mcp.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (!request.params.name.startsWith("zcut_")) throw new Error(`Unknown tool: ${request.params.name}`);
    const verb = request.params.name.slice("zcut_".length);
    let envelope: Envelope | UiEnvelope;
    if (UI_VERBS.includes(verb as UiVerb)) {
      const parsed = uiSchemas[verb as UiVerb].safeParse(request.params.arguments ?? {});
      envelope = parsed.success
        ? await callUi(verb as UiVerb, parsed.data)
        : uiEnvelope(verb as UiVerb, "E_VALIDATION", parsed.error.message);
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
  options: { project?: string; port?: number; token?: string; dispatchOptions?: DispatchOptions } = {},
) {
  const token = options.token ?? randomBytes(32).toString("hex");
  if (!token) throw new Error("Token must not be empty");
  const load = async () => {
    if (!options.project) throw new Error("No project");
    const parsed = parseProject(await readFile(options.project, "utf8"));
    if (!parsed.ok) throw new Error("Invalid project");
    return parsed.project;
  };
  const initialProject = options.project ? await load() : undefined;
  const serve = mediaChannel(options.project, token, load);
  const httpServers = new Set<Server>();
  const http = createHttpServer((request, response) => {
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
  const pending = new Map<string, { resolve: (value: UiEnvelope) => void; timer: NodeJS.Timeout; verb: UiVerb }>();
  const disconnected = () => {
    for (const [key, item] of pending) {
      clearTimeout(item.timer);
      item.resolve(uiEnvelope(item.verb, "E_APP_NOT_RUNNING", "界面已断开", true));
      pending.delete(key);
    }
  };
  const batches = new Set<string>();
  let agents: Agents | undefined;
  const notify = (type: string) => {
    if (ui?.readyState === WebSocket.OPEN) ui.send(JSON.stringify({ type }));
  };
  const kernel = async (verb: Verb, input: unknown) => {
    const envelope = await dispatch(verb, input, options.dispatchOptions);
    if (envelope.receipt) notify("project_changed");
    const request = input as { batch?: { id?: string } };
    if (envelope.ok && request?.batch?.id) batches.add(request.batch.id);
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
  const callUi = async (verb: UiVerb, input: unknown): Promise<UiEnvelope> => {
    if (!ui || ui.readyState !== WebSocket.OPEN) return uiEnvelope(verb, "E_APP_NOT_RUNNING", "桌面界面未连接", true);
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
      try {
        const message = JSON.parse(raw.toString());
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
        if (message.type === "ui_result" && client === ui) {
          const item = pending.get(message.id);
          if (item) {
            clearTimeout(item.timer);
            pending.delete(message.id);
            const parsed = uiStateSchema.safeParse(message.result);
            item.resolve(
              parsed.success
                ? { ...uiEnvelope(item.verb), request_id: message.id, result: parsed.data }
                : uiEnvelope(item.verb, "E_INTERNAL", "Invalid UI state"),
            );
          }
          return;
        }
        if (message.type === "preview_data" && typeof message.id === "string") {
          const project = await load();
          const timeline = project.timelines[0];
          const defaultStyles = new Map(
            timeline?.tracks.flatMap((track) =>
              track.kind === "subtitle" ? [[track.id, track.default_style_id] as const] : [],
            ) ?? [],
          );
          const cues = timeline
            ? projectSubtitles(project, timeline.id).cues.map((cue) => ({
                ...cue,
                style_id: defaultStyles.get(cue.track_id) ?? cue.style_id,
                start: printRational(cue.start, true),
                end: printRational(cue.end, true),
              }))
            : [];
          client.send(
            JSON.stringify({
              id: message.id,
              envelope: {
                ok: true,
                result: {
                  media: project.media.map((item) => ({ id: item.id, name: item.name, kind: item.kind })),
                  cues,
                  styles: project.subtitle_styles,
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
            if (message.verb === "chat_agents") result = await agents.detect();
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
        if (typeof message.id !== "string" || !VERBS.includes(message.verb)) {
          client.close(1008, "Invalid message");
          return;
        }
        const envelope = await kernel(message.verb as Verb, message.request);
        if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify({ id: message.id, envelope }));
      } catch {
        client.close(1008, "Invalid message");
      }
    });
  });
  http.listen(options.port ?? 0, "127.0.0.1");
  await once(http, "listening");
  const address = http.address();
  if (!address || typeof address === "string") throw new Error("No host port");
  if (options.project && initialProject) {
    agents = new Agents({
      project: resolve(options.project),
      projectId: initialProject.id,
      url: `http://127.0.0.1:${address.port}/mcp`,
      token,
      emit: (chat, event) => {
        if (ui?.readyState === WebSocket.OPEN) ui.send(JSON.stringify({ type: "chat_event", chat, event }));
        if (event.type === "end") notify("ai_changed");
      },
    });
  }
  const mcp = createMcpServer(callUi, kernel);
  return {
    port: address.port,
    token,
    mcp,
    close: async () => {
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
