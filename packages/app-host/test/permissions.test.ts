import { spawnSync } from "node:child_process";
import { once } from "node:events";
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { dispatch, parseProject, type Verb } from "../../core/src/index.ts";
import { Agents } from "../src/agents.js";
import { createMcpServer, startHost } from "../src/index.js";
import { Permissions, permissionDenied } from "../src/permissions.js";

type Message = { type?: string; id: string; verb?: Verb; envelope?: unknown };
let directory: string;
let project: string;
let host: Awaited<ReturnType<typeof startHost>> | undefined;
const clients: Client[] = [];
const sockets: WebSocket[] = [];
beforeEach(async () => {
  vi.spyOn(Agents.prototype, "detect").mockResolvedValue([]);
  directory = await mkdtemp(join(tmpdir(), "zcut-permissions-"));
  project = join(directory, "project.zcut.json");
  await copyFile(new URL("../../../examples/interview.zcut.json", import.meta.url), project);
});
afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  await host?.close();
  host = undefined;
  for (const client of clients.splice(0)) await client.close();
  await rm(directory, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
async function start() {
  host = await startHost({ project, appDataDir: directory, dispatchOptions: { worker: true } });
  const client = new Client({ name: "permission-test", version: "1" });
  clients.push(client);
  const [left, right] = InMemoryTransport.createLinkedPair();
  await Promise.all([host.mcp.connect(left), client.connect(right)]);
  return client;
}
async function ui() {
  if (!host) throw new Error("Missing host");
  const socket = new WebSocket(`ws://127.0.0.1:${host.port}/?token=${host.token}`);
  sockets.push(socket);
  await once(socket, "open");
  const messages: Message[] = [];
  socket.on("message", (raw) => messages.push(JSON.parse(raw.toString())));
  socket.send(JSON.stringify({ type: "ui_ready" }));
  await vi.waitFor(() => expect(messages[0]?.type).toBe("bootstrap"));
  return { socket, messages };
}
async function exportRequest(suffix = "one") {
  const source = JSON.parse(await readFile(project, "utf8"));
  return {
    project,
    base_revision: source.revision.id,
    idempotency_key: suffix,
    author: { kind: "agent", name: "测试" },
    profile: "direct-srt",
    output: join(directory, suffix),
  };
}
async function answer(socket: WebSocket, id: string, value = "once", message?: string) {
  const reply = new Promise<Record<string, unknown>>((resolve) => {
    const onMessage = (raw: Buffer) => {
      const result = JSON.parse(raw.toString());
      if (result.id === `answer-${id}`) {
        socket.off("message", onMessage);
        resolve(result);
      }
    };
    socket.on("message", onMessage);
  });
  socket.send(
    JSON.stringify({ id: `answer-${id}`, verb: "permission_answer", request: { id, answer: value, message } }),
  );
  return reply;
}
const requests = (messages: Message[]) => messages.filter((message) => message.type === "permission_request");

it("holds host MCP exports until once; project consent survives host restart", async () => {
  let client = await start();
  let connected = await ui();
  const request = await exportRequest();
  const exporting = client.callTool({ name: "zcut_export", arguments: request });
  await vi.waitFor(() => expect(requests(connected.messages)).toHaveLength(1));
  const prompt = requests(connected.messages)[0];
  if (!prompt) throw new Error("Missing permission request");
  expect(prompt).toMatchObject({
    id: expect.stringMatching(/^prm_/),
    verb: "export",
    title: "导出到「one」",
    target: request.output,
    command: request,
  });
  await expect(readdir(request.output)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await answer(connected.socket, prompt.id)).toMatchObject({ type: "result", envelope: { status: "applied" } });
  expect((await exporting).structuredContent).toMatchObject({ ok: true, status: "applied" });
  expect((await readdir(request.output)).some((name) => name.endsWith(".srt"))).toBe(true);
  const second = client.callTool({ name: "zcut_export", arguments: await exportRequest("two") });
  await vi.waitFor(() => expect(requests(connected.messages)).toHaveLength(2));
  await answer(connected.socket, requests(connected.messages)[1]?.id ?? "missing", "project");
  expect((await second).structuredContent).toMatchObject({ ok: true });
  const source = JSON.parse(await readFile(project, "utf8"));
  const file = join(directory, ".zcut", source.id, "permissions.json");
  expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
    schema: "zsir-cut/permissions",
    version: 1,
    allow: ["export"],
  });
  expect((await readdir(join(directory, ".zcut", source.id))).some((name) => name.endsWith(".tmp"))).toBe(false);
  await host?.close();
  client = await start();
  connected = await ui();
  expect(
    (await client.callTool({ name: "zcut_export", arguments: await exportRequest("three") })).structuredContent,
  ).toMatchObject({ ok: true });
  expect(requests(connected.messages)).toEqual([]);
});

it("denies disconnected UI and explicit refusals, preserves pending order across reload, and Stop denies them", async () => {
  const client = await start();
  const first = await exportRequest();
  expect((await client.callTool({ name: "zcut_export", arguments: first })).structuredContent).toMatchObject({
    status: "rejected",
    error: { code: "E_PERMISSION_DENIED", details: { message: "桌面版界面没有打开" } },
  });
  let connected = await ui();
  const one = client.callTool({ name: "zcut_export", arguments: first });
  const two = client.callTool({ name: "zcut_terms_edit", arguments: { ops: [] } });
  await vi.waitFor(() => expect(requests(connected.messages)).toHaveLength(2));
  const ids = requests(connected.messages).map((request) => request.id);
  const closed = once(connected.socket, "close");
  connected.socket.close();
  await closed;
  connected = await ui();
  await vi.waitFor(() => expect(requests(connected.messages).map((request) => request.id)).toEqual(ids));
  expect(await answer(connected.socket, ids[0] ?? "missing", "deny", "请先检查字幕")).toMatchObject({
    envelope: { ok: true },
  });
  expect((await one).structuredContent).toMatchObject({
    status: "rejected",
    receipt: null,
    error: { code: "E_PERMISSION_DENIED", details: { message: "请先检查字幕" } },
  });
  expect(await answer(connected.socket, ids[0] ?? "missing")).toMatchObject({
    envelope: { status: "rejected", error: { code: "E_VALIDATION" } },
  });
  connected.socket.send(JSON.stringify({ id: "stop", verb: "chat_stop", request: {} }));
  expect((await two).structuredContent).toMatchObject({
    error: { code: "E_PERMISSION_DENIED", details: { message: "对话已停止" } },
  });
});

it("does not gate inspect, edit or dry-run exports; kernel dispatch and CLI export retain parity", async () => {
  const client = await start();
  const connected = await ui();
  const request = await exportRequest();
  expect(
    (await client.callTool({ name: "zcut_inspect", arguments: { project, view: "brief" } })).structuredContent,
  ).toMatchObject({ ok: true });
  expect((await client.callTool({ name: "zcut_edit", arguments: { project } })).structuredContent).toMatchObject({
    error: { code: "E_VALIDATION" },
  });
  expect(
    (await client.callTool({ name: "zcut_export", arguments: { ...request, dry_run: true } })).structuredContent,
  ).toMatchObject({ ok: true, status: "dry_run" });
  expect(requests(connected.messages)).toEqual([]);
  expect(await dispatch("export", request, { worker: true })).toMatchObject({ ok: true, status: "applied" });
  const cli = fileURLToPath(new URL("../../cli/src/index.ts", import.meta.url));
  const run = spawnSync(process.execPath, [cli, "export"], { input: JSON.stringify(request), encoding: "utf8" });
  // The existing output is rejected by the exporter, proving CLI reached it without a permission gate.
  expect(JSON.parse(run.stdout)).toMatchObject({ error: { code: "E_VALIDATION" } });
  expect((await client.listTools()).tools.map((tool) => tool.name)).not.toContain("zcut_permission_answer");
  await expect(client.callTool({ name: "zcut_permission_answer", arguments: {} })).rejects.toThrow("Unknown tool");
});

it("gates exactly the listed verbs, handles cloud fallback, isolates chat stops, and recovers corrupt stores", async () => {
  vi.stubEnv("HOME", directory);
  const parsed = parseProject(await readFile(project, "utf8"));
  if (!parsed.ok) throw new Error("Invalid fixture");
  const load = async () => parsed.project;
  const prompts: { id: string; verb: Verb }[] = [];
  const gate = new Permissions(() => (request) => prompts.push(request));
  for (const verb of [
    "export",
    "record_handoff_check",
    "voice_generate",
    "voice_clone",
    "terms_edit",
    "voice_edit",
    "transcribe",
  ] as const) {
    const result = gate.request(verb, { engine: "cloud" }, project, load, "chat_one");
    await vi.waitFor(() => expect(prompts.at(-1)?.verb).toBe(verb));
    await gate.answer({ id: prompts.at(-1)?.id, answer: "deny" });
    expect(await result).toBe("");
  }
  for (const [verb, command] of [
    ["inspect", {}],
    ["edit", {}],
    ["export", { dry_run: true }],
    ["transcribe", { engine: "local" }],
    ["transcribe", {}],
  ] as const)
    expect(await gate.request(verb, command, project, load)).toBeNull();
  await mkdir(join(directory, ".zsir-cut"));
  await writeFile(join(directory, ".zsir-cut/config.json"), JSON.stringify({ asr: { cloud_fallback: true } }));
  const cloud = gate.request("transcribe", {}, project, load, "chat_two");
  await vi.waitFor(() => expect(prompts).toHaveLength(8));
  gate.denyChat("chat_one");
  await gate.answer({ id: prompts.at(-1)?.id, answer: "once" });
  expect(await cloud).toBeNull();
  const broken = join(directory, ".zcut", parsed.project.id, "permissions.json");
  await mkdir(join(directory, ".zcut", parsed.project.id), { recursive: true });
  await writeFile(broken, '{"schema":"zsir-cut/permissions","version":2,"allow":["export"]}');
  const exporting = gate.request("export", {}, project, load);
  await vi.waitFor(() => expect(prompts).toHaveLength(9));
  await gate.answer({ id: prompts.at(-1)?.id, answer: "project" });
  expect(await exporting).toBeNull();
  expect(await readFile(`${broken}.broken`, "utf8")).toContain('"version":2');
  expect(await gate.request("export", {}, project, load)).toBeNull();
});

it("runs permission-gated MCP exports and CLI/kernel parity without a listener", async () => {
  const prompts: { id: string }[] = [];
  let connected = true;
  const gate = new Permissions(() => (connected ? (request) => prompts.push(request) : undefined));
  const load = async () => {
    const parsed = parseProject(await readFile(project, "utf8"));
    if (!parsed.ok) throw new Error("Invalid fixture");
    return parsed.project;
  };
  const server = createMcpServer(undefined, async (verb, input) => {
    const message = await gate.request(verb, input as Record<string, unknown>, project, load);
    return message === null ? dispatch(verb, input, { worker: true }) : permissionDenied(verb, message);
  });
  const client = new Client({ name: "offline-permissions", version: "1" });
  clients.push(client);
  const [left, right] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(left), client.connect(right)]);
  try {
    const first = await exportRequest();
    const exporting = client.callTool({ name: "zcut_export", arguments: first });
    await vi.waitFor(() => expect(prompts).toHaveLength(1));
    await expect(readdir(first.output)).rejects.toMatchObject({ code: "ENOENT" });
    await gate.answer({ id: prompts[0]?.id, answer: "once" });
    expect((await exporting).structuredContent).toMatchObject({ ok: true, status: "applied" });
    expect((await readdir(first.output)).some((name) => name.endsWith(".srt"))).toBe(true);
    const second = client.callTool({ name: "zcut_export", arguments: await exportRequest("two") });
    await vi.waitFor(() => expect(prompts).toHaveLength(2));
    await gate.answer({ id: prompts[1]?.id, answer: "deny", message: "稍后再导出" });
    expect((await second).structuredContent).toMatchObject({
      status: "rejected",
      error: { code: "E_PERMISSION_DENIED", details: { message: "稍后再导出" } },
    });
    connected = false;
    expect(
      (await client.callTool({ name: "zcut_export", arguments: await exportRequest("three") })).structuredContent,
    ).toMatchObject({ error: { details: { message: "桌面版界面没有打开" } } });
    const direct = await exportRequest("kernel");
    expect(await dispatch("export", direct, { worker: true })).toMatchObject({ ok: true, status: "applied" });
    const cli = fileURLToPath(new URL("../../cli/src/index.ts", import.meta.url));
    const run = spawnSync(process.execPath, [cli, "export"], { input: JSON.stringify(direct), encoding: "utf8" });
    expect(JSON.parse(run.stdout)).toMatchObject({ error: { code: "E_VALIDATION" } });
  } finally {
    gate.clear();
    await server.close();
  }
});

it("keeps ordered requests indefinitely, replays after reload, and serializes concurrent project grants", async () => {
  const parsed = parseProject(await readFile(project, "utf8"));
  if (!parsed.ok) throw new Error("Invalid fixture");
  const load = async () => parsed.project;
  let connected = true;
  const prompts: { id: string; verb: Verb }[] = [];
  const gate = new Permissions(() => (connected ? (request) => prompts.push(request) : undefined));
  const first = gate.request("export", {}, project, load, "chat_one");
  const second = gate.request("terms_edit", { ops: [] }, project, load, "chat_two");
  await vi.waitFor(() => expect(prompts).toHaveLength(2));
  expect(prompts.map((request) => request.verb)).toEqual(["export", "terms_edit"]);
  let settled = false;
  void first.then(() => {
    settled = true;
  });
  connected = false;
  vi.useFakeTimers();
  try {
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(settled).toBe(false);
  } finally {
    vi.useRealTimers();
  }
  gate.replay();
  expect(prompts).toHaveLength(2);
  connected = true;
  gate.replay();
  expect(prompts.slice(2)).toEqual(prompts.slice(0, 2));
  gate.denyChat("chat_one");
  expect(await first).toBe("对话已停止");
  await expect(gate.answer({ id: prompts[0]?.id, answer: "once" })).rejects.toThrow();
  const third = gate.request("voice_edit", { ops: [] }, project, load, "chat_two");
  await vi.waitFor(() => expect(prompts).toHaveLength(5));
  await expect(gate.answer({ id: prompts[1]?.id, answer: "invalid" })).rejects.toThrow();
  await Promise.all([
    gate.answer({ id: prompts[1]?.id, answer: "project" }),
    gate.answer({ id: prompts[4]?.id, answer: "project" }),
  ]);
  expect(await second).toBeNull();
  expect(await third).toBeNull();
  const restarted = new Permissions(() => undefined);
  expect(await restarted.request("terms_edit", { ops: [] }, project, load)).toBeNull();
  expect(await restarted.request("voice_edit", { ops: [] }, project, load)).toBeNull();
  expect(JSON.parse(await readFile(join(directory, ".zcut", parsed.project.id, "permissions.json"), "utf8"))).toEqual({
    schema: "zsir-cut/permissions",
    version: 1,
    allow: ["terms_edit", "voice_edit"],
  });
});
