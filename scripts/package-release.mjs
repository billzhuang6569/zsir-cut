import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import {
  access,
  chmod,
  cp,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import * as https from "node:https";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

export const repository = fileURLToPath(new URL("../", import.meta.url));
export const runtime = join(repository, "apps/desktop-tauri/src-tauri/runtime");
const packages = ["core", "exporters", "cli", "mcp", "app-host"];
export const releaseAssets = {
  ffmpeg: {
    url: "https://ffmpeg.martin-riedl.de/download/macos/arm64/1789931890_9.0.2/ffmpeg.zip",
    sha256: "c8ed4c4e6978a03c485edbfe4e0a5dc2380f8a30bba5150531b31b094492d924",
  },
  ffprobe: {
    url: "https://ffmpeg.martin-riedl.de/download/macos/arm64/1789931890_9.0.2/ffprobe.zip",
    sha256: "fcbe839537485eaee7a7a8bc5cbc0f90d53617e80943e8a5b2e31cb851197ea6",
  },
  windowsFfmpeg: {
    url: "https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-11-08-12-35/ffmpeg-n9.0.2-48-gd4070a14ce-win64-gpl-9.0.zip",
    sha256: "40608cfdd40b0e7929704059daee4af369f7a9984ea7aa8ee416d78cce2e8aae",
  },
  python: {
    url: "https://github.com/astral-sh/python-build-standalone/releases/download/20261026/cpython-3.13.18%2B20261026-aarch64-apple-darwin-install_only_stripped.tar.gz",
    sha256: "8392b6ea51d94391befb2c31ebe75463f045d0b69dfcf5e1bb3234e1f5fa3405",
  },
};
export function run(command, args, cwd = repository, env = process.env) {
  const result = spawnSync(command, args, { cwd, env, stdio: "inherit", windowsHide: true });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${command} failed (${result.status})`);
}
export function releaseFilter(path) {
  return (
    !["node_modules", "test", "tests", "__tests__", ".venv", "__pycache__"].includes(basename(path)) &&
    !/\.(?:map|pyc|tsbuildinfo)$/.test(path)
  );
}
async function resolvePackage(name, consumer) {
  const require = createRequire(join(consumer, "package.json"));
  for (const path of require.resolve.paths(name) ?? []) {
    try {
      const source = await realpath(join(path, name));
      await readFile(join(source, "package.json"));
      return source;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  return null;
}
export async function copyProductionDependencies(consumers, destination) {
  const hoisted = new Map();
  const copied = new Set();
  async function dependencies(consumer, target) {
    const manifest = JSON.parse(await readFile(join(consumer, "package.json"), "utf8"));
    const optional = manifest.optionalDependencies ?? {};
    for (const name of Object.keys({ ...manifest.dependencies, ...optional }).sort()) {
      const source = await resolvePackage(name, consumer);
      if (!source) {
        assert.ok(Object.hasOwn(optional, name), `Missing production dependency: ${name}`);
        continue;
      }
      const previous = hoisted.get(name);
      const output = join(previous && previous !== source ? join(target, "node_modules") : destination, name);
      if (!previous) hoisted.set(name, source);
      if (copied.has(output)) continue;
      copied.add(output);
      await cp(source, output, { recursive: true, filter: releaseFilter, dereference: true });
      await dependencies(source, output);
    }
  }
  for (const consumer of consumers) await dependencies(consumer, dirname(destination));
}
export async function download(url, file, redirects = 0) {
  const agent = new https.Agent({ proxyEnv: { HTTPS_PROXY: process.env.HTTPS_PROXY } });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error(`Download stalled for 60 seconds: ${url}`)), 60_000);
  try {
    const response = await new Promise((resolve, reject) => {
      const request = https.get(url, { agent, signal: controller.signal }, resolve);
      request.on("error", reject);
    });
    if ([301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location && redirects < 5) {
      clearTimeout(timeout);
      response.resume();
      return await download(new URL(response.headers.location, url).href, file, redirects + 1);
    }
    if (response.statusCode !== 200) {
      response.resume();
      throw new Error(`Download failed: ${url} (${response.statusCode})`);
    }
    response.on("data", () => timeout.refresh());
    await pipeline(response, createWriteStream(file), { signal: controller.signal });
  } finally {
    clearTimeout(timeout);
    agent.destroy();
  }
}
export async function verifyArchive(file, expected) {
  assert.match(expected, /^[a-f0-9]{64}$/);
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  assert.equal(hash.digest("hex"), expected, "Archive checksum mismatch");
}
export async function cachedDownload(asset, cache = join(repository, ".tmp/release-cache"), fetch = download) {
  await mkdir(cache, { recursive: true });
  const key = asset.sha256 ?? createHash("sha256").update(asset.url).digest("hex");
  const file = join(cache, `${key}-${basename(new URL(asset.url).pathname)}`);
  try {
    if (asset.sha256) await verifyArchive(file, asset.sha256);
    else await access(file);
    return file;
  } catch (error) {
    if (error.code !== "ENOENT" && error.code !== "ERR_ASSERTION") throw error;
  }
  await rm(file, { force: true });
  const temporary = `${file}.partial`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await fetch(asset.url, temporary);
      if (asset.sha256) await verifyArchive(temporary, asset.sha256);
      await rename(temporary, file);
      return file;
    } catch (error) {
      if (attempt === 1) throw error;
    } finally {
      await rm(temporary, { force: true });
    }
  }
}
function unzip(file, destination) {
  if (process.platform === "win32") {
    run("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `$ProgressPreference='SilentlyContinue'; $ErrorActionPreference='Stop'; Expand-Archive -LiteralPath '${file.replaceAll("'", "''")}' -DestinationPath '${destination.replaceAll("'", "''")}'`,
    ]);
  } else run("unzip", ["-q", file, "-d", destination]);
}
export async function copyFfmpeg(destination) {
  const bin = join(destination, "bin");
  await mkdir(bin, { recursive: true });
  const temporary = await mkdtemp(join(tmpdir(), "zcut-ffmpeg-"));
  try {
    const windows = process.platform === "win32";
    for (const name of windows ? ["windowsFfmpeg"] : ["ffmpeg", "ffprobe"]) {
      const extracted = join(temporary, name);
      unzip(await cachedDownload(releaseAssets[name]), extracted);
      const files = await readdir(extracted, { recursive: true, withFileTypes: true });
      for (const binary of windows ? ["ffmpeg.exe", "ffprobe.exe", "LICENSE.txt"] : [name]) {
        const matches = files.filter((entry) => entry.isFile() && entry.name === binary);
        assert.equal(matches.length, 1, `Expected one ${binary} in ${name}`);
        const target = join(
          binary === "LICENSE.txt" ? destination : bin,
          binary === "LICENSE.txt" ? "FFMPEG-UPSTREAM-LICENSE.txt" : binary,
        );
        await cp(join(matches[0].parentPath, binary), target);
        if (!windows) await chmod(target, 0o755);
      }
    }
    await cp(join(repository, "scripts/licenses/GPL-3.0.txt"), join(destination, "FFMPEG-GPL-3.0.txt"));
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
export async function prunePython(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (!releaseFilter(path) || /^(?:pip(?:[\d.]*)?|pip-.*\.dist-info|ensurepip)$/.test(entry.name)) {
      await rm(path, { recursive: true, force: true });
    } else if (entry.isDirectory()) await prunePython(path);
  }
}
export async function installPythonRequirements(python, directory, env) {
  const lock = join(repository, "workers/asr/requirements.lock");
  const jieba = (await readFile(lock, "utf8")).split(/\r?\n/).find((line) => line.startsWith("jieba=="));
  assert.ok(jieba, "Missing pinned jieba requirement");
  const wheels = join(directory, "wheels");
  // jieba ships only source; build its pure-Python wheel before enforcing the macOS 14 binary floor.
  run(python, ["-m", "pip", "wheel", "--no-cache-dir", "--no-deps", "--wheel-dir", wheels, jieba], directory, env);
  run(
    python,
    [
      "-m",
      "pip",
      "download",
      "--no-cache-dir",
      "--platform",
      "macosx_14_0_arm64",
      "--only-binary=:all:",
      "--find-links",
      wheels,
      "--dest",
      wheels,
      "-r",
      lock,
    ],
    directory,
    env,
  );
  run(
    python,
    ["-m", "pip", "install", "--no-index", "--find-links", wheels, "--only-binary=:all:", "--no-compile", "-r", lock],
    directory,
    env,
  );
}
async function copyPython(destination) {
  const temporary = await mkdtemp(join(tmpdir(), "zcut-python-"));
  try {
    run("tar", ["-xzf", await cachedDownload(releaseAssets.python), "-C", temporary]);
    const output = join(destination, "python");
    await cp(join(temporary, "python"), output, { recursive: true, filter: releaseFilter, verbatimSymlinks: true });
    const python = join(output, "bin/python3");
    const env = { ...process.env, PYTHONDONTWRITEBYTECODE: "1", PIP_DISABLE_PIP_VERSION_CHECK: "1" };
    await installPythonRequirements(python, temporary, env);
    // Keep installed distribution metadata and upstream license files when removing development payloads.
    run(
      python,
      [
        "-c",
        `import importlib.metadata as m, json, pathlib, sys
pathlib.Path(sys.argv[1]).write_text(json.dumps([
  {"name": d.metadata["Name"], "version": d.version,
   "license": d.metadata.get("License-Expression") or d.metadata.get("License"),
   "classifiers": d.metadata.get_all("Classifier", [])}
  for d in sorted(m.distributions(), key=lambda d: d.metadata["Name"].lower())
  if d.metadata["Name"].lower() != "pip"], indent=2) + "\\n")`,
        join(destination, "PYTHON-PACKAGES.json"),
      ],
      temporary,
      env,
    );
    await prunePython(output);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
export function isMachO(header) {
  return (
    header.length >= 4 &&
    ["feedface", "cefaedfe", "feedfacf", "cffaedfe", "cafebabe", "bebafeca", "cafebabf", "bfbafeca"].includes(
      header.subarray(0, 4).toString("hex"),
    )
  );
}
export async function checkMacRuntime(
  directory,
  inspect = (path) => spawnSync("otool", ["-l", path], { encoding: "utf8" }),
) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await checkMacRuntime(path, inspect);
    else if (entry.isFile()) {
      const file = await open(path, "r");
      const header = Buffer.alloc(4);
      try {
        await file.read(header, 0, 4, 0);
      } finally {
        await file.close();
      }
      if (!isMachO(header)) continue;
      const result = inspect(path);
      if (result.error) throw result.error;
      assert.equal(result.status, 0, `otool failed for ${path}: ${result.stderr}`);
      let command;
      const versions = [];
      for (const line of result.stdout.split(/\r?\n/)) {
        const cmd = line.match(/^\s*cmd (LC_\w+)/);
        if (cmd) command = cmd[1];
        const version =
          command === "LC_BUILD_VERSION"
            ? line.match(/^\s*minos (\d+(?:\.\d+){0,2})\s*$/)
            : command === "LC_VERSION_MIN_MACOSX"
              ? line.match(/^\s*version (\d+(?:\.\d+){0,2})\s*$/)
              : null;
        if (version) versions.push(version[1]);
      }
      assert.ok(versions.length, `Missing macOS deployment target: ${path}`);
      for (const version of versions) {
        const [major, ...rest] = version.split(".").map(Number);
        assert.ok(
          major < 14 || (major === 14 && rest.every((part) => part === 0)),
          `${path} requires macOS ${version}, above 14.0`,
        );
      }
    }
  }
}
export async function signMacRuntime(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await signMacRuntime(path);
    else if (entry.isFile()) {
      const file = await open(path, "r");
      const header = Buffer.alloc(4);
      try {
        await file.read(header, 0, 4, 0);
      } finally {
        await file.close();
      }
      if (isMachO(header)) {
        run("codesign", ["--force", "--sign", "-", path]);
        run("codesign", ["--verify", "--strict", path]);
      }
    }
  }
}
export function nodeArchiveChecksum(checksums, filename) {
  const expected = checksums
    .split(/\r?\n/)
    .find((line) => line.endsWith(`  ${filename}`))
    ?.split(/\s+/)[0];
  assert.match(expected ?? "", /^[a-f0-9]{64}$/, `Missing official checksum for ${filename}`);
  return expected;
}
export async function cachedNodeArchive(base, filename, cache, fetch = download) {
  const sums = await cachedDownload({ url: `${base}SHASUMS256.txt` }, cache, fetch);
  const sha256 = nodeArchiveChecksum(await readFile(sums, "utf8"), filename);
  return cachedDownload({ url: `${base}${filename}`, sha256 }, cache, fetch);
}
export async function copyNodeDistribution(source, destination, platform = process.platform) {
  const windows = platform === "win32";
  await cp(join(source, windows ? "node.exe" : "bin/node"), join(destination, windows ? "node.exe" : "node"));
  await cp(join(source, "LICENSE"), join(destination, "NODE-LICENSE.txt"));
  const npm = join(source, windows ? "node_modules/npm" : "lib/node_modules/npm");
  await cp(npm, join(destination, "npm"), {
    recursive: true,
    verbatimSymlinks: true,
    filter: (path) => !["docs", "man", "test", "tests", "__tests__"].includes(basename(path)),
  });
  await cp(join(npm, "LICENSE"), join(destination, "NPM-LICENSE.txt"));
}
async function copyNode(destination) {
  const folder = `node-${process.version}-${process.platform === "darwin" ? "darwin-arm64" : "win-x64"}`;
  const filename = `${folder}.${process.platform === "win32" ? "zip" : "tar.gz"}`;
  const base = `https://nodejs.org/dist/${process.version}/`;
  const file = await cachedNodeArchive(base, filename);
  const temporary = await mkdtemp(join(tmpdir(), "zcut-node-"));
  try {
    if (process.platform === "win32") {
      run("powershell.exe", [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `$ProgressPreference='SilentlyContinue'; $ErrorActionPreference='Stop'; Expand-Archive -LiteralPath '${file.replaceAll("'", "''")}' -DestinationPath '${temporary.replaceAll("'", "''")}'`,
      ]);
    } else
      run("tar", [
        "-xzf",
        file,
        "-C",
        temporary,
        `${folder}/bin/node`,
        `${folder}/LICENSE`,
        `${folder}/lib/node_modules/npm`,
      ]);
    await copyNodeDistribution(join(temporary, folder), destination);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
export async function packageRelease() {
  assert.ok(
    (process.platform === "darwin" && process.arch === "arm64") ||
      (process.platform === "win32" && process.arch === "x64"),
    "Release supports only macOS arm64 and Windows x64",
  );
  assert.equal(process.versions.node.split(".")[0], "24", "Build with Node 24");
  assert.ok(process.env.npm_execpath, "Run via pnpm --filter @zsir-cut/desktop-tauri build");
  const pnpm = (args) =>
    /\.[cm]?js$/.test(process.env.npm_execpath)
      ? run(process.execPath, [process.env.npm_execpath, ...args])
      : run(process.env.npm_execpath, args);
  pnpm(["typecheck"]);
  pnpm(["--filter", "@zsir-cut/desktop", "build"]);
  await rm(runtime, { recursive: true, force: true });
  await mkdir(runtime, { recursive: true });
  for (const name of packages) {
    const path = `packages/${name}`;
    await cp(join(repository, path, "dist"), join(runtime, path, "dist"), { recursive: true, filter: releaseFilter });
    await cp(join(repository, path, "package.json"), join(runtime, path, "package.json"));
  }
  for (const path of ["schema", "skills"])
    await cp(join(repository, path), join(runtime, path), { recursive: true, filter: releaseFilter });
  for (const path of ["zsir_asr", "requirements.lock", "pyproject.toml"])
    await cp(join(repository, "workers/asr", path), join(runtime, "workers/asr", path), {
      recursive: true,
      filter: releaseFilter,
    });
  await writeFile(
    join(runtime, "package.json"),
    `${JSON.stringify({ private: true, type: "module", version: "0.1.0" })}\n`,
  );
  for (const path of ["LICENSE", "THIRD_PARTY_NOTICES.md"]) await cp(join(repository, path), join(runtime, path));
  await copyProductionDependencies(
    packages.map((name) => join(repository, "packages", name)),
    join(runtime, "node_modules"),
  );
  await copyNode(runtime);
  await copyFfmpeg(runtime);
  if (process.platform === "darwin") {
    await copyPython(runtime);
    await signMacRuntime(runtime);
  }
  const node = join(runtime, process.platform === "win32" ? "node.exe" : "node");
  if (process.platform !== "win32") await chmod(node, 0o755);
  run(
    node,
    [
      "--input-type=module",
      "-e",
      "import {createCanvas} from '@napi-rs/canvas'; if (createCanvas(1,1).width !== 1) process.exit(1)",
    ],
    runtime,
  );
  console.log(`Release resources ready: ${runtime}`);
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) await packageRelease();
