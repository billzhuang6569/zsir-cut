import type { spawn as nodeSpawn } from "node:child_process";
import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import * as http from "node:http";
import * as https from "node:https";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { z } from "zod";
import type { AgentKind } from "./agent-events.js";
import type { DesktopPreferences } from "./preferences.js";
import { commonProgramDirectories } from "./runtime.js";

export const spawnProgram: typeof nodeSpawn = createRequire(import.meta.url)("cross-spawn");

const { newId }: typeof import("../../core/dist/index.js") = await import(
  new URL(import.meta.url.endsWith(".ts") ? "../../core/src/index.ts" : "../../core/dist/index.js", import.meta.url)
    .href
);

const programs = {
  claude: { name: "Claude Code", package: "@anthropic-ai/claude-code" },
  codex: { name: "Codex", package: "@openai/codex" },
};
export function agentDirectories() {
  return [
    ...(process.env.PATH ?? "").split(delimiter),
    ...commonProgramDirectories(),
    ...[".local/bin", ".npm-global/bin", ".claude/local"].map((path) => join(homedir(), path)),
  ];
}
export async function findProgram(name: string, directories = agentDirectories(), platform = process.platform) {
  for (const directory of directories) {
    for (const suffix of platform === "win32" ? [".exe", ".cmd", ""] : [""]) {
      const path = resolve(directory, `${name}${suffix}`);
      try {
        await access(path, constants.X_OK);
        if ((await stat(path)).isFile()) return path;
      } catch {}
    }
  }
  return null;
}
export async function programVersion(path: string | null) {
  if (!path) return null;
  try {
    const stdout = await new Promise<string>((resolve, reject) => {
      const child = spawnProgram(path, ["--version"], { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
      let output = "";
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error("Version check timed out"));
      }, 3000);
      child.stdout?.on("data", (chunk: Buffer) => {
        output += chunk.toString();
        if (Buffer.byteLength(output) > 65536) {
          child.kill("SIGKILL");
          reject(new Error("Version output too large"));
        }
      });
      child.once("error", reject);
      child.once("close", (code) => {
        clearTimeout(timer);
        if (code === 0) resolve(output);
        else reject(new Error("Version check failed"));
      });
    });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}
function newer(latest: string | null, version: string | null) {
  const a = latest?.match(/^(\d+)\.(\d+)\.(\d+)$/);
  const b = version?.match(/\b(\d+)\.(\d+)\.(\d+)\b/);
  if (!a || !b) return false;
  for (let i = 1; i <= 3; i++) {
    const left = BigInt(a[i] as string);
    const right = BigInt(b[i] as string);
    if (left !== right) return left > right;
  }
  return false;
}
export interface AgentManagementOptions {
  registryUrl?: string;
  directories?: string[];
}
export class AgentManagement {
  private cached:
    | Promise<{
        agents: {
          id: AgentKind;
          name: string;
          found: boolean;
          path: string | null;
          version: string | null;
          latest: string | null;
          update_available: boolean;
        }[];
        npm: string | null;
      }>
    | undefined;
  private checked = 0;
  private installing = false;
  constructor(
    private prefs: DesktopPreferences,
    private emit: (event: Record<string, unknown>) => void,
    private options: AgentManagementOptions = {},
  ) {}
  private async latest(name: string): Promise<string | null> {
    let agent: http.Agent | undefined;
    try {
      const url = new URL(
        `${name.replace("/", "%2f")}/latest`,
        `${this.options.registryUrl ?? "https://registry.npmjs.org"}/`,
      );
      const transport = url.protocol === "https:" ? https : http;
      agent = new transport.Agent({
        proxyEnv: { HTTPS_PROXY: process.env.HTTPS_PROXY, HTTP_PROXY: process.env.HTTPS_PROXY },
      });
      const value = await new Promise<string | null>((resolve) => {
        const request = transport.get(url, { agent, signal: AbortSignal.timeout(3000) }, (response) => {
          let body = "";
          response.setEncoding("utf8");
          response.on("data", (chunk: string) => {
            body += chunk;
            if (body.length > 65536) request.destroy(new Error("Registry response too large"));
          });
          response.on("error", () => resolve(null));
          response.on("end", () => {
            try {
              const data = JSON.parse(body);
              resolve(response.statusCode === 200 && typeof data.version === "string" ? data.version : null);
            } catch {
              resolve(null);
            }
          });
        });
        request.on("error", () => resolve(null));
      });
      return value;
    } catch {
      return null;
    } finally {
      agent?.destroy();
    }
  }
  async list(refresh = false) {
    if (refresh || !this.cached || Date.now() - this.checked >= 24 * 60 * 60 * 1000) {
      this.checked = Date.now();
      this.cached = (async () => {
        const [agents, npm] = await Promise.all([
          Promise.all(
            (Object.keys(programs) as AgentKind[]).map(async (id) => {
              const [local, latest] = await Promise.all([
                findProgram(id, this.options.directories).then(async (path) => ({
                  path,
                  version: await programVersion(path),
                })),
                this.latest(programs[id].package),
              ]);
              const { path, version } = local;
              return {
                id,
                name: programs[id].name,
                found: path !== null,
                path,
                version,
                latest,
                update_available: newer(latest, version),
              };
            }),
          ),
          findProgram("npm", this.options.directories),
        ]);
        return { agents, npm };
      })();
    }
    const result = await this.cached;
    const selected = this.prefs.get().prefs.default_agent ?? result.agents.find((agent) => agent.found)?.id;
    return { ...result, agents: result.agents.map((agent) => ({ ...agent, default: agent.id === selected })) };
  }
  async handle(verb: string, input: unknown) {
    const base = { verb, request_id: newId("req_"), changes: [] };
    try {
      let reply: { status: string; result: unknown };
      if (verb === "agents_list") {
        const request = z.strictObject({ refresh: z.boolean().optional() }).parse(input);
        reply = { status: "no_op", result: await this.list(request.refresh) };
      } else {
        const { id } = z.strictObject({ id: z.enum(["claude", "codex"]) }).parse(input);
        if (verb === "agents_set_default") {
          await this.prefs.set({ default_agent: id });
          reply = { status: "applied", result: {} };
        } else {
          if (this.installing) return this.failure(base, "failed", "E_IO", "安装任务正在运行", true);
          this.installing = true;
          let started = false;
          try {
            const npm = await findProgram("npm", this.options.directories);
            if (!npm)
              return this.failure(base, "rejected", "E_UNSUPPORTED", "没有找到 npm", false, {
                manual: `请安装 Node.js（含 npm），然后在终端运行 npm install -g ${programs[id].package}`,
              });
            const job_id = newId("job_");
            const child = spawnProgram(npm, ["install", "-g", programs[id].package], {
              windowsHide: true,
              stdio: ["ignore", "pipe", "pipe"],
            });
            for (const stream of ["stdout", "stderr"] as const) {
              createInterface({ input: child[stream] }).on("line", (line) =>
                this.emit({ type: "agents_output", job_id, line, stream }),
              );
            }
            child.once("error", (error) =>
              this.emit({ type: "agents_output", job_id, line: error.message, stream: "stderr" }),
            );
            child.once("close", (code) => {
              this.installing = false;
              this.emit({ type: "agents_output", job_id, done: true, ok: code === 0 });
              void this.list(true).then((result) => this.emit({ type: "agents_changed", ...result }));
            });
            started = true;
            reply = { status: "accepted", result: { job_id } };
          } finally {
            if (!started) this.installing = false;
          }
        }
      }
      return { ...base, ok: true, ...reply, verification: { level: "none", passed: true, issues: [] }, error: null };
    } catch (error) {
      return this.failure(
        base,
        error instanceof z.ZodError ? "rejected" : "failed",
        error instanceof z.ZodError ? "E_VALIDATION" : "E_IO",
        String(error),
        false,
      );
    }
  }
  private failure(base: object, status: string, code: string, message: string, retryable: boolean, details?: object) {
    return {
      ...base,
      ok: false,
      status,
      result: null,
      verification: { level: "none", passed: false, issues: [] },
      error: { code, message, retryable, ...(details ? { details } : {}) },
    };
  }
}
