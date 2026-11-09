import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { repository, run, runtime } from "./package-release.mjs";

const source = resolve(process.argv[2] ?? runtime);
const temporary = await realpath(await mkdtemp(join(tmpdir(), "zcut-release-smoke-")));
const root = join(temporary, "relocated-runtime");
let child;
let socket;
try {
  // Relocate outside the repository so missing dependencies cannot resolve from the development node_modules.
  await cp(source, root, { recursive: true, verbatimSymlinks: true });
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
  const env = {
    ...process.env,
    HOME: temporary,
    USERPROFILE: temporary,
    APPDATA: join(temporary, "AppData/Roaming"),
    LOCALAPPDATA: join(temporary, "AppData/Local"),
    PATH: [join(root, "bin"), process.env.PATH].filter(Boolean).join(delimiter),
    ZCUT_PACKAGED: "1",
    PYTHONDONTWRITEBYTECODE: "1",
    PYTHONPATH: join(root, "workers/asr"),
  };
  // Generate PCM without any system media tools, then convert and probe with the bundled executables.
  const pcm = join(temporary, "tone.s16le");
  const samples = Buffer.alloc(4800 * 2);
  for (let i = 0; i < 4800; i++) samples.writeInt16LE(i % 48 < 24 ? 1000 : -1000, i * 2);
  await writeFile(pcm, samples);
  const wav = join(temporary, "tone.wav");
  run(
    join(root, "bin", process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg"),
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-nostdin",
      "-f",
      "s16le",
      "-ar",
      "48000",
      "-ac",
      "1",
      "-i",
      pcm,
      "-ar",
      "16000",
      wav,
    ],
    cwd,
    env,
  );
  const audio = await readFile(wav);
  assert.equal(audio.toString("ascii", 0, 4), "RIFF");
  assert.ok(audio.length > 3200);
  run(
    join(root, "bin", process.platform === "win32" ? "ffprobe.exe" : "ffprobe"),
    ["-v", "error", "-show_streams", wav],
    cwd,
    env,
  );
  console.log("Bundled ffmpeg audio conversion smoke passed");
  if (process.platform === "darwin") {
    const python = join(root, "python/bin/python3");
    run(python, ["-c", "import mlx, mlx_audio"], cwd, env);
    const probe = join(temporary, "asr-probe.json");
    run(python, ["-m", "zsir_asr", "probe", "--out", probe], cwd, env);
    assert.equal(JSON.parse(await readFile(probe, "utf8")).mlx_available, true);
    console.log("Bundled Python MLX imports and ASR probe smoke passed");
  }
  const signal = AbortSignal.timeout(30000);
  child = spawn(
    join(root, process.platform === "win32" ? "node.exe" : "node"),
    [join(root, "packages/app-host/dist/index.js"), "--desktop", "--project", project],
    {
      cwd,
      env,
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
  const result = waitMessage((message) => message.id === "smoke");
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
