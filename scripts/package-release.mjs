import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import * as https from "node:https";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const repository = fileURLToPath(new URL("../", import.meta.url));
export const runtime = join(repository, "apps/desktop-tauri/src-tauri/runtime");
const packages = ["core", "exporters", "cli", "mcp", "app-host"];
export function run(command, args, cwd = repository) {
  const result = spawnSync(command, args, { cwd, stdio: "inherit", windowsHide: true });
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
function download(url) {
  const agent = new https.Agent({ proxyEnv: { HTTPS_PROXY: process.env.HTTPS_PROXY } });
  return new Promise((resolve, reject) => {
    const request = https.get(url, { agent, signal: AbortSignal.timeout(120000) }, (response) => {
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`Download failed: ${url} (${response.statusCode})`));
        return;
      }
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve(Buffer.concat(chunks)));
      response.on("error", reject);
    });
    request.on("error", reject);
  }).finally(() => agent.destroy());
}
export function verifyNodeArchive(bytes, checksums, filename) {
  const expected = checksums
    .split(/\r?\n/)
    .find((line) => line.endsWith(`  ${filename}`))
    ?.split(/\s+/)[0];
  assert.match(expected ?? "", /^[a-f0-9]{64}$/, `Missing official checksum for ${filename}`);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), expected, "Node checksum mismatch");
}
async function copyNode(destination) {
  const binary = process.platform === "win32" ? "node.exe" : "node";
  if (process.env.CI) {
    const license = join(dirname(process.execPath), process.platform === "win32" ? "LICENSE" : "../LICENSE");
    await cp(process.execPath, join(destination, binary));
    await cp(license, join(destination, "NODE-LICENSE.txt"));
    return;
  }
  const folder = `node-${process.version}-${process.platform === "darwin" ? "darwin-arm64" : "win-x64"}`;
  const filename = `${folder}.${process.platform === "win32" ? "zip" : "tar.gz"}`;
  const base = `https://nodejs.org/dist/${process.version}/`;
  const [archive, sums] = await Promise.all([download(`${base}${filename}`), download(`${base}SHASUMS256.txt`)]);
  verifyNodeArchive(archive, sums.toString("utf8"), filename);
  const temporary = await mkdtemp(join(tmpdir(), "zcut-node-"));
  try {
    const file = join(temporary, filename);
    await writeFile(file, archive);
    if (process.platform === "win32") {
      run("powershell.exe", [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `Expand-Archive -LiteralPath '${file.replaceAll("'", "''")}' -DestinationPath '${temporary.replaceAll("'", "''")}'`,
      ]);
    } else run("tar", ["-xzf", file, "-C", temporary, `${folder}/bin/node`, `${folder}/LICENSE`]);
    await cp(join(temporary, folder, process.platform === "win32" ? binary : "bin/node"), join(destination, binary));
    await cp(join(temporary, folder, "LICENSE"), join(destination, "NODE-LICENSE.txt"));
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
  for (const path of ["zsir_asr", "requirements.lock", "pyproject.toml", "README.md"])
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
