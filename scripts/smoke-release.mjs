import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { cp, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { repository, run, runtime } from "./package-release.mjs";

const source = resolve(process.argv[2] ?? runtime);
const temporary = await realpath(await mkdtemp(join(tmpdir(), "zcut-release-smoke-")));
const root = join(temporary, "relocated-runtime");
let child;
let socket;
const signal = AbortSignal.timeout(30000);
try {
  // Relocate outside the repository so missing dependencies cannot resolve from the development node_modules.
  await cp(source, root, { recursive: true });
  run(
    join(root, process.platform === "win32" ? "node.exe" : "node"),
    [
      "--input-type=module",
      "-e",
      "import {createCanvas} from '@napi-rs/canvas'; if (createCanvas(1,1).width !== 1) process.exit(1)",
    ],
    root,
  );
  // Use a writable copy, never let the smoke modify a tracked fixture.
  const project = join(temporary, "test.zcut.json");
  await cp(join(repository, "examples/minimal.zcut.json"), project);
  const cwd = join(temporary, "unrelated working directory");
  await mkdir(cwd);
  child = spawn(
    join(root, process.platform === "win32" ? "node.exe" : "node"),
    [join(root, "packages/app-host/dist/index.js"), "--desktop", "--project", project],
    {
      cwd,
      env: {
        ...process.env,
        HOME: temporary,
        USERPROFILE: temporary,
        APPDATA: join(temporary, "AppData/Roaming"),
        LOCALAPPDATA: join(temporary, "AppData/Local"),
        ZCUT_PACKAGED: "1",
        PYTHONDONTWRITEBYTECODE: "1",
      },
      stdio: ["pipe", "pipe", "inherit"],
      windowsHide: true,
    },
  );
  const lines = createInterface({ input: child.stdout });
  const ready = await Promise.race([
    once(lines, "line", { signal }).then(([line]) => line),
    once(child, "exit", { signal }).then(([code]) => {
      throw new Error(`Host exited before ready (${code})`);
    }),
  ]);
  // Continue draining MCP output, as the window shell does.
  lines.on("line", () => {});
  const [port, token] = ready.trim().split(/\s+/);
  assert.match(port, /^\d+$/);
  assert.match(token, /^[a-f0-9]{64}$/);
  socket = new WebSocket(`ws://127.0.0.1:${port}/?token=${token}`);
  await once(socket, "open", { signal });
  const waitMessage = (matches) =>
    new Promise((resolve, reject) => {
      const cleanup = () => {
        socket.removeEventListener("message", message);
        socket.removeEventListener("error", fail);
        socket.removeEventListener("close", fail);
        signal.removeEventListener("abort", fail);
      };
      const fail = () => {
        cleanup();
        reject(new Error("Host connection closed or timed out"));
      };
      const message = (event) => {
        const value = JSON.parse(event.data);
        if (matches(value)) {
          cleanup();
          resolve(value);
        }
      };
      socket.addEventListener("message", message);
      socket.addEventListener("error", fail);
      socket.addEventListener("close", fail);
      signal.addEventListener("abort", fail, { once: true });
      if (signal.aborted) fail();
    });
  const bootstrap = waitMessage((message) => message.type === "bootstrap");
  socket.send(JSON.stringify({ type: "ui_ready" }));
  assert.equal((await bootstrap).type, "bootstrap");
  const result = waitMessage((message) => message.type === "result" && message.id === "smoke");
  socket.send(JSON.stringify({ id: "smoke", verb: "inspect", request: { project, view: "brief" } }));
  const { envelope } = await result;
  assert.equal(envelope.ok, true, JSON.stringify(envelope.error));
  assert.ok(envelope.result.project.id);
  console.log(`Packaged host WebSocket smoke passed: ${envelope.result.project.name}`);
} finally {
  socket?.close();
  if (child && child.exitCode === null) {
    child.stdin.end();
    const force = setTimeout(() => child.kill(), 3000);
    await once(child, "exit");
    clearTimeout(force);
  }
  await rm(temporary, { recursive: true, force: true });
}
