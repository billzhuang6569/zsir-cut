#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { commandSchemaForVerb, type DispatchOptions, dispatch, VERBS, type Verb } from "../../core/dist/index.js";

export function createServer(options: DispatchOptions = {}): Server {
  const server = new Server({ name: "zsir-cut", version: "0.0.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: VERBS.map((verb) => ({
      name: `zcut_${verb}`,
      inputSchema: commandSchemaForVerb(verb) as { type: "object" },
    })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const verb = request.params.name.slice("zcut_".length) as Verb;
    if (!VERBS.includes(verb)) throw new Error(`Unknown tool: ${request.params.name}`);
    const envelope = await dispatch(verb, request.params.arguments ?? {}, options);
    return { content: [], structuredContent: envelope };
  });
  return server;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  createServer()
    .connect(new StdioServerTransport())
    .catch((error: unknown) => {
      process.stderr.write(`${String(error)}\n`);
      process.exitCode = 1;
    });
}
