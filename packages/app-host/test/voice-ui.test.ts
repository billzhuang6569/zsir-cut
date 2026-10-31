import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { expect, it, vi } from "vitest";
import { createMcpServer } from "../src/index.js";
import type { UiEnvelope } from "../src/ui.js";

it("advertises and dispatches the voice panel and its sub-pages over in-memory MCP", async () => {
  const call = vi.fn(async (verb, input) => ({ ok: true, status: "no_op", verb, result: input }) as UiEnvelope);
  const server = createMcpServer(call);
  const client = new Client({ name: "voice-ui-test", version: "1" });
  const [left, right] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(left);
    await client.connect(right);
    const tools = await client.listTools();
    expect(JSON.stringify(tools.tools.find((tool) => tool.name === "zcut_ui_show_panel")?.inputSchema)).toContain(
      '"voice"',
    );
    for (const sub of ["clone", "generate", "results"]) {
      const result = await client.callTool({ name: "zcut_ui_show_panel", arguments: { panel: "voice", sub } });
      expect(result.structuredContent).toMatchObject({ ok: true, result: { panel: "voice", sub } });
      expect(call).toHaveBeenLastCalledWith("ui_show_panel", { panel: "voice", sub });
    }
    await client.callTool({ name: "zcut_ui_state", arguments: {} });
    expect(call).toHaveBeenLastCalledWith("ui_state", {});
  } finally {
    await client.close();
    await server.close();
  }
});
