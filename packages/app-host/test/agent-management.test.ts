import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { AgentManagement, agentDirectories, findProgram, programVersion } from "../src/agent-management.js";
import { startHost } from "../src/index.js";
import { DesktopPreferences } from "../src/preferences.js";

let directory: string;
let registry: Server;
let registryUrl: string;
let requests: string[];
let host: Awaited<ReturnType<typeof startHost>> | undefined;
let socket: WebSocket | undefined;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "zcut-agents-"));
  vi.stubEnv("HOME", directory);
  vi.stubEnv("PATH", directory);
  vi.stubEnv("HTTPS_PROXY", "");
  requests = [];
  registryUrl = "http://127.0.0.1:1";
});
async function startRegistry() {
  registry = createServer((request, response) => {
    requests.push(request.url ?? "");
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ version: "2.1.0" }));
  });
  registry.listen(0, "127.0.0.1");
  await once(registry, "listening");
  const address = registry.address();
  if (!address || typeof address === "string") throw new Error("Missing registry port");
  registryUrl = `http://127.0.0.1:${address.port}`;
}
afterEach(async () => {
  socket?.terminate();
  socket = undefined;
  await host?.close();
  host = undefined;
  registry?.closeAllConnections();
  if (registry?.listening) await new Promise<void>((resolve) => registry.close(() => resolve()));
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});
async function executable(name: string, body: string) {
  const path = join(directory, name);
  await writeFile(path, `#!${process.execPath}\n${body}\n`, { mode: 0o700 });
  return path;
}
function manager(events: Record<string, unknown>[] = []) {
  return new AgentManagement(new DesktopPreferences(directory), (event) => events.push(event), {
    registryUrl,
    directories: [directory],
  });
}
it("returns missing agents and install data, rejects missing npm with manual instructions", async () => {
  await startRegistry();
  const management = manager();
  expect(await management.list()).toEqual({
    npm: null,
    agents: ["claude", "codex"].map((id) => ({
      id,
      name: id === "claude" ? "Claude Code" : "Codex",
      found: false,
      path: null,
      version: null,
      latest: "2.1.0",
      update_available: false,
      default: false,
    })),
  });
  for (const verb of ["agents_install", "agents_update"]) {
    expect(await management.handle(verb, { id: "claude" })).toMatchObject({
      status: "rejected",
      error: {
        code: "E_UNSUPPORTED",
        details: { manual: expect.stringContaining("npm install -g @anthropic-ai/claude-code") },
      },
    });
  }
  expect(await management.handle("agents_set_default", { id: "other" })).toMatchObject({
    status: "rejected",
    error: { code: "E_VALIDATION" },
  });
});
it("discovers PATH before fallback directories and caches versions/latest for 24 hours with explicit refresh", async () => {
  await startRegistry();
  const claude = await executable("claude", "console.log('2.0.0 (Claude Code)')");
  const codex = await executable("codex", "console.log('codex-cli 2.1.0')");
  const npm = await executable("npm", "");
  expect(agentDirectories()).toEqual([
    directory,
    "/opt/homebrew/bin",
    "/usr/local/bin",
    join(directory, ".local/bin"),
    join(directory, ".npm-global/bin"),
    join(directory, ".claude/local"),
  ]);
  expect(await findProgram("claude")).toBe(claude);
  const fallback = join(directory, "fallback");
  await mkdir(fallback);
  await writeFile(join(fallback, "claude"), "", { mode: 0o700 });
  expect(await findProgram("claude", [directory, fallback])).toBe(claude);
  const management = manager();
  expect(await management.list()).toMatchObject({
    npm,
    agents: [
      { path: claude, version: "2.0.0 (Claude Code)", found: true, update_available: true, default: true },
      { path: codex, version: "codex-cli 2.1.0", found: true, update_available: false, default: false },
    ],
  });
  expect(requests.sort()).toEqual(["/@anthropic-ai%2fclaude-code/latest", "/@openai%2fcodex/latest"]);
  await management.list();
  expect(requests).toHaveLength(2);
  await management.list(true);
  expect(requests).toHaveLength(4);
  const now = Date.now();
  vi.spyOn(Date, "now").mockReturnValue(now + 24 * 60 * 60 * 1000 + 1);
  await management.list();
  expect(requests).toHaveLength(6);
});
it("silently returns within three seconds when registry is down", async () => {
  const start = performance.now();
  expect(await manager().handle("agents_list", {})).toMatchObject({
    ok: true,
    result: { agents: [{ latest: null }, { latest: null }] },
  });
  expect(performance.now() - start).toBeLessThan(3000);
});
it("bounds hanging registry requests and version probes", async () => {
  await startRegistry();
  registry.removeAllListeners("request");
  registry.on("request", () => {});
  const path = await executable("claude", "setInterval(() => {}, 1000)");
  const start = performance.now();
  const [result, version] = await Promise.all([manager().list(), programVersion(path)]);
  expect(result.agents[0]).toMatchObject({ found: true, version: null, latest: null });
  expect(version).toBeNull();
  expect(performance.now() - start).toBeLessThan(3400);
}, 5000);
it("honours HTTPS_PROXY without accessing the target registry", async () => {
  await startRegistry();
  vi.stubEnv("HTTPS_PROXY", registryUrl);
  const management = new AgentManagement(new DesktopPreferences(directory), () => {}, {
    registryUrl: "http://unreachable.invalid",
    directories: [directory],
  });
  expect((await management.list()).agents[0]?.latest).toBe("2.1.0");
  expect(requests).toContain("http://unreachable.invalid/@openai%2fcodex/latest");
});
async function connect() {
  host = await startHost({ appDataDir: directory, agentOptions: { registryUrl, directories: [directory] } });
  socket = new WebSocket(`ws://127.0.0.1:${host.port}/?token=${host.token}`);
  await once(socket, "open");
  const bootstrap = once(socket, "message");
  socket.send(JSON.stringify({ type: "ui_ready" }));
  await bootstrap;
  return socket;
}
function send(client: WebSocket, verb: string, request: unknown = {}) {
  const id = Math.random().toString();
  return new Promise<{ result: { job_id: string }; status: string }>((resolve) => {
    const listener = (raw: Buffer) => {
      const message = JSON.parse(raw.toString());
      if (message.id !== id) return;
      client.off("message", listener);
      expect(message.type).toBe("result");
      expect(message.envelope).not.toHaveProperty("receipt");
      resolve(message.envelope);
    };
    client.on("message", listener);
    client.send(JSON.stringify({ id, verb, request }));
  });
}
it("streams install lines to UI in order, rejects concurrent update, then sends done and changed; persists default after restart", async () => {
  await startRegistry();
  await executable(
    "npm",
    `import {writeFileSync} from 'node:fs';
writeFileSync(${JSON.stringify(join(directory, "args.json"))}, JSON.stringify(process.argv.slice(2)));
console.log('first');
setTimeout(() => console.error('second'), 50);
setTimeout(() => {process.stdout.write('last');}, 100);`,
  );
  let client = await connect();
  const events: Record<string, unknown>[] = [];
  client.on("message", (raw) => events.push(JSON.parse(raw.toString())));
  const accepted = await send(client, "agents_install", { id: "claude" });
  expect(accepted).toMatchObject({ status: "accepted", result: { job_id: expect.any(String) } });
  expect(await send(client, "agents_update", { id: "codex" })).toMatchObject({
    status: "failed",
    error: { code: "E_IO", retryable: true },
  });
  await vi.waitFor(() => expect(events.at(-1)?.type).toBe("agents_changed"), { timeout: 5000 });
  expect(events.filter((event) => event.type === "agents_output")).toEqual([
    { type: "agents_output", job_id: accepted.result.job_id, line: "first", stream: "stdout" },
    { type: "agents_output", job_id: accepted.result.job_id, line: "second", stream: "stderr" },
    { type: "agents_output", job_id: accepted.result.job_id, line: "last", stream: "stdout" },
    { type: "agents_output", job_id: accepted.result.job_id, done: true, ok: true },
  ]);
  expect(events.at(-1)).toMatchObject({
    type: "agents_changed",
    npm: join(directory, "npm"),
    agents: [{ id: "claude" }, { id: "codex" }],
  });
  expect(JSON.parse(await readFile(join(directory, "args.json"), "utf8"))).toEqual([
    "install",
    "-g",
    "@anthropic-ai/claude-code",
  ]);
  expect(await send(client, "agents_set_default", { id: "codex" })).toMatchObject({ status: "applied" });
  client.terminate();
  await host?.close();
  host = undefined;
  client = await connect();
  expect(await send(client, "agents_list")).toMatchObject({
    result: { agents: [{ default: false }, { id: "codex", default: true }] },
  });
  expect(await send(client, "prefs_get")).toMatchObject({ result: { prefs: { default_agent: "codex" } } });
  const updated: Record<string, unknown>[] = [];
  client.on("message", (raw) => updated.push(JSON.parse(raw.toString())));
  expect(await send(client, "agents_update", { id: "codex" })).toMatchObject({ status: "accepted" });
  await vi.waitFor(async () =>
    expect(JSON.parse(await readFile(join(directory, "args.json"), "utf8"))).toEqual([
      "install",
      "-g",
      "@openai/codex",
    ]),
  );
  await vi.waitFor(() => expect(updated.at(-1)?.type).toBe("agents_changed"), { timeout: 5000 });
});

it("validates missing npm, discovery, install pushes and persistence without listeners", async () => {
  const events: Record<string, unknown>[] = [];
  let management = manager(events);
  expect(await management.handle("agents_list", {})).toMatchObject({
    ok: true,
    result: {
      npm: null,
      agents: [
        { found: false, latest: null },
        { found: false, latest: null },
      ],
    },
  });
  expect(await management.handle("agents_install", { id: "claude" })).toMatchObject({
    status: "rejected",
    error: { code: "E_UNSUPPORTED", details: { manual: expect.any(String) } },
  });
  const path = await executable("claude", "console.log('1.2.3')");
  expect(await findProgram("claude")).toBe(path);
  expect(await programVersion(path)).toBe("1.2.3");
  expect(await management.list(true)).toMatchObject({
    agents: [{ path, found: true, version: "1.2.3", default: true }, { found: false }],
  });
  await executable("npm", "console.log('first'); setTimeout(() => { console.log('second'); }, 150);");
  const installed = await management.handle("agents_install", { id: "codex" });
  expect(installed.status).toBe("accepted");
  expect(await management.handle("agents_update", { id: "claude" })).toMatchObject({
    status: "failed",
    error: { code: "E_IO", retryable: true },
  });
  await vi.waitFor(() => expect(events.at(-1)?.type).toBe("agents_changed"), { timeout: 5000 });
  expect(events.map(({ type, line, done, ok }) => ({ type, line, done, ok }))).toEqual([
    { type: "agents_output", line: "first" },
    { type: "agents_output", line: "second" },
    { type: "agents_output", done: true, ok: true },
    { type: "agents_changed" },
  ]);
  expect(await management.handle("agents_set_default", { id: "codex" })).toMatchObject({ status: "applied" });
  const prefs = new DesktopPreferences(directory);
  await prefs.load();
  management = new AgentManagement(prefs, () => {}, { registryUrl, directories: [directory] });
  expect((await management.list()).agents[1]?.default).toBe(true);
  expect(await management.handle("agents_set_default", { id: "invalid" })).toMatchObject({
    status: "rejected",
    error: { code: "E_VALIDATION" },
  });
  await executable("npm", "process.exit(1)");
  events.length = 0;
  const failed = manager(events);
  expect(await failed.handle("agents_update", { id: "claude" })).toMatchObject({ status: "accepted" });
  await vi.waitFor(() => expect(events.at(-1)?.type).toBe("agents_changed"), { timeout: 5000 });
  expect(events[0]).toMatchObject({ type: "agents_output", done: true, ok: false });
});

it("kills a hanging version probe after three seconds without listeners", async () => {
  const path = await executable("claude", "setInterval(() => {}, 1000)");
  const start = performance.now();
  expect(await programVersion(path)).toBeNull();
  expect(performance.now() - start).toBeLessThan(3400);
}, 5000);
