#!/usr/bin/env node
import { realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { DispatchOptions, Verb } from "../../core/dist/index.js";

const {
  commandSchemaForVerb,
  flattenMcpSchema,
  dispatch,
  VERBS,
  TOOL_DOCS,
  summarizeToolResult,
}: typeof import("../../core/dist/index.js") = await import(
  new URL(import.meta.url.endsWith(".ts") ? "../../core/src/index.ts" : "../../core/dist/index.js", import.meta.url)
    .href
);

export function createServer(options: DispatchOptions = {}): Server {
  const server = new Server({ name: "zsir-cut", version: "0.1.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: VERBS.map((verb) => ({
      name: `zcut_${verb}`,
      description: TOOL_DOCS[verb],
      inputSchema: flattenMcpSchema(commandSchemaForVerb(verb)) as { type: "object" },
    })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const verb = request.params.name.slice("zcut_".length) as Verb;
    if (!VERBS.includes(verb)) throw new Error(`Unknown tool: ${request.params.name}`);
    const input = request.params.arguments ?? {};
    const envelope = await dispatch(verb, input, options);
    return { content: [{ type: "text", text: summarizeToolResult(envelope, input) }], structuredContent: envelope };
  });
  return server;
}

if (process.argv[1] && (await realpath(fileURLToPath(import.meta.url))) === (await realpath(process.argv[1]))) {
  createServer()
    .connect(new StdioServerTransport())
    .catch((error: unknown) => {
      process.stderr.write(`${String(error)}\n`);
      process.exitCode = 1;
    });
}
