import { readFileSync } from "node:fs";
import { mkdtemp, readFile, realpath, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type AgentKind, agentParser, type ChatEvent } from "../src/agent-events.js";
import { Agents } from "../src/agents.js";

const directories: string[] = [];
const managers: Agents[] = [];
afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.stop()));
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })),
  );
});
async function fixture(agent: AgentKind, mode = "normal") {
  const directory = await mkdtemp(join(tmpdir(), "zcut37-test-"));
  directories.push(directory);
  const script = join(directory, agent);
  const capture = join(directory, "capture.json");
  await writeFile(
    script,
    `#!${process.execPath}
import {readFileSync,writeFileSync,statSync} from 'node:fs';
const args=process.argv.slice(2);
if(args.includes('--version')) { console.log('${agent} test-version'); process.exit(0); }
const config=args[args.indexOf('--mcp-config')+1];
writeFileSync(${JSON.stringify(capture)},JSON.stringify({args,cwd:process.cwd(),config:${agent === "claude" ? "config,mode:statSync(config).mode&0o777,body:JSON.parse(readFileSync(config,'utf8'))" : "null"}}));
let input='';process.stdin.on('data',chunk=>input+=chunk);
process.stdin.resume();
process.stdin.on('end',()=> {
const captured=JSON.parse(readFileSync(${JSON.stringify(capture)},'utf8'));captured.input=input;writeFileSync(${JSON.stringify(capture)},JSON.stringify(captured));
const events=${JSON.stringify(
      agent === "claude"
        ? [
            { type: "system", subtype: "init", session_id: "native-session" },
            { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "你" } } },
            { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "好" } } },
            {
              type: "assistant",
              message: {
                content: [
                  { type: "text", text: "你好" },
                  { type: "tool_use", id: "tool-1", name: "mcp__zsir-cut__zcut_inspect", input: { view: "brief" } },
                ],
              },
            },
            { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tool-1", content: "ok" }] } },
            { type: "future_event" },
            { type: "result", is_error: false },
          ]
        : [
            { type: "thread.started", thread_id: "native-session" },
            { type: "item.updated", item: { id: "text-1", type: "agent_message", text: "你" } },
            { type: "item.completed", item: { id: "text-1", type: "agent_message", text: "你好" } },
            {
              type: "item.started",
              item: { id: "tool-1", type: "mcp_tool_call", tool: "zcut_inspect", arguments: { view: "brief" } },
            },
            {
              type: "item.completed",
              item: {
                id: "tool-1",
                type: "mcp_tool_call",
                tool: "zcut_inspect",
                arguments: { view: "brief" },
                result: "ok",
              },
            },
            { type: "future_event" },
            { type: "turn.completed" },
          ],
    )};
if (${JSON.stringify(mode)} === 'error') { process.stderr.write('not logged in\\n'); process.exitCode=1; return; }
if (${JSON.stringify(mode)} === 'suggestion') {
const text='\\n【下一步】 继续剪辑';
events.splice(-1,0,${agent === "claude" ? "{type:'stream_event',event:{type:'content_block_delta',delta:{text}}}" : "{type:'item.completed',item:{id:'suggestion',type:'agent_message',text}}"});
}
for(const event of events) process.stdout.write(JSON.stringify(event)+'\\n');
if (${JSON.stringify(mode)} === 'stop') setInterval(()=>{},1000);
});
`,
    { mode: 0o700 },
  );
  const events: ChatEvent[] = [];
  const manager = new Agents({
    project: join(directory, "project.zcut.json"),
    projectId: "prj_test",
    url: "http://127.0.0.1:12345/mcp",
    token: "test-token",
    commands: { claude: script, codex: script },
    emit: (chat, event) => {
      if (event.type === "end")
        expect(
          JSON.parse(
            readFileSync(join(directory, ".zcut", "prj_test", "chats", `${chat}.jsonl`), "utf8")
              .trim()
              .split("\n")
              .at(-1) ?? "null",
          ),
        ).toEqual(event);
      events.push(event);
    },
  });
  managers.push(manager);
  return { directory, manager, events, capture };
}

describe("local agent conversations with fake executables", () => {
  for (const agent of ["claude", "codex"] as const)
    it(`${agent}: streams text and tools, persists history and resumes`, async () => {
      const { directory, manager, events, capture } = await fixture(agent);
      expect((await manager.detect())[0]).toMatchObject({
        available: true,
        version: expect.stringContaining("test-version"),
      });
      const chat = await manager.send(agent, "做粗剪");
      await vi.waitFor(() => expect(events.at(-1)?.type).toBe("end"), { timeout: 15000, interval: 10 });
      expect(events.filter((event) => event.type === "text").map((event) => event.text)).toEqual(["你", "好"]);
      expect(events).toContainEqual(expect.objectContaining({ type: "tool_start", id: "tool-1" }));
      expect(events).toContainEqual(expect.objectContaining({ type: "tool_end", id: "tool-1" }));
      expect(events).toContainEqual(
        expect.objectContaining({ type: "log", text: expect.stringContaining("future_event") }),
      );
      expect((await manager.history(chat.id)).events).toEqual(events);
      const reopened = new Agents({
        project: join(directory, "project.zcut.json"),
        projectId: "prj_test",
        url: "http://unused",
        token: "unused",
        emit: () => {},
      });
      expect(await reopened.list()).toEqual([{ id: chat.id, agent, title: "做粗剪", updated_at: expect.any(String) }]);
      const details = JSON.parse(await readFile(capture, "utf8"));
      expect(details.input).toContain("所有输出都必须使用用户使用的语言");
      expect(details.input).toContain("包括调用工具前后的说明、过渡句、进度说明和最终回复");
      expect(details.input).toContain("用户用中文时全部用中文");
      expect(details.input).toContain(
        "每次回复的最后一行，如果你有把握用户下一句最可能说什么，写成 `【下一步】` 加一句话（不超过 30 个字，用用户的口吻）。没把握就不写。",
      );
      expect(details.cwd).toBe(await realpath(directory));
      if (agent === "claude") {
        expect(details.mode).toBe(0o600);
        expect(details.body.mcpServers["zsir-cut"].headers.Authorization).toBe("Bearer test-token");
        await expect(stat(details.config)).rejects.toMatchObject({ code: "ENOENT" });
        expect(details.args).toEqual(
          expect.arrayContaining(["--strict-mcp-config", "--tools", "", "--allowedTools", "mcp__zsir-cut__*"]),
        );
      } else expect(details.args).toEqual(expect.arrayContaining(["--sandbox", "read-only", "-c"]));
      events.length = 0;
      await manager.send(agent, "继续", chat.id);
      await vi.waitFor(() => expect(events.at(-1)?.type).toBe("end"), { timeout: 15000, interval: 10 });
      const resumed = JSON.parse(await readFile(capture, "utf8"));
      expect(resumed.args).toEqual(
        expect.arrayContaining([agent === "claude" ? "--resume" : "resume", "native-session"]),
      );
    }, 35000);

  it("stops a running agent, deletes configuration, and prevents overlapping sends", async () => {
    const { manager, events, capture } = await fixture("claude", "stop");
    await manager.send("claude", "等待");
    await vi.waitFor(() => expect(events.some((e) => e.type === "text")).toBe(true), { timeout: 15000, interval: 10 });
    const details = JSON.parse(await readFile(capture, "utf8"));
    expect((await stat(details.config)).mode & 0o777).toBe(0o600);
    await expect(manager.send("claude", "不能并行")).rejects.toThrow("正在回复");
    await manager.stop();
    expect(events.at(-1)).toEqual({ type: "end", text: "已停止" });
    await expect(stat(details.config)).rejects.toMatchObject({ code: "ENOENT" });
  }, 20000);
  it("reports authentication/process errors and unavailable executables without crashing", async () => {
    const { manager, events } = await fixture("codex", "error");
    await manager.send("codex", "hi");
    await vi.waitFor(() => expect(events.at(-1)?.type).toBe("end"), { timeout: 15000, interval: 10 });
    expect(events).toContainEqual({ type: "error", text: "not logged in" });
    expect(events).toContainEqual(
      expect.objectContaining({ type: "error", text: expect.stringContaining("退出（1）") }),
    );
    const absent = new Agents({
      project: "/unused",
      projectId: "prj_test",
      url: "unused",
      token: "unused",
      commands: { claude: "/not-installed", codex: "/not-installed" },
      emit: () => {},
    });
    expect(await absent.detect()).toEqual([
      { agent: "claude", available: false, version: null },
      { agent: "codex", available: false, version: null },
    ]);
    await expect(manager.history("../../escape")).rejects.toThrow("Invalid chat ID");
  }, 20000);
});

it("ignores malformed and unfamiliar records and normalizes error events", () => {
  for (const kind of ["claude", "codex"] as const) {
    const events: ChatEvent[] = [];
    const parse = agentParser(kind, (event) => events.push(event));
    for (const raw of [
      "broken",
      "null",
      "1",
      "{}",
      '{"type":"item.completed","item":null}',
      '{"type":"assistant","message":{"content":[null]}}',
    ])
      expect(() => parse(raw)).not.toThrow();
    parse(
      JSON.stringify(
        kind === "claude"
          ? { type: "result", is_error: true, errors: ["version incompatible"] }
          : { type: "turn.failed", error: { message: "version incompatible" } },
      ),
    );
    expect(events).toContainEqual({ type: "error", text: "version incompatible" });
  }
});

it("preserves explicit failed tool results from both agents", () => {
  for (const agent of ["claude", "codex"] as const) {
    const events: ChatEvent[] = [];
    const parse = agentParser(agent, (event) => events.push(event));
    parse(
      JSON.stringify(
        agent === "claude"
          ? {
              type: "user",
              message: { content: [{ type: "tool_result", tool_use_id: "failed", is_error: true, content: "失败" }] },
            }
          : { type: "item.completed", item: { type: "mcp_tool_call", id: "failed", error: { message: "失败" } } },
      ),
    );
    expect(events).toContainEqual(expect.objectContaining({ type: "tool_end", id: "failed", failed: true }));
  }
});

it("orders saved conversations by modification time across host restarts", async () => {
  const { directory, manager, events } = await fixture("claude");
  const first = await manager.send("claude", "第一个");
  await vi.waitFor(() => expect(events.at(-1)?.type).toBe("end"), { timeout: 15000, interval: 10 });
  events.length = 0;
  const second = await manager.send("claude", "第二个");
  await vi.waitFor(() => expect(events.at(-1)?.type).toBe("end"), { timeout: 15000, interval: 10 });
  const root = join(directory, ".zcut", "prj_test", "chats");
  await utimes(join(root, `${second.id}.jsonl`), new Date("2020-01-01"), new Date("2020-01-01"));
  await utimes(join(root, `${first.id}.jsonl`), new Date("2021-01-01"), new Date("2021-01-01"));
  const reopened = new Agents({
    project: join(directory, "project.zcut.json"),
    projectId: "prj_test",
    url: "unused",
    token: "unused",
    emit: () => {},
  });
  expect((await reopened.list()).map((chat) => [chat.id, chat.updated_at])).toEqual([
    [first.id, "2021-01-01T00:00:00.000Z"],
    [second.id, "2020-01-01T00:00:00.000Z"],
  ]);
  expect((await reopened.history(first.id)).events).toContainEqual({ type: "text", text: "好" });
}, 35000);

it.each(["claude", "codex"] as const)("runs an isolated headless subtitle pass with %s", async (agent) => {
  const directory = await mkdtemp(join(tmpdir(), "zcut-pass-runner-"));
  directories.push(directory);
  const script = join(directory, "fake-agent");
  const capture = join(directory, "capture.json");
  await writeFile(
    script,
    `#!${process.execPath}
const {writeFileSync}=require('node:fs');
const args=process.argv.slice(2); let input='';
process.stdin.on('data',chunk=>input+=chunk);
process.stdin.on('end',()=>{
writeFileSync(${JSON.stringify(capture)},JSON.stringify({args,input,cwd:process.cwd()}));
const result='{"lines":["字幕"]}';
if(args.includes('--output-last-message')) writeFileSync(args[args.indexOf('--output-last-message')+1],result);
else process.stdout.write(JSON.stringify({result,is_error:false}));
});`,
    { mode: 0o700 },
  );
  const manager = new Agents({
    project: join(directory, "project.zcut.json"),
    projectId: "prj_test",
    url: "unused",
    token: "unused",
    emit: () => {},
    commands: { claude: script, codex: script },
  });
  const result = await manager.subtitlePass(agent, "只输出 JSON", new AbortController().signal);
  expect(JSON.parse(result)).toEqual({ lines: ["字幕"] });
  const captured = JSON.parse(await readFile(capture, "utf8"));
  expect(captured.input).toBe("只输出 JSON");
  expect(captured.cwd).not.toBe(directory);
  await expect(stat(captured.cwd)).rejects.toMatchObject({ code: "ENOENT" });
  if (agent === "claude") {
    expect(captured.args).toEqual(
      expect.arrayContaining([
        "-p",
        "--output-format",
        "json",
        "--tools",
        "",
        "--strict-mcp-config",
        '{"mcpServers":{}}',
      ]),
    );
    expect(captured.args).not.toContain("--model");
  } else {
    expect(captured.args).toEqual(
      expect.arrayContaining([
        "exec",
        "--sandbox",
        "read-only",
        "--ignore-user-config",
        "features.shell_tool=false",
        "features.apps=false",
        "mcp_servers={}",
      ]),
    );
    expect(captured.args).not.toContain("tools.update_plan=false");
  }
});

it("aborts a subtitle Agent process and cleans its isolated directory", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zcut-pass-abort-"));
  directories.push(directory);
  const script = join(directory, "fake-agent");
  const capture = join(directory, "capture.json");
  await writeFile(
    script,
    `#!${process.execPath}
const {writeFileSync}=require('node:fs');
writeFileSync(${JSON.stringify(capture)}, JSON.stringify({cwd:process.cwd(),pid:process.pid}));
process.stdin.resume(); setInterval(()=>{},1000);`,
    { mode: 0o700 },
  );
  const manager = new Agents({
    project: join(directory, "project.zcut.json"),
    projectId: "prj_test",
    url: "unused",
    token: "unused",
    emit: () => {},
    commands: { claude: script, codex: script },
  });
  const abort = new AbortController();
  const task = manager.subtitlePass("claude", "只输出 JSON", abort.signal);
  const rejected = expect(task).rejects.toThrow("已停止");
  await vi.waitFor(async () => expect((await stat(capture)).size).toBeGreaterThan(0), { timeout: 15000 });
  const captured = JSON.parse(await readFile(capture, "utf8"));
  abort.abort();
  await rejected;
  expect(() => process.kill(captured.pid, 0)).toThrow();
  await expect(stat(captured.cwd)).rejects.toMatchObject({ code: "ENOENT" });
}, 20000);

it("retains Claude authentication details from nonzero JSON output", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zcut-pass-auth-"));
  directories.push(directory);
  const script = join(directory, "fake-agent");
  await writeFile(
    script,
    `#!${process.execPath}\nprocess.stdout.write(JSON.stringify({is_error:true,result:'Failed to authenticate: OAuth session expired'})); process.exitCode=1;`,
    { mode: 0o700 },
  );
  const manager = new Agents({
    project: join(directory, "project.zcut.json"),
    projectId: "prj_test",
    url: "unused",
    token: "unused",
    emit: () => {},
    commands: { claude: script, codex: script },
  });
  await expect(manager.subtitlePass("claude", "test", new AbortController().signal)).rejects.toThrow(
    "Failed to authenticate",
  );
});

describe.each(["claude", "codex"] as const)("%s next-step suggestions", (agent) => {
  function stream() {
    const events: ChatEvent[] = [];
    const parse = agentParser(agent, (event) => events.push(event));
    let full = "";
    return {
      events,
      push(chunk: string) {
        full += chunk;
        parse(
          JSON.stringify(
            agent === "claude"
              ? { type: "stream_event", event: { type: "content_block_delta", delta: { text: chunk } } }
              : { type: "item.updated", item: { id: "reply", type: "agent_message", text: full } },
          ),
        );
      },
      end() {
        if (agent === "claude")
          parse(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: full }] } }));
        else
          parse(JSON.stringify({ type: "item.completed", item: { id: "reply", type: "agent_message", text: full } }));
        parse(JSON.stringify({ type: agent === "claude" ? "result" : "turn.completed" }));
      },
      visible() {
        return events
          .filter((e) => e.type === "text")
          .map((e) => e.text)
          .join("");
      },
    };
  }

  it.each([
    ["正文\n【下一步】 继续 \n\n", "正文\n", "继续"],
    ["正文", "正文", undefined],
    ["【下一步】旧【下一步】 新建议", "", "新建议"],
    ["正文\n【下一步】建议\n继续正文", "正文\n【下一步】建议\n继续正文", undefined],
    ["正文里【下一步】建议", "正文里【下一步】建议", undefined],
    ["正文\n 【下一步】建议", "正文\n 【下一步】建议", undefined],
    ["正文\n【下一步】 \r\n \r\n", "正文\n", undefined],
    ["正文\n【下一", "正文\n【下一", undefined],
    ["正文\r\n【下一步】 建议\r\n", "正文\r\n", "建议"],
  ])("extracts only the final non-empty marker line: %j", (reply, visible, suggestion) => {
    for (const chunks of [[reply], [...reply]]) {
      const run = stream();
      for (const chunk of chunks) run.push(chunk);
      run.end();
      expect(run.visible()).toBe(visible);
      expect(run.events.filter((e) => e.type === "suggestion")).toEqual(
        suggestion ? [{ type: "suggestion", text: suggestion }] : [],
      );
      expect(run.events.at(-1)).toEqual({ type: "end" });
    }
  });

  it("never flashes a split marker, and releases it when the reply continues", () => {
    const run = stream();
    run.push("正文\n");
    for (const chunk of [..."【下一步】继续\n\n"]) {
      run.push(chunk);
      expect(run.visible()).toBe("正文\n");
      expect(run.events.some((e) => e.type === "suggestion")).toBe(false);
    }
    run.push("后续正文");
    expect(run.visible()).toBe("正文\n【下一步】继续\n\n后续正文");
    run.end();
    expect(run.events.some((e) => e.type === "suggestion")).toBe(false);
  });

  it("handles Claude non-streamed text and Codex completed-only items", () => {
    const events: ChatEvent[] = [];
    const parse = agentParser(agent, (event) => events.push(event));
    parse(
      JSON.stringify(
        agent === "claude"
          ? { type: "assistant", message: { content: [{ type: "text", text: "正文\n【下一步】继续" }] } }
          : { type: "item.completed", item: { id: "reply", type: "agent_message", text: "正文\n【下一步】继续" } },
      ),
    );
    parse(JSON.stringify({ type: agent === "claude" ? "result" : "turn.completed" }));
    expect(events).toEqual([{ type: "text", text: "正文\n" }, { type: "suggestion", text: "继续" }, { type: "end" }]);
  });

  it("persists suggestions and filtered text across host restarts", async () => {
    const { directory, manager, events } = await fixture(agent, "suggestion");
    const chat = await manager.send(agent, "剪辑");
    await vi.waitFor(() => expect(events.at(-1)?.type).toBe("end"), { timeout: 15000, interval: 10 });
    const reopened = new Agents({
      project: join(directory, "project.zcut.json"),
      projectId: "prj_test",
      url: "unused",
      token: "unused",
      emit: () => {},
    });
    const history = await reopened.history(chat.id);
    expect(history.events).toEqual(events);
    expect(history.events).toContainEqual({ type: "suggestion", text: "继续剪辑" });
    expect(
      history.events
        .filter((e) => e.type === "text")
        .map((e) => e.text)
        .join(""),
    ).toBe("你好\n");
  }, 20000);
});

it("launches a PATH-discovered absolute executable after changing working directory", async () => {
  const { directory, capture } = await fixture("claude");
  const events: ChatEvent[] = [];
  const manager = new Agents({
    project: join(directory, "project.zcut.json"),
    projectId: "prj_test",
    url: "http://unused",
    token: "test",
    emit: (_chat, event) => events.push(event),
    directories: [directory],
  });
  managers.push(manager);
  await manager.send("claude", "hello");
  await vi.waitFor(() => expect(events.at(-1)?.type).toBe("end"), { timeout: 15000 });
  expect(JSON.parse(await readFile(capture, "utf8")).cwd).toBe(await realpath(directory));
  expect(events.some((event) => event.type === "text")).toBe(true);
}, 20000);
