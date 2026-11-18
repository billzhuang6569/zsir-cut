import { readFile } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { expect, it } from "vitest";
import { TOOL_DOCS, VERBS } from "../../core/src/index.ts";
import { createMcpServer } from "../src/index.js";
import { DESKTOP_VERBS } from "../src/ui.js";

it("advertises all host descriptions, accepts the desktop examples and serves only the named guides", async () => {
  const server = createMcpServer();
  const client = new Client({ name: "host-tool-docs", version: "1" });
  const [left, right] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(left);
    await client.connect(right);
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(VERBS.length + DESKTOP_VERBS.length);
    for (const verb of [...VERBS, ...DESKTOP_VERBS]) {
      const description = TOOL_DOCS[verb];
      expect(description?.length).toBeGreaterThan(0);
      expect(description?.length).toBeLessThanOrEqual(4000);
      expect(tools.find((tool) => tool.name === `zcut_${verb}`)?.description).toBe(description);
    }
    for (const verb of DESKTOP_VERBS) {
      const args = JSON.parse(TOOL_DOCS[verb]?.split("\n").at(-2) ?? "");
      const response = await client.callTool({ name: `zcut_${verb}`, arguments: args });
      expect(response.structuredContent).toMatchObject({ status: "failed", error: { code: "E_APP_NOT_RUNNING" } });
      expect(response.content).toEqual([{ type: "text", text: `failed ${verb} —\nE_APP_NOT_RUNNING 桌面界面未连接` }]);
    }
    const inspect = tools.find((tool) => tool.name === "zcut_inspect");
    expect(inspect?.inputSchema).toMatchObject({
      properties: { view: { anyOf: [{ enum: expect.arrayContaining(["brief"]) }, { const: "guide" }] } },
      oneOf: [
        { properties: { view: { enum: expect.arrayContaining(["brief"]) } } },
        { properties: { view: { const: "guide" }, name: { enum: ["rough-cut", "subtitles", "handoff"] } } },
      ],
    });
    for (const name of ["rough-cut", "subtitles", "handoff"]) {
      const result = await client.callTool({ name: "zcut_inspect", arguments: { view: "guide", name } });
      const text = await readFile(new URL(`../../../skills/zsir-cut/references/${name}.md`, import.meta.url), "utf8");
      expect(result.structuredContent).toMatchObject({ status: "no_op", result: { text } });
      expect(result.content).toEqual([{ type: "text", text: "no_op inspect —" }]);
    }
    for (const name of [undefined, "../desktop", "requests"]) {
      const result = await client.callTool({
        name: "zcut_inspect",
        arguments: { view: "guide", ...(name === undefined ? {} : { name }) },
      });
      expect(result.structuredContent).toMatchObject({ status: "rejected", error: { code: "E_VALIDATION" } });
    }
  } finally {
    await client.close();
    await server.close();
  }
});
