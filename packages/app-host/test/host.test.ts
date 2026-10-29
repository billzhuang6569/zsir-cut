import { spawnSync } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { VERBS } from "../../core/src/index.ts";
import { createMcpServer, startHost } from "../src/index.js";
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
  const server = createMcpServer();
  const client = new Client({ name: "offline-mcp", version: "1" });
  const [left, right] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(left), client.connect(right)]);
  try {
    const tools = await client.listTools();
    expect(tools.tools).toHaveLength(VERBS.length + UI_VERBS.length);
    expect(tools.tools.map((tool) => tool.name)).toEqual([...VERBS, ...UI_VERBS].map((verb) => `zcut_${verb}`));
    for (const verb of UI_VERBS) {
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
    const request = { project, view: "timeline" };
    const result = await client.callTool({ name: "zcut_inspect", arguments: request });
    const run = spawnSync(process.execPath, [cli, "inspect"], { encoding: "utf8", input: JSON.stringify(request) });
    expect(comparable(result.structuredContent as Record<string, unknown>)).toEqual(comparable(JSON.parse(run.stdout)));
  } finally {
    await client.close();
    await server.close();
  }
});
