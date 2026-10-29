import { type ChildProcess, execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { type AgentKind, agentParser, type ChatEvent } from "./agent-events.js";

export interface Chat {
  id: string;
  agent: AgentKind;
  events: ChatEvent[];
}
const skill = fileURLToPath(new URL("../../../skills/zsir-cut/SKILL.md", import.meta.url));
export class Agents {
  private active: { child: ChildProcess; done: Promise<void> } | undefined;
  private busy = false;
  private cancelRequested = false;
  private writes = Promise.resolve();
  constructor(
    private options: {
      project: string;
      projectId: string;
      url: string;
      token: string;
      emit: (chat: string, event: ChatEvent) => void;
      commands?: Record<AgentKind, string>;
    },
  ) {}
  private command(agent: AgentKind) {
    return this.options.commands?.[agent] ?? agent;
  }
  async detect() {
    return Promise.all(
      (["claude", "codex"] as const).map(async (agent) => {
        try {
          const { stdout } = await promisify(execFile)(this.command(agent), ["--version"], {
            timeout: 3000,
            maxBuffer: 65536,
          });
          return { agent, available: true, version: stdout.trim() };
        } catch {
          return { agent, available: false, version: null };
        }
      }),
    );
  }
  private root() {
    return join(dirname(this.options.project), ".zcut", this.options.projectId, "chats");
  }
  private path(id: string) {
    if (!/^chat_[a-zA-Z0-9_-]+$/.test(id)) throw new Error("Invalid chat ID");
    return join(this.root(), `${id}.jsonl`);
  }
  async history(id: string): Promise<Chat> {
    await this.writes;
    const records = (await readFile(this.path(id), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    return { id, agent: records[0].agent, events: records.slice(1) };
  }
  async list() {
    await this.writes;
    let names: string[];
    try {
      names = await readdir(this.root());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    return Promise.all(
      names
        .filter((name) => /^chat_[a-zA-Z0-9_-]+\.jsonl$/.test(name))
        .sort()
        .map(async (name) => {
          const chat = await this.history(name.slice(0, -6));
          return {
            id: chat.id,
            agent: chat.agent,
            title: chat.events.find((e) => e.type === "user")?.text?.slice(0, 80) ?? "新对话",
          };
        }),
    );
  }
  async send(agent: AgentKind, text: string, chatId?: string) {
    if (this.busy) throw new Error("Agent 正在回复");
    if (!["claude", "codex"].includes(agent) || !text.trim() || text.length > 100000)
      throw new Error("Invalid message");
    this.busy = true;
    this.cancelRequested = false;
    let directory: string | undefined;
    try {
      const id = chatId ?? `chat_${randomUUID()}`;
      const path = this.path(id);
      const chat = chatId ? await this.history(chatId) : { id, agent, events: [] };
      if (chat.agent !== agent) throw new Error("请新建对话切换 Agent");
      await mkdir(this.root(), { recursive: true });
      if (!chatId) await writeFile(path, `${JSON.stringify({ agent })}\n`, { mode: 0o600, flag: "wx" });
      const resume = chat.events.filter((e) => e.type === "session").at(-1)?.id;
      if (resume && !/^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/.test(resume)) throw new Error("Invalid native session ID");
      directory = await mkdtemp(join(tmpdir(), "zcut-agent-"));
      const config = join(directory, "mcp.json");
      await writeFile(
        config,
        JSON.stringify({
          mcpServers: {
            "zsir-cut": {
              type: "http",
              url: this.options.url,
              headers: { Authorization: `Bearer ${this.options.token}` },
            },
          },
        }),
        { mode: 0o600 },
      );
      const desktopInstructions = `桌面模式：只通过 mcp__zsir-cut__* 工具操作工程，不使用 CLI、shell 或文件写入。当前工程：${this.options.project}。写入 author.kind=agent，edit 必须带 label；使用 manual 编辑会话，交出草稿用 session_review，不能自行批准。`;
      const instructions = `${await readFile(skill, "utf8")}\n${desktopInstructions}`;
      let ended = false;
      const emit = (event: ChatEvent) => {
        if (event.type === "end") {
          if (ended) return;
          ended = true;
        }
        this.writes = this.writes
          .then(() => appendFile(path, `${JSON.stringify(event)}\n`))
          .catch(() => {
            this.options.emit(id, { type: "error", text: "对话记录保存失败，请检查磁盘空间和目录权限" });
          });
        this.options.emit(id, event);
      };
      const args =
        agent === "claude"
          ? [
              "-p",
              "--input-format",
              "stream-json",
              "--output-format",
              "stream-json",
              "--verbose",
              "--include-partial-messages",
              "--mcp-config",
              config,
              "--strict-mcp-config",
              "--allowedTools",
              "mcp__zsir-cut__*",
              "--tools",
              "",
              "--append-system-prompt-file",
              skill,
              ...(resume ? ["--resume", resume] : []),
            ]
          : [
              "exec",
              "--json",
              "--sandbox",
              "read-only",
              "-c",
              `mcp_servers.zsir-cut.url=${JSON.stringify(this.options.url)}`,
              "-c",
              'mcp_servers.zsir-cut.bearer_token_env_var="ZCUT_MCP_TOKEN"',
              ...(resume ? ["resume", resume] : []),
              "-",
            ];
      if (this.cancelRequested) throw new Error("已停止");
      const child = spawn(this.command(agent), args, {
        cwd: dirname(this.options.project),
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, ZCUT_MCP_TOKEN: this.options.token },
      });
      const parse = agentParser(agent, (event) => {
        if (event.type !== "end") emit(event);
      });
      const output = createInterface({ input: child.stdout });
      output.on("line", parse);
      const stderr = createInterface({ input: child.stderr });
      stderr.on("line", (line) => emit({ type: "error", text: line.replaceAll(this.options.token, "[redacted]") }));
      emit({ type: "user", text });
      const temp = directory;
      const done = new Promise<void>((resolve) => {
        child.once("error", (error) => emit({ type: "error", text: error.message }));
        child.once("close", (code, signal) => {
          void (async () => {
            try {
              if (code && !signal) emit({ type: "error", text: `Agent 退出（${code}），请检查登录状态和 CLI 版本` });
              await rm(temp, { recursive: true, force: true });
              await this.writes;
            } catch (error) {
              emit({ type: "error", text: `临时配置清理失败：${String(error)}` });
            } finally {
              this.busy = false;
              this.active = undefined;
              emit({ type: "end", ...(signal ? { text: "已停止" } : {}) });
              await this.writes;
              resolve();
            }
          })();
        });
      });
      this.active = { child, done };
      child.stdin.on("error", () => {});
      child.stdin.end(
        agent === "claude"
          ? `${JSON.stringify({ type: "user", message: { role: "user", content: `${desktopInstructions}\n用户消息：${text}` } })}\n`
          : `${instructions}\n\n${text}\n`,
      );
      return { id };
    } catch (error) {
      this.busy = false;
      if (directory) await rm(directory, { recursive: true, force: true });
      throw error;
    }
  }
  async stop() {
    const active = this.active;
    if (!active) {
      this.cancelRequested = this.busy;
      return;
    }
    active.child.kill("SIGTERM");
    const timer = setTimeout(() => active.child.kill("SIGKILL"), 1000);
    try {
      await active.done;
    } finally {
      clearTimeout(timer);
    }
  }
}
