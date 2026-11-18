#!/usr/bin/env node
// Agent 评测：见 README.md。
import { spawn, execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cases, sec } from "./cases.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const args = Object.fromEntries(
  process.argv.slice(2).reduce((a, v, i, all) => (v.startsWith("--") ? [...a, [v.slice(2), all[i + 1]]] : a), []),
);
if (!args.project) throw new Error("需要 --project <起始工程>");
const agent = args.agent ?? "claude";
const only = args.only ? new Set(args.only.split(",")) : null;
const out = resolve(args.out ?? mkdtempSync(join(tmpdir(), "zcut-evals-")));
mkdirSync(out, { recursive: true });

const cli = (verb, project, request) => {
  const file = join(dirname(project), `.req-${verb}-${Date.now()}.json`);
  writeFileSync(file, JSON.stringify(request));
  try {
    return JSON.parse(execFileSync("node", [join(repo, "packages/cli/src/index.ts"), verb, project, "--input", file], { encoding: "utf8", maxBuffer: 64 << 20 }));
  } catch (e) {
    return JSON.parse(e.stdout);
  }
};
const tc = (s, rate = 25) => {
  const f = Math.round(s * rate);
  const p = (n) => String(n).padStart(2, "0");
  return `${p(Math.floor(f / rate / 3600))}:${p(Math.floor(f / rate / 60) % 60)}:${p(Math.floor(f / rate) % 60)}:${p(f % rate)}`;
};

function context(project, brief, ui) {
  const tl = brief.result.timelines[0];
  const p = JSON.parse(readFileSync(project, "utf8"));
  const tracks = p.timelines[0].tracks;
  const media = Object.fromEntries(p.media.map((m) => [m.id, m.name]));
  const sel = (ui.select ?? []).map((id) => {
    for (const t of tracks) for (const c of t.clips ?? []) if (c.id === id) {
      const a = sec(c.timeline_start), b = a + sec(c.duration);
      return `片段 ${id}（${t.name}，${tc(a)}–${tc(b)}，素材「${media[c.media_id] ?? c.media_id}」）`;
    }
    return id;
  });
  return [
    "<界面>",
    `工程：${brief.result.project.name}，路径 ${project}，修订 ${brief.result.project.revision.id}（第 ${brief.result.project.revision.seq} 步），时间线 ${tl.id}，总长 ${tl.duration.tc}`,
    `播放头：${ui.playhead ? `${tc(sec(ui.playhead))}（${ui.playhead}）` : "00:00:00:00（0s）"}`,
    `入出点：${ui.range ? `${tc(sec(ui.range[0]))}–${tc(sec(ui.range[1]))}（${ui.range[0]}–${ui.range[1]}）` : "无"}`,
    `选中：${sel.length ? sel.join("；") : "无"}`,
    "正在看：AI",
    `待你决定：0 条`,
    "</界面>",
  ].join("\n");
}

function runAgent(dir, prompt, message) {
  const mcp = join(repo, "packages/mcp/src/index.ts");
  const env = { ...process.env, HTTPS_PROXY: process.env.HTTPS_PROXY ?? "http://127.0.0.1:7897" };
  let cmd, argv, stdin = "";
  if (agent === "claude") {
    const cfg = join(dir, "mcp.json");
    writeFileSync(cfg, JSON.stringify({ mcpServers: { "zsir-cut": { type: "stdio", command: "node", args: [mcp] } } }));
    const sp = join(dir, "prompt.md");
    writeFileSync(sp, prompt);
    cmd = "claude";
    argv = ["-p", message, "--output-format", "stream-json", "--verbose", "--mcp-config", cfg, "--strict-mcp-config", "--allowedTools", "mcp__zsir-cut__*", "--tools", "", "--append-system-prompt-file", sp];
  } else {
    cmd = "codex";
    argv = ["exec", "--json", "--skip-git-repo-check", "--sandbox", "read-only", "-c", 'approval_policy="never"', "-c", 'mcp_servers.zsir-cut.command="node"', "-c", `mcp_servers.zsir-cut.args=${JSON.stringify([mcp])}`, "-c", 'mcp_servers.zsir-cut.default_tools_approval_mode="approve"', "-"];
    stdin = `${prompt}\n\n${message}\n`;
  }
  return new Promise((done) => {
    const child = spawn(cmd, argv, { cwd: dir, env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    const timer = setTimeout(() => child.kill("SIGKILL"), 15 * 60 * 1000);
    child.stdin.end(stdin);
    child.on("close", (code) => {
      clearTimeout(timer);
      writeFileSync(join(dir, "events.jsonl"), stdout);
      writeFileSync(join(dir, "stderr.txt"), stderr);
      let reply = "";
      for (const line of stdout.split("\n")) {
        try {
          const e = JSON.parse(line);
          if (e.type === "result" && typeof e.result === "string") reply = e.result;
          if (e.type === "item.completed" && e.item?.type === "agent_message") reply = e.item.text;
        } catch {}
      }
      done({ code, reply });
    });
  });
}

const rules = readFileSync(join(repo, "skills/zsir-cut/rules.md"), "utf8");
const desktop = readFileSync(join(repo, "skills/zsir-cut/desktop.md"), "utf8");
const prompt = `${rules}\n\n${desktop}\n\n评测环境：没有桌面界面，zcut_ui_* 工具不可用。所有输出用中文。`;
const rows = [];
for (const c of cases) {
  if (only && !only.has(c.id)) continue;
  const dir = join(out, `${c.id}-${c.category}`);
  mkdirSync(dir, { recursive: true });
  const project = join(dir, "p.zcut.json");
  const start = JSON.parse(readFileSync(args.project, "utf8"));
  const ui = c.setup?.(start) ?? {};
  writeFileSync(project, JSON.stringify(start, null, 2));
  const before = cli("inspect", project, { view: "brief" });
  const clipsBefore = start.timelines[0].tracks[0].clips;
  const startSeq = before.result.project.revision.seq;
  const message = `${context(project, before, ui)}\n用户消息：${c.message}`;
  const t0 = Date.now();
  const { code, reply } = await runAgent(dir, prompt, message);
  const after = cli("inspect", project, { view: "brief" });
  const history = (cli("inspect", project, { view: "history" }).result?.entries ?? cli("inspect", project, { view: "history" }).result?.history ?? []).filter((h) => (h.seq ?? h.revision?.seq ?? 0) > startSeq);
  const decisionsEnv = cli("inspect", project, { view: "decisions", all: true });
  const decisions = decisionsEnv.result?.decisions ?? [];
  const sessions = (after.result.sessions ?? []);
  const sessionDir = join(dir, ".zcut", start.id, "sessions");
  const allSessions = existsSync(sessionDir) ? execFileSync("ls", [sessionDir], { encoding: "utf8" }).split("\n").filter(Boolean).map((s) => JSON.parse(readFileSync(join(sessionDir, s, "session.json"), "utf8"))) : sessions;
  const pAfter = JSON.parse(readFileSync(project, "utf8"));
  const ctx = {
    before, after, history, decisions, sessions: allSessions, reply,
    clipsBefore, clipsAfter: pAfter.timelines[0].tracks[0].clips,
    durBefore: sec(before.result.timelines[0].duration.t), durAfter: sec(after.result.timelines[0].duration.t),
  };
  const fails = code === 0 ? c.check(ctx, ui) : [`Agent 退出码 ${code}`];
  writeFileSync(join(dir, "reply.md"), reply);
  rows.push({ id: c.id, category: c.category, pass: fails.length === 0, fails, seconds: Math.round((Date.now() - t0) / 1000), writes: history.length, decisions: decisions.length });
  console.log(`${fails.length ? "FAIL" : "PASS"} ${c.id} ${c.category}  ${fails.join("；")}  (${rows.at(-1).seconds}s, 写入 ${history.length}, 决定 ${decisions.length})`);
}
writeFileSync(join(out, "summary.json"), JSON.stringify({ agent, rows }, null, 2));
const pass = rows.filter((r) => r.pass).length;
console.log(`\n${agent}: ${pass}/${rows.length} 通过，结果在 ${out}`);
