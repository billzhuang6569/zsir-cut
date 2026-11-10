import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFile, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { type AgentKind, agentParser, type ChatEvent } from "./agent-events.js";
import { findProgram, programVersion, spawnProgram } from "./agent-management.js";
import { proxyEnvironment } from "./proxy.js";
import { hostPath } from "./runtime.js";

export interface Chat {
  id: string;
  agent: AgentKind;
  events: ChatEvent[];
}
const skill = fileURLToPath(new URL("../../../skills/zsir-cut/SKILL.md", import.meta.url));
export class Agents {
  private active: { chat: string; child: ChildProcess; done: Promise<void> } | undefined;
  get activeChat() {
    return this.active?.chat;
  }
  private busy = false;
  selected: AgentKind | undefined;
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
      directories?: string[];
      proxy?: () => string;
    },
  ) {}
  private async command(agent: AgentKind) {
    const path = this.options.commands?.[agent] ?? (await findProgram(agent, this.options.directories));
    if (!path) throw new Error(`没有找到 ${agent}`);
    return path;
  }
  async detect() {
    return Promise.all(
      (["claude", "codex"] as const).map(async (agent) => {
        const path = await this.command(agent).catch(() => null);
        const version = await programVersion(path, this.options.proxy?.());
        return { agent, available: version !== null, version };
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
    const chats = await Promise.all(
      names
        .filter((name) => /^chat_[a-zA-Z0-9_-]+\.jsonl$/.test(name))
        .sort()
        .map(async (name) => {
          const chat = await this.history(name.slice(0, -6));
          return {
            id: chat.id,
            agent: chat.agent,
            updated_at: (await stat(this.path(chat.id))).mtime.toISOString(),
            title: chat.events.find((e) => e.type === "user")?.text?.slice(0, 80) ?? "新对话",
          };
        }),
    );
    return chats.sort((a, b) => b.updated_at.localeCompare(a.updated_at) || a.id.localeCompare(b.id));
  }
  async send(agent: AgentKind, text: string, chatId?: string) {
    if (this.busy) throw new Error("Agent 正在回复");
    if (!["claude", "codex"].includes(agent) || !text.trim() || text.length > 100000)
      throw new Error("Invalid message");
    this.selected = agent;
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
      const desktopInstructions = `所有输出都必须使用用户使用的语言，包括调用工具前后的说明、过渡句、进度说明和最终回复；用户用中文时全部用中文，不夹用英文过渡句；未明确语言时默认中文。桌面模式下，应用会在 transcribe 完成后自动整理字幕，Agent 必须等待整理完成，不得自行再跑语义断句。桌面模式：只通过 mcp__zsir-cut__* 工具操作工程，不使用 CLI、shell 或文件写入。当前工程：${this.options.project}。写入 author.kind=agent，edit 必须带 label；使用 manual 编辑会话，交出草稿用 session_review，不能自行批准。\n每次回复的最后一行，如果你有把握用户下一句最可能说什么，写成 \`【下一步】\` 加一句话（不超过 30 个字，用用户的口吻）。没把握就不写。`;
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
        if (event.type === "end") this.writes = this.writes.then(() => this.options.emit(id, event));
        else this.options.emit(id, event);
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
              "--skip-git-repo-check",
              "--sandbox",
              "read-only",
              "-c",
              `mcp_servers.zsir-cut.url=${JSON.stringify(this.options.url)}`,
              "-c",
              'mcp_servers.zsir-cut.bearer_token_env_var="ZCUT_MCP_TOKEN"',
              ...(resume ? ["resume", resume] : []),
              "-",
            ];
      const command = await this.command(agent);
      if (this.cancelRequested) throw new Error("已停止");
      const child = spawnProgram(command, args, {
        windowsHide: true,
        cwd: dirname(this.options.project),
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...proxyEnvironment(this.options.proxy?.()), PATH: hostPath(), ZCUT_MCP_TOKEN: this.options.token },
      });
      const parse = agentParser(agent, (event) => {
        if (event.type !== "end") emit(event);
      });
      const output = createInterface({ input: child.stdout });
      output.on("line", parse);
      const stderr = createInterface({ input: child.stderr });
      const stderrLines: string[] = [];
      stderr.on("line", (line) => {
        const text = line.replaceAll(this.options.token, "[redacted]");
        stderrLines.push(text);
        if (stderrLines.length > 20) stderrLines.shift();
        emit({ type: "log", text });
      });
      emit({ type: "user", text });
      const temp = directory;
      const done = new Promise<void>((resolve) => {
        child.once("error", (error) => emit({ type: "error", text: error.message }));
        child.once("close", (code, signal) => {
          void (async () => {
            try {
              parse.finish();
              if (code && !signal) {
                const detail = stderrLines
                  .filter((line) => line.trim())
                  .slice(-5)
                  .join("\n");
                if (detail) emit({ type: "error", text: detail });
                emit({ type: "error", text: `Agent 退出（${code}），请检查 CLI 输出和版本` });
              }
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
      this.active = { chat: id, child, done };
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
  async subtitlePass(agent: AgentKind, prompt: string, signal: AbortSignal): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), "zcut-subtitle-pass-"));
    try {
      if (signal.aborted) throw new Error("整理已停止");
      const args =
        agent === "claude"
          ? [
              "-p",
              "--output-format",
              "json",
              "--tools",
              "",
              "--strict-mcp-config",
              "--mcp-config",
              '{"mcpServers":{}}',
              "--disable-slash-commands",
              "--no-session-persistence",
              "--settings",
              '{"disableAllHooks":true}',
            ]
          : [
              "exec",
              "--sandbox",
              "read-only",
              "--ignore-user-config",
              "--skip-git-repo-check",
              "--ephemeral",
              "-c",
              'web_search="disabled"',
              "-c",
              "features.shell_tool=false",
              "-c",
              "features.apps=false",
              "-c",
              "features.plugins=false",
              "-c",
              "features.multi_agent=false",
              "-c",
              "features.hooks=false",
              ...[
                "browser_use",
                "computer_use",
                "image_generation",
                "memories",
                "skill_search",
                "goals",
                "sleep_tool",
                "code_mode_host",
              ].flatMap((feature) => ["-c", `features.${feature}=false`]),
              "-c",
              "mcp_servers={}",
              "--output-last-message",
              join(directory, "output.json"),
              "-",
            ];
      const command = await this.command(agent);
      const output = await new Promise<string>((resolve, reject) => {
        const child = spawnProgram(command, args, {
          windowsHide: true,
          cwd: directory,
          stdio: ["pipe", "pipe", "pipe"],
          detached: process.platform !== "win32",
          env: { ...proxyEnvironment(this.options.proxy?.()), PATH: hostPath() },
        });
        // CLI launchers can spawn another process; kill the whole group on timeout.
        const kill = () => {
          if (process.platform === "win32" || !child.pid) child.kill("SIGKILL");
          else {
            try {
              process.kill(-child.pid, "SIGKILL");
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "ESRCH") child.kill("SIGKILL");
            }
          }
        };
        let stdout = "";
        let stderr = "";
        let failure: Error | undefined;
        const abort = () => {
          failure = new Error("字幕整理 Agent 已停止");
          kill();
        };
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
        child.stdout.on("data", (data: Buffer) => {
          if (stdout.length + data.length > 1024 * 1024) {
            failure = new Error("Agent 输出过大");
            kill();
          } else stdout += data.toString();
        });
        child.stderr.on("data", (data: Buffer) => {
          stderr += data.toString().slice(0, Math.max(0, 65536 - stderr.length));
        });
        child.once("error", () => {
          failure = new Error("无法启动字幕整理 Agent");
        });
        child.once("close", (code) => {
          signal.removeEventListener("abort", abort);
          if (failure) reject(failure);
          else if (code !== 0) {
            let detail = stderr;
            try {
              const parsed = JSON.parse(stdout);
              if (typeof parsed.result === "string") detail += ` ${parsed.result}`;
            } catch {}
            reject(new Error(detail || `Agent 退出（${code}），请检查 CLI 输出和版本`));
          } else resolve(stdout);
        });
        child.stdin.on("error", () => {});
        child.stdin.end(prompt);
      });
      if (agent === "codex") {
        const output = join(directory, "output.json");
        if ((await stat(output)).size > 1024 * 1024) throw new Error("Agent 输出过大");
        return await readFile(output, "utf8");
      }
      const result = JSON.parse(output);
      if (result.is_error || typeof result.result !== "string")
        throw new Error(typeof result.result === "string" ? result.result : "Agent 未返回文字结果");
      return result.result;
    } finally {
      await rm(directory, { recursive: true, force: true });
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
