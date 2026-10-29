import { spawnSync } from "node:child_process";
import { once } from "node:events";
import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import type { Envelope } from "../../core/src/index.ts";
import { VERBS } from "../../core/src/index.ts";
import { createMcpServer, readAiState, startHost } from "../src/index.js";
import { UI_VERBS } from "../src/ui.js";

let host: Awaited<ReturnType<typeof startHost>> | undefined;
afterEach(async () => {
  await host?.close();
  host = undefined;
});
const project = fileURLToPath(new URL("../../../examples/interview.zcut.json", import.meta.url));
const cli = fileURLToPath(new URL("../../cli/src/index.ts", import.meta.url));
const comparable = (envelope: Record<string, unknown>) => ({ ...envelope, request_id: "ignored" });
async function connect() {
  host = await startHost({ project });
  const socket = new WebSocket(`ws://127.0.0.1:${host.port}/?token=${host.token}`);
  await once(socket, "open");
  return socket;
}
async function mcpClient() {
  if (!host) throw new Error("Missing host");
  const client = new Client({ name: "host-test", version: "1" });
  const [server, transport] = InMemoryTransport.createLinkedPair();
  await Promise.all([host.mcp.connect(server), client.connect(transport)]);
  return client;
}

describe("desktop host", () => {
  it("serializes preview rationals and keeps the connection usable after a request fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "zcut-preview-rational-"));
    const project = join(directory, "project.zcut.json");
    const fixture = new URL("../../../fixtures/regressions/preview-media-rational.zcut.json", import.meta.url);
    await copyFile(fixture, project);
    host = await startHost({ project });
    const socket = new WebSocket(`ws://127.0.0.1:${host.port}/?token=${host.token}`);
    try {
      await once(socket, "open");
      const send = async (message: Record<string, unknown>) => {
        const reply = once(socket, "message", { signal: AbortSignal.timeout(3000) });
        socket.send(JSON.stringify(message));
        const result = JSON.parse((await reply)[0].toString());
        expect(socket.readyState).toBe(WebSocket.OPEN);
        if (message.id) expect(result.id).toBe(message.id);
        return result;
      };
      expect(await send({ type: "ui_ready" })).toMatchObject({ type: "bootstrap", project });
      for (const view of ["brief", "timeline"])
        expect(await send({ id: view, verb: "inspect", request: { project, view } })).toMatchObject({
          envelope: { ok: true },
        });
      expect(await send({ id: "preview", type: "preview_data" })).toMatchObject({
        envelope: {
          ok: true,
          result: {
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
      await writeFile(project, "{}");
      expect(await send({ id: "failed-preview", type: "preview_data" })).toMatchObject({
        envelope: { ok: false, error: { message: expect.stringContaining("Invalid project") } },
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
        const reply = once(socket, "message");
        socket.send(JSON.stringify({ id: "1", verb, request }));
        const [raw] = await reply;
        const run = spawnSync(process.execPath, [cli, verb], { encoding: "utf8", input: JSON.stringify(request) });
        expect(comparable(JSON.parse(raw.toString()).envelope)).toEqual(comparable(JSON.parse(run.stdout)));
      }
    } finally {
      socket.terminate();
    }
  }, 15000);

  it("rejects missing and wrong tokens before upgrading", async () => {
    host = await startHost();
    for (const query of ["", "?token=wrong"]) {
      const socket = new WebSocket(`ws://127.0.0.1:${host.port}/${query}`);
      const error = await new Promise<Error>((resolve) => socket.once("error", resolve));
      expect(error.message).toContain("401");
      socket.terminate();
    }
  });

  it("lists all kernel and UI MCP tools, reports no UI, and forwards UI requests", async () => {
    const socket = await connect();
    const client = await mcpClient();
    try {
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toEqual([...VERBS, ...UI_VERBS].map((verb) => `zcut_${verb}`));
      expect(tools.tools).toHaveLength(VERBS.length + UI_VERBS.length);
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
      };
      socket.on("message", (raw) => {
        const message = JSON.parse(raw.toString());
        if (message.type !== "ui_request") return;
        if (message.verb === "ui_show_panel") state = { ...state, ...message.request };
        socket.send(JSON.stringify({ type: "ui_result", id: message.id, result: state }));
      });
      const bootstrap = once(socket, "message");
      socket.send(JSON.stringify({ type: "ui_ready" }));
      expect(JSON.parse((await bootstrap)[0].toString())).toMatchObject({ type: "bootstrap", project });
      await client.callTool({ name: "zcut_ui_show_panel", arguments: { panel: "subtitles", sub: "style" } });
      const shown = await client.callTool({ name: "zcut_ui_state", arguments: {} });
      expect(shown.structuredContent).toMatchObject({ status: "no_op", result: { panel: "subtitles", sub: "style" } });
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
    expect(tools.tools).toHaveLength(VERBS.length + UI_VERBS.length);
    expect(tools.tools.map((tool) => tool.name)).toEqual([...VERBS, ...UI_VERBS].map((verb) => `zcut_${verb}`));
    const uiFields = {
      ui_state: [],
      ui_show_panel: ["panel", "sub"],
      ui_seek: ["at", "id"],
      ui_select: ["ids"],
      ui_play: ["range", "loop"],
      ui_pause: [],
    };
    for (const tool of tools.tools.slice(0, VERBS.length).filter((tool) => tool.name !== "zcut_record_handoff_check"))
      expect(tool.inputSchema.properties?.author).toMatchObject({
        type: "object",
        properties: { kind: expect.any(Object), name: { type: "string", minLength: 1 } },
      });
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

it("authenticates Streamable HTTP, lists 29 tools and calls inspect using the SDK", async () => {
  const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
  host = await startHost({ project });
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
    expect((await client.listTools()).tools).toHaveLength(29);
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
