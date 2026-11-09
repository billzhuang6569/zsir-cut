import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AgentManagement, agentDirectories, findProgram, programVersion } from "../src/agent-management.js";
import { Agents } from "../src/agents.js";
import { DesktopPreferences } from "../src/preferences.js";

vi.setConfig({ testTimeout: 30000 });

const execPath = Object.getOwnPropertyDescriptor(process, "execPath");
const platform = Object.getOwnPropertyDescriptor(process, "platform");
let directory: string;
let root: string;
let npm: string;
let calls: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "zcut packaged agents "));
  root = join(directory, "runtime");
  npm = join(root, "npm/bin/npm-cli.js");
  calls = join(directory, "calls.jsonl");
  await mkdir(join(root, "npm/bin"), { recursive: true });
  const node = join(root, process.platform === "win32" ? "node.exe" : "node");
  if (process.platform === "win32") await cp(process.execPath, node);
  else await symlink(process.execPath, node);
  Object.defineProperty(process, "execPath", { value: node });
  vi.stubEnv("HOME", directory);
  vi.stubEnv("USERPROFILE", directory);
  vi.stubEnv("PATH", "");
  vi.stubEnv("ZCUT_PACKAGED", "1");
});
afterEach(async () => {
  if (execPath) Object.defineProperty(process, "execPath", execPath);
  if (platform) Object.defineProperty(process, "platform", platform);
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});
function manager(events: Record<string, unknown>[]) {
  return new AgentManagement(new DesktopPreferences(directory), (event) => events.push(event), {
    directories: [directory],
    registryUrl: "http://127.0.0.1:1",
  });
}
async function fakeNpm(mode: "success" | "fallback" | "fail") {
  await writeFile(
    npm,
    `
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify({args, script: process.argv[1], path: process.env.PATH}) + '\\n');
console.log(args.includes('--registry') ? 'mirror output' : 'default output');
process.exitCode = ${JSON.stringify(mode)} === 'fail' || (${JSON.stringify(mode)} === 'fallback' && !args.includes('--registry')) ? 1 : 0;
`,
  );
}
async function finished(events: Record<string, unknown>[]) {
  await vi.waitFor(() => expect(events.at(-1)?.type).toBe("agents_changed"), { timeout: 5000 });
  return (await readFile(calls, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}
it.each(["agents_install", "agents_update"])(
  "%s uses bundled Node/npm and a user prefix without system npm",
  async (verb) => {
    await fakeNpm("success");
    const events: Record<string, unknown>[] = [];
    const management = manager(events);
    expect((await management.list()).npm).toBe(npm);
    expect(await management.handle(verb, { id: "claude" })).toMatchObject({ status: "accepted" });
    const runs = await finished(events);
    expect(runs).toEqual([
      {
        args: ["install", "-g", "--prefix", join(directory, ".zsir-cut/agents"), "@anthropic-ai/claude-code"],
        script: npm,
        path: expect.stringContaining(root),
      },
    ]);
    expect(events.filter((event) => event.done)).toEqual([expect.objectContaining({ done: true, ok: true })]);
  },
);
it.each(["fallback", "fail"] as const)(
  "retries the mirror once (%s), keeps one job and sends one final result",
  async (mode) => {
    await fakeNpm(mode);
    const events: Record<string, unknown>[] = [];
    const management = manager(events);
    const accepted = await management.handle("agents_install", { id: "codex" });
    expect(accepted.status).toBe("accepted");
    expect(await management.handle("agents_update", { id: "claude" })).toMatchObject({
      status: "failed",
      error: { code: "E_IO", retryable: true },
    });
    const runs = await finished(events);
    expect(runs).toHaveLength(2);
    expect(runs[1].args).toEqual([...runs[0].args, "--registry", "https://registry.npmmirror.com"]);
    const output = events.filter((event) => event.type === "agents_output");
    expect(new Set(output.map((event) => event.job_id)).size).toBe(1);
    expect(output.map((event) => event.line ?? event.ok)).toEqual([
      "default output",
      expect.stringContaining("registry.npmmirror.com"),
      "mirror output",
      mode === "fallback",
    ]);
    // A completed retry releases the installation lock.
    events.length = 0;
    expect(await management.handle("agents_update", { id: "claude" })).toMatchObject({ status: "accepted" });
    await finished(events);
  },
);
it.skipIf(process.platform === "win32")(
  "finds installed Unix agents and runs env-node version, chat and subtitle commands with a Finder PATH",
  async () => {
    const bin = join(directory, ".zsir-cut/agents/bin");
    await mkdir(bin, { recursive: true });
    const claude = join(bin, "claude");
    await writeFile(
      claude,
      `#!/usr/bin/env node
if (process.argv.includes('--version')) console.log('1.2.3');
else {
  process.stdin.resume();
  process.stdin.on('end', () => console.log(JSON.stringify({type:'result', result:'tidied', is_error:false})));
}
`,
      { mode: 0o700 },
    );
    expect(agentDirectories()).toContain(bin);
    expect(await findProgram("claude")).toBe(claude);
    expect(await programVersion(claude)).toBe("1.2.3");
    const events: { type: string }[] = [];
    const agents = new Agents({
      project: join(directory, "project.zcut.json"),
      projectId: "prj_test",
      url: "http://unused.invalid",
      token: "unused",
      emit: (_chat, event) => events.push(event),
    });
    try {
      expect((await agents.detect())[0]).toMatchObject({ available: true, version: "1.2.3" });
      expect(await agents.subtitlePass("claude", "tidy", new AbortController().signal)).toBe("tidied");
      await agents.send("claude", "hello");
      await vi.waitFor(() => expect(events.at(-1)?.type).toBe("end"), { timeout: 5000 });
      expect(events.some((event) => event.type === "error")).toBe(false);
    } finally {
      await agents.stop();
    }
  },
);
it("adds the Windows prefix itself to discovery and finds installed cmd shims", async () => {
  Object.defineProperty(process, "platform", { value: "win32" });
  const prefix = join(directory, ".zsir-cut/agents");
  await mkdir(prefix, { recursive: true });
  await writeFile(join(prefix, "codex.cmd"), "shim", { mode: 0o700 });
  expect(agentDirectories()).toContain(prefix);
  expect(agentDirectories()).not.toContain(join(prefix, "bin"));
  expect(await findProgram("codex")).toBe(join(prefix, "codex.cmd"));
});
