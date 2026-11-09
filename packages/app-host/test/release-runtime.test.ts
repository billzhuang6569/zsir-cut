import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { findProgram, programVersion, spawnProgram } from "../src/agent-management.js";
import { readFcpIcon } from "../src/index.js";
import { commonProgramDirectories, hostPath } from "../src/runtime.js";

let directory: string;
const platform = Object.getOwnPropertyDescriptor(process, "platform");
afterEach(async () => {
  if (platform) Object.defineProperty(process, "platform", platform);
  if (directory) await rm(directory, { recursive: true, force: true });
});
it("prepends common directories, uses platform delimiters and preserves inherited PATH", () => {
  expect(hostPath({ PATH: "/bin:/opt/homebrew/bin" }, "darwin")).toBe("/opt/homebrew/bin:/usr/local/bin:/bin");
  const env = { LOCALAPPDATA: "C:\\Users\\Editor Name\\AppData\\Local", PATH: "C:\\Windows;D:\\Agent" };
  const dirs = commonProgramDirectories("win32", env);
  expect(dirs).toEqual([win32.join(env.LOCALAPPDATA, "Microsoft/WinGet/Links"), "C:\\ProgramData\\chocolatey\\bin"]);
  expect(hostPath(env, "win32")).toBe(`${dirs.join(";")};${env.PATH}`);
  expect(hostPath({ PATH: "" }, "darwin")).not.toContain("::");
  expect(hostPath({ PATH: "/app/runtime/bin:/bin", ZCUT_PACKAGED: "1" }, "darwin", "/app/runtime/node")).toBe(
    "/app/runtime/bin:/app/runtime:/opt/homebrew/bin:/usr/local/bin:/bin",
  );
  expect(
    hostPath(
      { ...env, PATH: `D:\\App\\runtime\\bin;${env.PATH}`, ZCUT_PACKAGED: "1" },
      "win32",
      "D:\\App\\runtime\\node.exe",
    ),
  ).toBe(`D:\\App\\runtime\\bin;D:\\App\\runtime;${dirs.join(";")};${env.PATH}`);
});
it("finds Windows exe and cmd, respects directory order and ignores directories", async () => {
  directory = await mkdtemp(join(tmpdir(), "zcut-program-"));
  const fallback = join(directory, "fallback");
  await mkdir(fallback);
  await writeFile(join(directory, "codex.cmd"), "shim", { mode: 0o700 });
  await writeFile(join(fallback, "codex.exe"), "binary", { mode: 0o700 });
  await mkdir(join(directory, "claude.exe"));
  expect(await findProgram("codex", [directory, fallback], "win32")).toBe(join(directory, "codex.cmd"));
  expect(await findProgram("codex", [fallback], "win32")).toBe(join(fallback, "codex.exe"));
  expect(await findProgram("claude", [directory], "win32")).toBeNull();
  expect(await findProgram("codex", [directory], "darwin")).toBeNull();
});
it("returns the default FCP icon on Windows without invoking Mac utilities", async () => {
  Object.defineProperty(process, "platform", { value: "win32" });
  expect(await readFcpIcon()).toBeNull();
});
it("starts the desktop host through a symlink directory and announces its port and token", async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), "zcut-host-entry-")));
  const linked = join(directory, "linked-repository");
  await symlink(fileURLToPath(new URL("../../../", import.meta.url)), linked, "junction");
  const child = spawn(process.execPath, [join(linked, "packages/app-host/dist/index.js"), "--desktop"], {
    cwd: directory,
    env: { ...process.env, HOME: directory, USERPROFILE: directory, APPDATA: directory, LOCALAPPDATA: directory },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const lines = createInterface({ input: child.stdout });
  const exited = once(child, "exit");
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  try {
    const [line] = await Promise.race([
      once(lines, "line", { signal: AbortSignal.timeout(3000) }),
      exited.then(([code]) => {
        throw new Error(`Host exited before ready (${code}): ${stderr}`);
      }),
    ]);
    expect(line).toMatch(/^\d+ [a-f0-9]{64}$/);
  } finally {
    lines.close();
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await exited;
  }
});
it.skipIf(process.platform !== "win32")(
  "launches cmd shims with spaces and metacharacters as literal arguments",
  async () => {
    directory = await mkdtemp(join(tmpdir(), "zcut cmd "));
    const script = join(directory, "echo.cjs");
    const shim = join(directory, "echo.cmd");
    await writeFile(script, "console.log(JSON.stringify(process.argv.slice(2)))");
    await writeFile(shim, `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`);
    const args = ["a b", "a&b", 'say "hi"', "(test)", "100%", "^caret"];
    const child = spawnProgram(shim, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
    });
    await new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => (code === 0 ? resolve() : reject(new Error(`cmd exit ${code}`))));
    });
    expect(JSON.parse(stdout)).toEqual(args);
    expect(await programVersion(shim)).toBe('["--version"]');
  },
);
