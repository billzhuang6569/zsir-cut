import { spawnSync } from "node:child_process";
import { on, once } from "node:events";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import type { Envelope } from "../../core/src/index.ts";
import { dispatch, VERBS } from "../../core/src/index.ts";
import { Agents } from "../src/agents.js";
import { createMcpServer, readAiState, readHistoryBatches, startHost, subtitleStylesForPreview } from "../src/index.js";
import { DESKTOP_VERBS, SUBTITLE_VERBS, UI_VERBS } from "../src/ui.js";

let appDataDir: string;
beforeEach(async () => {
  vi.spyOn(Agents.prototype, "detect").mockResolvedValue([]);
  vi.spyOn(Agents.prototype, "subtitlePass").mockRejectedValue(new Error("Unexpected Agent call in host test"));
  appDataDir = await mkdtemp(join(tmpdir(), "zcut-recent-test-"));
});
let host: Awaited<ReturnType<typeof startHost>> | undefined;
afterEach(async () => {
  await host?.close();
  host = undefined;
  await rm(appDataDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});
const project = fileURLToPath(new URL("../../../examples/interview.zcut.json", import.meta.url));
const cli = fileURLToPath(new URL("../../cli/src/index.ts", import.meta.url));
const comparable = (envelope: Record<string, unknown>) => ({ ...envelope, request_id: "ignored" });
async function connect() {
  host = await startHost({ project, appDataDir });
  const socket = new WebSocket(`ws://127.0.0.1:${host.port}/?token=${host.token}`);
  await once(socket, "open");
  return socket;
}
async function sendMessage(socket: WebSocket, message: Record<string, unknown>) {
  const replies = on(socket, "message", { signal: AbortSignal.timeout(3000) });
  socket.send(JSON.stringify(message));
  for await (const [raw] of replies) {
    const result = JSON.parse(raw.toString());
    if (message.id !== undefined ? result.id !== message.id : result.type !== "bootstrap") continue;
    expect(socket.readyState).toBe(WebSocket.OPEN);
    return result;
  }
  throw new Error("Missing response");
}
async function mcpClient() {
  if (!host) throw new Error("Missing host");
  const client = new Client({ name: "host-test", version: "1" });
  const [server, transport] = InMemoryTransport.createLinkedPair();
  await Promise.all([host.mcp.connect(server), client.connect(transport)]);
  return client;
}

describe("desktop host", () => {
  it.each([
    { request: { type: "ui_ready" }, reply: { type: "bootstrap", project } },
    { request: { id: "matching", verb: "inspect" }, reply: { id: "matching", type: "result" } },
  ])("ignores unrelated messages while waiting for $request", async ({ request, reply }) => {
    const socket = await connect();
    try {
      vi.spyOn(socket, "send").mockImplementationOnce(() => {
        for (const message of [{ type: "preview_cache" }, { id: "other", type: "result" }, reply])
          socket.emit("message", Buffer.from(JSON.stringify(message)));
      });
      expect(await sendMessage(socket, request)).toEqual(reply);
    } finally {
      socket.terminate();
    }
  });

  it("serializes preview rationals and keeps the connection usable after a request fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "zcut-preview-rational-"));
    const project = join(directory, "project.zcut.json");
    const fixture = new URL("../../../fixtures/regressions/preview-media-rational.zcut.json", import.meta.url);
    await copyFile(fixture, project);
    host = await startHost({ project, appDataDir });
    const socket = new WebSocket(`ws://127.0.0.1:${host.port}/?token=${host.token}`);
    try {
      await once(socket, "open");
      const send = (message: Record<string, unknown>) => sendMessage(socket, message);
      expect(await send({ type: "ui_ready" })).toMatchObject({ type: "bootstrap", project });
      for (const view of ["brief", "timeline"])
        expect(await send({ id: view, verb: "inspect", request: { project, view } })).toMatchObject({
          envelope: { ok: true },
        });
      expect(await send({ id: "preview", type: "preview_data" })).toMatchObject({
        envelope: {
          ok: true,
          result: {
            format: { width: 1920, height: 1080 },
            recognized: false,
            subtitleWarnings: [],
            media: [
              {
                duration: "60001/1000s",
                video: { rate: "30000/1001", pixel_aspect: "4/3" },
                audio: { sample_rate: "48000", channels: 2 },
              },
            ],
          },
        },
      });
      const subtitles = JSON.parse(
        await readFile(new URL("../../../examples/interview.zcut.json", import.meta.url), "utf8"),
      );
      subtitles.recognition = { language: "zh", reference_text: "完整参考稿", terms: ["专有名词"] };
      subtitles.subtitle_styles.push({ ...subtitles.subtitle_styles[0], id: "sty_override", name: "覆盖样式" });
      subtitles.timelines[0].tracks
        .find((track: { kind: string }) => track.kind === "subtitle")
        .overrides.push({ occurrence_id: "occ_1", cue_id: "cue_1", text: "覆盖文字", style_id: "sty_override" });
      await writeFile(project, JSON.stringify(subtitles));
      const preview = await send({ id: "subtitle-preview", type: "preview_data" });
      expect(preview.envelope.result).toMatchObject({
        recognition: subtitles.recognition,
        recognized: true,
        subtitleTracks: subtitles.timelines[0].tracks
          .filter((track: { kind: string }) => track.kind === "subtitle")
          .map((track: { id: string; name: string; default_style_id: string }) => ({
            id: track.id,
            name: track.name,
            default_style_id: track.default_style_id,
          })),
      });
      expect(preview.envelope.result.cues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            cue_id: "cue_1",
            transcript_id: "trs_cam_a_zh",
            style_id: "sty_override",
            text_override: true,
            tokens: expect.arrayContaining([expect.objectContaining({ id: "tok_01", text: "我们" })]),
            locked: expect.any(Boolean),
            breaks: expect.any(Array),
          }),
        ]),
      );
      expect(
        preview.envelope.result.cues.find((cue: { cue_id: string }) => cue.cue_id === "cue_1").words,
      ).toBeUndefined();
      const aligned = preview.envelope.result.cues.find((cue: { words?: unknown[] }) => cue.words?.length);
      expect(aligned.words[0]).toMatchObject({
        text: expect.any(String),
        start: expect.stringMatching(/s$/),
        end: expect.stringMatching(/s$/),
      });
      expect(
        (
          await dispatch("edit", {
            project,
            base_revision: subtitles.revision.id,
            idempotency_key: "history-preview",
            author: { kind: "human", name: "测试" },
            label: "修改识别语言",
            ops: [{ op: "set_recognition", language: "en" }],
          })
        ).ok,
      ).toBe(true);
      expect(
        (
          await send({
            id: "historical-preview",
            type: "preview_data",
            at_revision: subtitles.revision.id,
          })
        ).envelope.result.recognition.language,
      ).toBe("zh");
      expect((await send({ id: "present-preview", type: "preview_data" })).envelope.result.recognition.language).toBe(
        "en",
      );
      const mainRevision = (await dispatch("inspect", { project, view: "brief" })).result?.project as {
        revision: { id: string };
      };
      const begun = await dispatch("session_begin", {
        project,
        base_revision: mainRevision.revision.id,
        idempotency_key: "draft-preview-begin",
        author: { kind: "human", name: "test" },
        approval: "manual",
        intent: "校对字幕",
      });
      const session_id = begun.result?.session_id as string;
      const edited = await dispatch("edit", {
        project,
        session_id,
        base_revision: mainRevision.revision.id,
        idempotency_key: "draft-preview-edit",
        author: { kind: "human", name: "test" },
        ops: [
          {
            op: "set_override",
            track_id: "trk_sub_zh",
            occurrence_id: "occ_1",
            cue_id: "cue_1",
            text: "草稿字幕",
            force: true,
          },
        ],
      });
      expect(edited.status, JSON.stringify(edited)).toBe("drafted");
      const draftPreview = await send({
        id: "draft-preview",
        type: "preview_data",
        session_id,
        at_revision: edited.receipt?.after,
      });
      const originalCue = preview.envelope.result.cues.find((cue: { cue_id: string }) => cue.cue_id === "cue_1");
      expect(draftPreview.envelope.result.cues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            cue_id: "cue_1",
            text: "草稿字幕",
            track_id: "trk_sub_zh",
            start: originalCue.start,
            end: originalCue.end,
          }),
        ]),
      );
      const basePreview = await send({
        id: "draft-base-preview",
        type: "preview_data",
        session_id,
        at_revision: mainRevision.revision.id,
      });
      expect(basePreview.envelope.result.cues).toEqual(preview.envelope.result.cues);
      expect((await send({ id: "main-stays", type: "preview_data" })).envelope.result.cues).toEqual(
        preview.envelope.result.cues,
      );
      expect((await dispatch("inspect", { project, view: "session", session_id })).result?.state).toBe("open");
      await writeFile(project, "{}");
      expect(await send({ id: "failed-preview", type: "preview_data" })).toMatchObject({
        envelope: { ok: false, error: { message: expect.stringContaining("工程文件无效，可能已损坏或版本不兼容") } },
      });
      await copyFile(fixture, project);
      expect(await send({ id: "unknown", verb: "unknown", request: {} })).toMatchObject({
        envelope: { ok: false, error: { message: expect.stringContaining("Unknown request") } },
      });
      expect(await send({ id: "recovered", verb: "inspect", request: { project, view: "brief" } })).toMatchObject({
        envelope: { ok: true },
      });
    } finally {
      socket.terminate();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each(["{", "null", "[]", "{}", '{"type":"preview_data"}'])(
    "rejects malformed protocol messages: %s",
    async (raw) => {
      const socket = await connect();
      try {
        const closed = once(socket, "close");
        socket.send(raw);
        expect((await closed)[0]).toBe(1008);
      } finally {
        socket.terminate();
      }
    },
  );

  it("matches CLI envelopes over the authenticated loopback channel", async () => {
    const socket = await connect();
    try {
      for (const [verb, request] of [
        ["inspect", { project, view: "brief" }],
        ["inspect", { project, view: "timeline" }],
        ["inspect", { project, view: "invalid" }],
        ["inspect", { project: `${project}.missing`, view: "brief" }],
      ] as const) {
        const reply = await sendMessage(socket, { id: "1", verb, request });
        const run = spawnSync(process.execPath, [cli, verb], { encoding: "utf8", input: JSON.stringify(request) });
        expect(comparable(reply.envelope)).toEqual(comparable(JSON.parse(run.stdout)));
      }
    } finally {
      socket.terminate();
    }
  }, 15000);

  it("rejects missing and wrong tokens before upgrading", async () => {
    host = await startHost({ appDataDir });
    for (const query of ["", "?token=wrong"]) {
      const socket = new WebSocket(`ws://127.0.0.1:${host.port}/${query}`);
      const error = await new Promise<Error>((resolve) => socket.once("error", resolve));
      expect(error.message).toContain("401");
      socket.terminate();
    }
  });

  it("round trips edit points, chapter views and history through the host to MCP", async () => {
    const socket = await connect();
    const client = await mcpClient();
    let extra: Record<string, unknown> = {};
    const state = {
      project,
      panel: "chapters",
      sub: "timeline",
      playhead: { at: "0s" },
      selected: [],
      playing: false,
      range: null,
      loop: false,
    };
    try {
      socket.on("message", (raw) => {
        const message = JSON.parse(raw.toString());
        if (message.type === "ui_request")
          socket.send(JSON.stringify({ type: "ui_result", id: message.id, result: { ...state, ...extra } }));
      });
      await sendMessage(socket, { type: "ui_ready" });
      for (const fields of [
        { edit_point: null, chapters: { view: "outline" }, history: { open: false, viewing: null } },
        {
          edit_point: { track_id: "trk_v1", at: "1001/300s" },
          chapters: { view: "timeline" },
          history: { open: true, viewing: "rev_previous" },
        },
        {
          edit_point: { track_id: "trk_v1", at: "4s" },
          snap: false,
          chapters: { view: "timeline", levels: 2, timecodes: true, zoom: 1, folded: ["mrk_one"] },
          history: { open: true, viewing: "rev_previous", revision: "rev_previous", label: "上一步" },
        },
      ]) {
        extra = fields;
        const reply = await client.callTool({ name: "zcut_ui_state", arguments: {} });
        expect(reply.structuredContent).toMatchObject({ ok: true, status: "no_op", result: { ...state, ...fields } });
      }
      for (const fields of [
        { edit_point: { track_id: "trk_v1", at: "invalid" } },
        { edit_point: { track_id: "trk_v1", at: "4s", extra: true } },
        { chapters: { view: "invalid" } },
        { history: { open: true, viewing: 1 } },
        { unknown: true },
      ]) {
        extra = fields;
        const reply = await client.callTool({ name: "zcut_ui_state", arguments: {} });
        expect(reply.structuredContent).toMatchObject({ ok: false, error: { code: "E_INTERNAL" } });
      }
    } finally {
      socket.terminate();
      await client.close();
    }
  });

  it("lists all kernel and UI MCP tools, reports no UI, and forwards UI requests", async () => {
    const socket = await connect();
    const client = await mcpClient();
    try {
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toEqual([...VERBS, ...DESKTOP_VERBS].map((verb) => `zcut_${verb}`));
      expect(tools.tools).toHaveLength(VERBS.length + DESKTOP_VERBS.length);
      const missing = await client.callTool({ name: "zcut_ui_seek", arguments: { at: "1s" } });
      expect(missing.structuredContent).toMatchObject({
        status: "failed",
        error: { code: "E_APP_NOT_RUNNING", retryable: true },
      });
      const invalid = await client.callTool({ name: "zcut_ui_show_panel", arguments: { panel: "invalid" } });
      expect(invalid.structuredContent).toMatchObject({ status: "rejected", error: { code: "E_VALIDATION" } });
      let state = {
        project,
        panel: "ai",
        sub: null as string | null,
        playhead: { at: "0s" },
        selected: [],
        playing: false,
        range: null,
        loop: false,
        subtitleBrowser: { search: "关键词", find: "旧词", replace: "新词", matchCase: true },
        subtitle_selection: { cue_ids: ["cue_1", "cue_2"], editing: "cue_1" },
      };
      socket.on("message", (raw) => {
        const message = JSON.parse(raw.toString());
        if (message.type !== "ui_request") return;
        if (message.verb === "ui_show_panel") state = { ...state, ...message.request };
        socket.send(JSON.stringify({ type: "ui_result", id: message.id, result: state }));
      });
      expect(await sendMessage(socket, { type: "ui_ready" })).toMatchObject({ type: "bootstrap", project });
      await client.callTool({ name: "zcut_ui_show_panel", arguments: { panel: "subtitles", sub: "style" } });
      const shown = await client.callTool({ name: "zcut_ui_state", arguments: {} });
      expect(shown.structuredContent).toMatchObject({
        status: "no_op",
        result: {
          panel: "subtitles",
          sub: "style",
          subtitleBrowser: state.subtitleBrowser,
          subtitle_pass: null,
          subtitle_selection: state.subtitle_selection,
        },
      });
      for (const verb of SUBTITLE_VERBS) {
        const accepted = await client.callTool({
          name: `zcut_${verb}`,
          arguments: { cue_ids: ["cue_2"], request: "保留口头语" },
        });
        expect(accepted.structuredContent).toMatchObject({
          status: "accepted",
          result: { pass_id: expect.any(String) },
        });
        await vi.waitFor(async () => {
          const progress = await client.callTool({ name: "zcut_ui_state", arguments: {} });
          expect(progress.structuredContent).toMatchObject({
            result: {
              subtitle_pass: {
                pass_id: (accepted.structuredContent as { result: { pass_id: string } }).result.pass_id,
                kind: verb === "subtitle_tidy" ? "tidy" : "proofread",
                state: "failed",
                reason: expect.stringContaining("没有检测到"),
              },
            },
          });
        });
      }
      expect(Agents.prototype.subtitlePass).not.toHaveBeenCalled();
      const closed = once(socket, "close");
      socket.close();
      await closed;
      const gone = await client.callTool({ name: "zcut_ui_state", arguments: {} });
      expect(gone.structuredContent).toMatchObject({ error: { code: "E_APP_NOT_RUNNING" } });
    } finally {
      socket.terminate();
      await client.close();
    }
  });
});

it("serves valid MCP schemas and no-UI failures without a network listener", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zcut-mcp-schema-"));
  const project = join(directory, "std-25.zcut.json");
  await copyFile(new URL("../../../fixtures/projects/std-25.zcut.json", import.meta.url), project);
  const server = createMcpServer();
  const client = new Client({ name: "offline-mcp", version: "1" });
  const [left, right] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(left), client.connect(right)]);
  try {
    const tools = await client.listTools();
    expect(tools.tools).toHaveLength(VERBS.length + DESKTOP_VERBS.length);
    expect(tools.tools.map((tool) => tool.name)).toEqual([...VERBS, ...DESKTOP_VERBS].map((verb) => `zcut_${verb}`));
    for (const verb of SUBTITLE_VERBS) {
      const schema = tools.tools.find((tool) => tool.name === `zcut_${verb}`)?.inputSchema;
      expect(Object.keys(schema?.properties ?? {}).sort()).toEqual(["cue_ids", "request", "transcript_id"]);
      expect(schema?.properties?.request).toMatchObject({ maxLength: 200 });
      expect((await client.callTool({ name: `zcut_${verb}`, arguments: {} })).structuredContent).toMatchObject({
        status: "failed",
        error: { code: "E_APP_NOT_RUNNING", retryable: true },
      });
      for (const args of [{ request: "字".repeat(201) }, { cue_ids: [] }, { transcript_id: 3 }, { extra: true }])
        expect((await client.callTool({ name: `zcut_${verb}`, arguments: args })).structuredContent).toMatchObject({
          status: "rejected",
          error: { code: "E_VALIDATION" },
        });
    }
    const uiFields = {
      ui_state: [],
      ui_show_panel: ["panel", "sub"],
      ui_seek: ["at", "id"],
      ui_select: ["ids"],
      ui_play: ["range", "loop"],
      ui_pause: [],
    };
    for (const tool of tools.tools
      .slice(0, VERBS.length)
      .filter(
        (tool) =>
          ![
            "zcut_record_handoff_check",
            "zcut_terms_list",
            "zcut_terms_edit",
            "zcut_settings_get",
            "zcut_settings_set",
            "zcut_voice_list",
            "zcut_voice_edit",
            "zcut_voice_clone",
          ].includes(tool.name),
      ))
      expect(tool.inputSchema.properties?.author).toMatchObject({
        type: "object",
        properties: { kind: expect.any(Object), name: { type: "string", minLength: 1 } },
      });
    expect(tools.tools.find((tool) => tool.name === "zcut_ui_show_panel")?.inputSchema.properties?.panel).toMatchObject(
      { enum: expect.arrayContaining(["history"]) },
    );
    for (const verb of UI_VERBS) {
      const schema = tools.tools.find((tool) => tool.name === `zcut_${verb}`)?.inputSchema;
      expect(Object.keys(schema?.properties ?? {}).sort()).toEqual([...uiFields[verb]].sort());
      expect(
        (
          await client.callTool({
            name: `zcut_${verb}`,
            arguments:
              verb === "ui_seek"
                ? { at: "1s" }
                : verb === "ui_show_panel"
                  ? { panel: "ai" }
                  : verb === "ui_select"
                    ? { ids: [] }
                    : {},
          })
        ).structuredContent,
      ).toMatchObject({
        status: "failed",
        error: { code: "E_APP_NOT_RUNNING", retryable: true },
      });
    }
    expect(
      (
        await client.callTool({
          name: "zcut_session_begin",
          arguments: {
            project,
            author: { kind: "agent", name: "Claude" },
            base_revision: "rev_fixture_1",
            idempotency_key: "object-author",
            approval: "manual",
            intent: "测试会话",
          },
        })
      ).structuredContent,
    ).toMatchObject({ ok: true });
    const request = { project, view: "timeline" };
    const result = await client.callTool({ name: "zcut_inspect", arguments: request });
    const run = spawnSync(process.execPath, [cli, "inspect"], { encoding: "utf8", input: JSON.stringify(request) });
    expect(comparable(result.structuredContent as Record<string, unknown>)).toEqual(comparable(JSON.parse(run.stdout)));
  } finally {
    await client.close();
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it("authenticates Streamable HTTP, lists desktop tools and calls inspect using the SDK", async () => {
  const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
  host = await startHost({ project, appDataDir });
  const url = new URL(`http://127.0.0.1:${host.port}/mcp`);
  for (const headers of [{}, { Authorization: "Bearer wrong" }]) {
    expect((await fetch(url, { method: "POST", headers })).status).toBe(401);
  }
  const client = new Client({ name: "http-test", version: "1" });
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { Authorization: `Bearer ${host.token}` } },
  });
  // SDK callback declarations do not support exactOptionalPropertyTypes.
  await client.connect(transport as import("@modelcontextprotocol/sdk/shared/transport.js").Transport);
  try {
    expect((await client.listTools()).tools).toHaveLength(VERBS.length + DESKTOP_VERBS.length);
    expect(
      (await client.callTool({ name: "zcut_inspect", arguments: { project, view: "brief" } })).structuredContent,
    ).toMatchObject({ ok: true, verb: "inspect" });
    await expect(
      client.callTool({ name: "zcut_inspect", arguments: { project: "/other.zcut.json", view: "brief" } }),
    ).rejects.toThrow("current project");
  } finally {
    await client.close();
  }
});

it("reads complete draft summaries and batch status without mutating sessions", async () => {
  const kernel = vi.fn(async (verb: string, raw: unknown) => {
    const input = raw as Record<string, unknown>;
    let result: unknown;
    if (verb === "inspect" && input.view === "brief") result = { sessions: [{ id: "ses_test" }] };
    else if (verb === "inspect" && input.view === "session")
      result = { session_id: "ses_test", base_revision: "rev_base", draft_revision: "rev_current", decisions: [] };
    else if (verb === "inspect")
      result = {
        entries: input.before
          ? [{ revision: "rev_0" }]
          : Array.from({ length: 200 }, (_, i) => ({ revision: `rev_${i + 1}` })),
      };
    else if (verb === "diff") result = { changes: [{ entity: "clip" }, { entity: "cue" }] };
    else result = { state: "open", count: 3, applied: [1] };
    return { ok: true, result } as Envelope;
  });
  expect(await readAiState(kernel, project, ["bat_test"])).toMatchObject({
    sessions: [{ session_id: "ses_test", revision_count: 201, changes: [{ entity: "clip" }, { entity: "cue" }] }],
    batches: [{ state: "open", count: 3, applied: [1] }],
  });
  expect(kernel).toHaveBeenCalledWith("inspect", {
    project,
    view: "history",
    session_id: "ses_test",
    limit: 200,
    before: "rev_200",
  });
  expect(kernel).toHaveBeenCalledWith("diff", { project, session_id: "ses_test", from: "rev_base", to: "rev_current" });
  expect(kernel.mock.calls.every(([verb]) => ["inspect", "diff", "batch_status"].includes(verb))).toBe(true);
});

it("discovers only open main-project batches, including batches with no journal steps", async () => {
  const root = await mkdtemp(join(tmpdir(), "zcut-history-batches-"));
  try {
    expect(await readHistoryBatches(root)).toEqual([]);
    for (const [id, target, state] of [
      ["bat_queued", null, "open"],
      ["bat_draft", "ses_draft", "open"],
      ["bat_done", null, "complete"],
    ]) {
      const directory = join(root, "batches", id as string);
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, "state.json"), JSON.stringify({ target, state }));
    }
    await mkdir(join(root, "batches", "bat_initializing"));
    expect(await readHistoryBatches(root)).toEqual(["bat_queued"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("rebinds MCP and bootstrap, stops the old Agent and preserves binding on invalid open", async () => {
  const stop = vi.spyOn(Agents.prototype, "stop");
  const next = join(appDataDir, "next.zcut.json");
  const source = JSON.parse(await readFile(project, "utf8"));
  source.name = "新工程";
  await writeFile(next, JSON.stringify(source));
  host = await startHost({ project, appDataDir });
  const socket = new WebSocket(`ws://127.0.0.1:${host.port}/?token=${host.token}`);
  const messages: { type?: string; id?: string; project?: string | null; envelope?: { ok: boolean } }[] = [];
  socket.on("message", (raw) => messages.push(JSON.parse(raw.toString())));
  await once(socket, "open");
  const client = await mcpClient();
  try {
    socket.send(JSON.stringify({ type: "ui_ready" }));
    await vi.waitFor(() => expect(messages.some((row) => row.type === "bootstrap")).toBe(true));
    socket.send(JSON.stringify({ id: "switch", verb: "project_open", request: { path: next } }));
    await vi.waitFor(() => expect(messages.find((row) => row.id === "switch")?.envelope?.ok).toBe(true));
    expect(stop).toHaveBeenCalled();
    expect(messages.filter((row) => row.type === "bootstrap").at(-1)?.project).toBe(next);
    const result = await client.callTool({ name: "zcut_inspect", arguments: { project: next, view: "brief" } });
    expect(result.structuredContent).toMatchObject({ ok: true, result: { project: { name: "新工程" } } });
    await expect(client.callTool({ name: "zcut_inspect", arguments: { project, view: "brief" } })).rejects.toThrow();
    socket.send(
      JSON.stringify({ id: "bad", verb: "project_open", request: { path: join(appDataDir, "missing.zcut.json") } }),
    );
    await vi.waitFor(() => expect(messages.find((row) => row.id === "bad")?.envelope?.ok).toBe(false));
    expect(messages.filter((row) => row.type === "bootstrap").at(-1)?.project).toBe(next);
    socket.send(JSON.stringify({ id: "close", verb: "project_open", request: { path: null } }));
    await vi.waitFor(() => expect(messages.find((row) => row.id === "close")?.envelope?.ok).toBe(true));
    expect(messages.filter((row) => row.type === "bootstrap").at(-1)?.project).toBeNull();
    await expect(
      client.callTool({ name: "zcut_inspect", arguments: { project: next, view: "brief" } }),
    ).rejects.toThrow();
  } finally {
    stop.mockRestore();
    socket.terminate();
    await client.close();
  }
});

it("serializes stored animation durations in preview data without bigint or changing the model", () => {
  const duration = { numerator: 1n, denominator: 2n };
  const styles = [
    {
      id: "sty_test",
      name: "Test",
      version: 1,
      font_family: "Arial",
      font_size: 0.05,
      color: "#FFFFFF",
      highlight: { color: "#FF0000" },
      animation: {
        in: { type: "fade" as const, duration },
        out: { type: "sink" as const, duration },
        word: "jump" as const,
      },
    },
  ];
  const wire = JSON.parse(JSON.stringify(subtitleStylesForPreview(styles)));
  expect(wire[0].animation).toEqual({
    in: { type: "fade", duration: "1/2s" },
    out: { type: "sink", duration: "1/2s" },
    word: "jump",
  });
  expect(styles[0]?.animation.in.duration).toBe(duration);
  const { animation: _animation, ...plain } = styles[0] ?? {};
  expect(subtitleStylesForPreview([plain as (typeof styles)[number]])[0]).toEqual(plain);
});

it("keeps cache controls on the authenticated UI channel and persists directory changes", async () => {
  const { DesktopPreferences } = await import("../src/preferences.js");
  const directory = join(appDataDir, "cache");
  await mkdir(directory);
  const prefs = new DesktopPreferences(appDataDir);
  await prefs.set({ preview_cache: { directory, auto: false } });
  const socket = await connect();
  try {
    expect((await sendMessage(socket, { type: "ui_ready" })).type).toBe("bootstrap");
    let sequence = 0;
    const call = (verb: string, request = {}) =>
      new Promise<{ result: { segments: { state: string }[] } }>((resolve, reject) => {
        const id = `cache-${sequence++}`;
        const timer = setTimeout(() => {
          socket.off("message", receive);
          reject(new Error("Missing response"));
        }, 3000);
        const receive = (data: Buffer) => {
          const message = JSON.parse(data.toString());
          if (message.id !== id) return;
          clearTimeout(timer);
          socket.off("message", receive);
          resolve(message.envelope);
        };
        socket.on("message", receive);
        socket.send(JSON.stringify({ id, verb, request }));
      });
    const status = await call("preview_cache_status");
    expect(status).toMatchObject({ ok: true, result: { directory, directory_ok: true, used_bytes: 0 } });
    expect(status.result.segments.every((s: { state: string }) => s.state === "missing")).toBe(true);
    expect(await call("preview_cache_playhead", { at: "6s" })).toMatchObject({ ok: true });
    expect(await call("preview_cache_playhead", { at: "1.5s" })).toMatchObject({
      status: "rejected",
      error: { code: "E_VALIDATION" },
    });
    expect(await call("preview_cache_clear")).toMatchObject({ status: "applied" });
    const next = join(appDataDir, "new-cache");
    expect(await call("preview_cache_move", { directory: next })).toMatchObject({
      status: "applied",
      result: { directory: next, directory_ok: true },
    });
    await prefs.load();
    expect(prefs.get().preview_cache_directory).toBe(next);
  } finally {
    socket.terminate();
  }
});
