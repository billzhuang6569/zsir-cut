import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFile, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { type AgentKind, agentParser, type ChatEvent } from "./agent-events.js";
import { codexEnvironment, findProgram, programVersion, spawnProgram } from "./agent-management.js";
import { proxyEnvironment } from "./proxy.js";
import { hostPath } from "./runtime.js";

const helpCache = new Map<string, Promise<string | null>>();
function hasOption(help: string, option: string) {
  return new RegExp(`(?<![\\w-])${option}(?![\\w-])`).test(help);
}
async function agentHelp(agent: AgentKind, command: string, proxy: string) {
  const version = await programVersion(command, proxy);
  const key = `${agent}:${command}:${version}`;
  let help = helpCache.get(key);
  if (!help) {
    help = new Promise((resolve) => {
      const child = spawnProgram(command, agent === "claude" ? ["-p", "--help"] : ["exec", "--help"], {
        windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"],
        env: { ...proxyEnvironment(proxy), PATH: hostPath(), ...codexEnvironment(command) },
      });
      let output = "";
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve(null);
      }, 5000);
      child.stdout?.on("data", (chunk: Buffer) => {
        output += chunk.toString();
        if (output.length > 1024 * 1024) {
          child.kill("SIGKILL");
          resolve(null);
        }
      });
      child.once("error", () => {
        clearTimeout(timer);
        resolve(null);
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        resolve(code === 0 ? output : null);
      });
    });
    helpCache.set(key, help);
  }
  const value = await help;
  const required =
    agent === "claude"
      ? ["--mcp-config", "--strict-mcp-config", "--allowedTools"]
      : ["--skip-git-repo-check", "--json", "--sandbox"];
  if (value !== null && required.some((arg) => !hasOption(value, arg)))
    throw new Error(
      `${agent === "claude" ? "Claude Code" : "Codex"} 版本太旧，缺少需要的功能。请在设置 · Agent 里更新。`,
    );
  return value;
}
function redact(text: string, token: string) {
  return text
    .replaceAll(token, "[redacted]")
    .replace(/((?:x-api-key|authorization|api[_-]?key)["']?\s*[:=]\s*["']?)(?:Bearer\s+)?[^\s,;"']+/gi, "$1[redacted]")
    .replace(/(Bearer\s+)[^\s,;"']+/gi, "$1[redacted]");
}
function failureMessage(agent: AgentKind, errors: string, code: number | null) {
  const name = agent === "claude" ? "Claude Code" : "Codex";
  if (/not logged in|login|unauthorized|401|invalid api key|authentication/i.test(errors))
    return `${name} 没有登录或登录过期。请在终端运行 ${agent === "claude" ? "claude" : "codex login"} 登录后再试。`;
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|ECONNRESET|timed out|network|stream disconnected|reconnecting/i.test(errors))
    return `${name} 连不上服务。请在设置 · 通用里检查网络代理。`;
  if (/unexpected argument|unknown option|unrecognized|unknown flag/i.test(errors))
    return `${name} 不认识庄Sir 传的参数，可能版本太旧。请在设置 · Agent 里更新。`;
  return `${name} 退出了（退出码 ${code}）。`;
}
function killTree(child: ChildProcess, signal: NodeJS.Signals) {
  if (process.platform === "win32" && child.pid) {
    spawnProgram("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }).on(
      "error",
      () => child.kill(signal),
    );
  } else if (child.pid) {
    try {
      process.kill(-child.pid, signal);
    } catch {
      child.kill(signal);
    }
  } else child.kill(signal);
}
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
      waitingPermission?: (chat: string) => boolean;
    },
  ) {}
  private async command(agent: AgentKind) {
    const path =
      this.options.commands?.[agent] ??
      (await findProgram(agent, this.options.directories, process.platform, this.options.proxy?.()));
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
      const command = await this.command(agent);
      let help: string | null;
      try {
        help = await agentHelp(agent, command, this.options.proxy?.() ?? "");
      } catch (error) {
        emit({ type: "user", text });
        emit({ type: "error", text: error instanceof Error ? error.message : String(error) });
        emit({ type: "end" });
        await this.writes;
        await rm(directory, { recursive: true, force: true });
        this.busy = false;
        return { id };
      }
      const args =
        agent === "claude"
          ? [
              "-p",
              "--input-format",
              "stream-json",
              "--output-format",
              "stream-json",
              "--verbose",
              ...(help === null || hasOption(help, "--include-partial-messages") ? ["--include-partial-messages"] : []),
              "--mcp-config",
              config,
              "--strict-mcp-config",
              "--allowedTools",
              "mcp__zsir-cut__*",
              ...(help === null || hasOption(help, "--tools") ? ["--tools", ""] : []),
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
              'approval_policy="never"',
              "-c",
              `mcp_servers.zsir-cut.url=${JSON.stringify(this.options.url)}`,
              "-c",
              'mcp_servers.zsir-cut.bearer_token_env_var="ZCUT_MCP_TOKEN"',
              "-c",
              'mcp_servers.zsir-cut.default_tools_approval_mode="approve"',
              ...(resume ? ["resume", resume] : []),
              ...(help === null ||
              /(?:stdin|standard input)[^\n]*`?-`?|`?-`?[^\n]*(?:stdin|standard input)/i.test(
                help.replace(/\r?\n[ \t]+/g, " "),
              )
                ? ["-"]
                : []),
            ];
      if (this.cancelRequested) throw new Error("已停止");
      const child = spawnProgram(command, args, {
        windowsHide: true,
        cwd: dirname(this.options.project),
        stdio: ["pipe", "pipe", "pipe"],
        detached: process.platform !== "win32",
        env: {
          ...proxyEnvironment(this.options.proxy?.()),
          PATH: hostPath(),
          ZCUT_MCP_TOKEN: this.options.token,
          ...codexEnvironment(command),
        },
      });
      let agentErrors = "";
      let lastAgentError: string | undefined;
      const parse = agentParser(agent, (event) => {
        if (event.type === "error" && event.text) {
          const text = event.text;
          agentErrors += `${text}\n`;
          if (text.startsWith("Reconnecting...")) {
            emit({ type: "log", text });
            return;
          }
          if (text === lastAgentError) return;
          lastAgentError = text;
          emit({ ...event, text });
          return;
        }
        if (event.type !== "end") emit(event);
      });
      const output = createInterface({ input: child.stdout });
      output.on("line", parse);
      let stderrText = "";
      let timedOut = false;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      let lastActivity = Date.now();
      let tick = lastActivity;
      const resetIdle = () => {
        lastActivity = Date.now();
      };
      const idleTimer = setInterval(() => {
        const now = Date.now();
        if (this.options.waitingPermission?.(id)) lastActivity += now - tick;
        tick = now;
        if (now - lastActivity >= 600000) {
          clearInterval(idleTimer);
          timedOut = true;
          killTree(child, "SIGTERM");
          killTimer = setTimeout(() => killTree(child, "SIGKILL"), 5000);
          killTimer.unref();
        }
      }, 1000);
      child.stdout.on("data", resetIdle);
      child.stderr.on("data", resetIdle);
      const stderr = createInterface({ input: child.stderr });
      stderr.on("line", (line) => {
        const safe = redact(line, this.options.token);
        stderrText = `${stderrText}${safe}\n`.slice(-2000);
        process.stderr.write(`${safe}\n`);
      });
      emit({ type: "user", text });
      const temp = directory;
      const done = new Promise<void>((resolve) => {
        child.once("error", (error) => emit({ type: "error", text: error.message }));
        child.once("close", (code, signal) => {
          void (async () => {
            try {
              parse.finish();
              clearInterval(idleTimer);
              if (killTimer && !timedOut) clearTimeout(killTimer);
              if (timedOut) emit({ type: "error", text: "Agent 10 分钟没有响应，已停止。" });
              else if (code !== 0 && !this.cancelRequested) {
                emit({ type: "error", text: failureMessage(agent, `${agentErrors}${stderrText}`, code) });
                const detail = stderrText
                  .split(/\r?\n/)
                  .filter((line) => line.trim())
                  .slice(-5)
                  .join("\n");
                if (detail) emit({ type: "error", text: detail });
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
      const command = await this.command(agent);
      const help = await agentHelp(agent, command, this.options.proxy?.() ?? "");
      if (signal.aborted) throw new Error("整理已停止");
      const args =
        agent === "claude"
          ? [
              "-p",
              "--output-format",
              "json",
              ...(help === null || hasOption(help, "--tools") ? ["--tools", ""] : []),
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
              "-c",
              'approval_policy="never"',
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
              ...(help === null || /(?:stdin|standard input)[^\n]*`?-`?|`?-`?[^\n]*(?:stdin|standard input)/i.test(help)
                ? ["-"]
                : []),
            ];
      const output = await new Promise<string>((resolve, reject) => {
        const child = spawnProgram(command, args, {
          windowsHide: true,
          cwd: directory,
          stdio: ["pipe", "pipe", "pipe"],
          detached: process.platform !== "win32",
          env: { ...proxyEnvironment(this.options.proxy?.()), PATH: hostPath(), ...codexEnvironment(command) },
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
        let idleTimer: ReturnType<typeof setTimeout>;
        let forceTimer: ReturnType<typeof setTimeout> | undefined;
        const resetIdle = () => {
          clearTimeout(idleTimer);
          idleTimer = setTimeout(() => {
            failure = new Error("Agent 10 分钟没有响应，已停止。");
            killTree(child, "SIGTERM");
            forceTimer = setTimeout(() => killTree(child, "SIGKILL"), 5000);
          }, 600000);
        };
        let stdout = "";
        let stderr = "";
        const stderrLines = createInterface({ input: child.stderr });
        stderrLines.on("line", (line) => {
          const safe = redact(line, this.options.token);
          stderr = `${stderr}${safe}\n`.slice(-2000);
          process.stderr.write(`${safe}\n`);
        });
        let failure: Error | undefined;
        resetIdle();
        const abort = () => {
          failure = new Error("字幕整理 Agent 已停止");
          kill();
        };
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
        child.stdout.on("data", (data: Buffer) => {
          resetIdle();
          if (stdout.length + data.length > 1024 * 1024) {
            failure = new Error("Agent 输出过大");
            kill();
          } else stdout += data.toString();
        });
        child.stderr.on("data", (data: Buffer) => {
          resetIdle();
          void data;
        });
        child.once("error", () => {
          failure = new Error("无法启动字幕整理 Agent");
        });
        child.once("close", (code) => {
          clearTimeout(idleTimer);
          if (forceTimer) clearTimeout(forceTimer);
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
    this.cancelRequested = true;
    killTree(active.child, "SIGTERM");
    const timer = setTimeout(() => killTree(active.child, "SIGKILL"), 1000);
    try {
      await active.done;
    } finally {
      clearTimeout(timer);
    }
  }
}
