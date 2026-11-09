import * as childProcess from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { access, mkdir, mkdtemp, readdir, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import type { ClientRequest, IncomingMessage } from "node:http";
import * as https from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { runInNewContext } from "node:vm";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawnSync: vi.fn(),
}));
vi.mock("node:https", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:https")>()),
  get: vi.fn(),
}));
const {
  cachedDownload,
  cachedNodeArchive,
  checkMacRuntime,
  copyProductionDependencies,
  copyNodeDistribution,
  download,
  isMachO,
  installPythonRequirements,
  nodeArchiveChecksum,
  prunePython,
  releaseFilter,
} = await import(new URL("../package-release.mjs", import.meta.url).href);
let temporary: string;
afterEach(async () => {
  vi.useRealTimers();
  vi.resetAllMocks();
  if (temporary) await rm(temporary, { recursive: true, force: true });
});
function respond(response: PassThrough, statusCode = 200, headers = {}) {
  vi.mocked(https.get).mockImplementationOnce((_url, options, callback) => {
    const request = new EventEmitter();
    options.signal?.addEventListener("abort", () => request.emit("error", new Error("Download aborted")), {
      once: true,
    });
    callback?.(Object.assign(response, { statusCode, headers }) as unknown as IncomingMessage);
    return request as ClientRequest;
  });
}
it.each(["darwin", "win32"])(
  "copies Node and npm from the %s official distribution with runtime dependencies and licenses",
  async (platform) => {
    temporary = await mkdtemp(join(tmpdir(), "zcut-node-"));
    const source = join(temporary, "official-node");
    const output = join(temporary, "runtime");
    const npm = platform === "win32" ? "node_modules/npm" : "lib/node_modules/npm";
    const binary = platform === "win32" ? "node.exe" : "bin/node";
    const files = [
      binary,
      "LICENSE",
      `${npm}/LICENSE`,
      `${npm}/package.json`,
      `${npm}/bin/npm-cli.js`,
      `${npm}/node_modules/dep/index.js`,
      `${npm}/node_modules/dep/LICENSE`,
    ];
    const omitted = [`${npm}/docs/index.md`, `${npm}/man/npm.1`, `${npm}/node_modules/dep/tests/test.js`];
    for (const path of [...files, ...omitted]) {
      await mkdir(join(source, path, ".."), { recursive: true });
      await writeFile(join(source, path), path);
    }
    if (process.platform !== "win32") {
      await mkdir(join(source, npm, "node_modules/.bin"));
      await symlink("../dep/index.js", join(source, npm, "node_modules/.bin/dep"));
    }
    await mkdir(output);
    await copyNodeDistribution(source, output, platform);
    expect(await readFile(join(output, platform === "win32" ? "node.exe" : "node"), "utf8")).toBe(binary);
    expect(await readFile(join(output, "NODE-LICENSE.txt"), "utf8")).toBe("LICENSE");
    expect(await readFile(join(output, "NPM-LICENSE.txt"), "utf8")).toBe(`${npm}/LICENSE`);
    for (const path of files.filter((path) => path.startsWith(`${npm}/`)))
      expect(await readFile(join(output, "npm", path.slice(npm.length + 1)), "utf8")).toBe(path);
    for (const path of ["npm/docs", "npm/man", "npm/node_modules/dep/tests"])
      await expect(access(join(output, path))).rejects.toThrow();
    await rm(source, { recursive: true });
    if (process.platform !== "win32") {
      expect(await readlink(join(output, "npm/node_modules/.bin/dep"))).toBe("../dep/index.js");
      expect(await readFile(join(output, "npm/node_modules/.bin/dep"), "utf8")).toBe(
        `${npm}/node_modules/dep/index.js`,
      );
    }
  },
);
it("disables progress and stops on errors in both Windows extraction commands", async () => {
  const source = await readFile(new URL("../package-release.mjs", import.meta.url), "utf8");
  const commands = source.match(/run\("powershell\.exe", \[[\s\S]*?\]\);/g) ?? [];
  expect(commands).toHaveLength(2);
  const run = vi.fn();
  for (const command of commands) {
    runInNewContext(command, { run, file: "archive.zip", destination: "output", temporary: "temporary" });
  }
  for (const [, args] of run.mock.calls) {
    expect(args[3]).toContain("$ProgressPreference='SilentlyContinue'; $ErrorActionPreference='Stop'; Expand-Archive");
  }
});
it("streams a download lasting over two minutes while data keeps arriving within 60 seconds", async () => {
  temporary = await mkdtemp(join(tmpdir(), "zcut-download-"));
  vi.useFakeTimers();
  const response = new PassThrough();
  respond(response);
  const file = join(temporary, "archive");
  const pending = download("https://example.invalid/archive", file);
  for (let i = 0; i < 4; i++) {
    response.write("chunk");
    await vi.advanceTimersByTimeAsync(59_000);
  }
  await vi.waitFor(async () => expect(await readFile(file, "utf8")).toBe("chunk".repeat(4)));
  response.end();
  await pending;
  expect(await readFile(file, "utf8")).toBe("chunk".repeat(4));
  expect(vi.getTimerCount()).toBe(0);
});
it("aborts after 60 seconds without new data, including before response headers arrive", async () => {
  temporary = await mkdtemp(join(tmpdir(), "zcut-download-"));
  vi.useFakeTimers();
  for (const withHeaders of [true, false]) {
    const response = new PassThrough();
    if (withHeaders) respond(response);
    else {
      vi.mocked(https.get).mockImplementationOnce((_url, options) => {
        const request = new EventEmitter();
        options.signal?.addEventListener("abort", () => request.emit("error", new Error("Download aborted")));
        return request as ClientRequest;
      });
    }
    const pending = download("https://example.invalid/archive", join(temporary, "archive"));
    const rejected = expect(pending).rejects.toThrow(/abort/i);
    if (withHeaders) response.write("first chunk");
    await vi.advanceTimersByTimeAsync(59_999);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
  }
});
it("follows relative redirects and rejects HTTP failures and excessive redirects", async () => {
  temporary = await mkdtemp(join(tmpdir(), "zcut-download-"));
  respond(new PassThrough(), 302, { location: "/archive" });
  const response = new PassThrough();
  respond(response);
  response.end("archive bytes");
  const file = join(temporary, "archive");
  await download("https://example.invalid/start", file);
  expect(vi.mocked(https.get).mock.calls[1]?.[0]).toBe("https://example.invalid/archive");
  expect(await readFile(file, "utf8")).toBe("archive bytes");
  respond(new PassThrough(), 503);
  await expect(download("https://example.invalid/unavailable", file)).rejects.toThrow("(503)");
  for (let i = 0; i < 6; i++) respond(new PassThrough(), 302, { location: "/loop" });
  await expect(download("https://example.invalid/loop", file)).rejects.toThrow("(302)");
});
it("waits for an interrupted stream to close before retrying and committing a verified cache file", async () => {
  temporary = await mkdtemp(join(tmpdir(), "zcut-download-"));
  const bytes = Buffer.from("verified release archive");
  const asset = { url: "https://example.invalid/archive", sha256: createHash("sha256").update(bytes).digest("hex") };
  const first = new PassThrough();
  const second = new PassThrough();
  respond(first);
  respond(second);
  const pending = cachedDownload(asset, temporary);
  await vi.waitFor(() => expect(first.listenerCount("error")).toBeGreaterThan(0));
  first.write("partial download");
  first.destroy(new Error("connection reset"));
  await vi.waitFor(() => expect(second.listenerCount("error")).toBeGreaterThan(0));
  expect(first.closed).toBe(true);
  second.end(bytes);
  const file = await pending;
  expect(await readFile(file)).toEqual(bytes);
  expect(await readdir(temporary)).toEqual([`${asset.sha256}-archive`]);
  expect(https.get).toHaveBeenCalledTimes(2);
});
it("copies only the production graph, preserving conflicting dependency versions without symlinks", async () => {
  temporary = await mkdtemp(join(tmpdir(), "zcut-package-"));
  const consumer = join(temporary, "consumer");
  const output = join(temporary, "output/node_modules");
  const manifests = {
    "": { dependencies: { a: "1", b: "1" }, devDependencies: { dev: "1" }, optionalDependencies: { absent: "1" } },
    "node_modules/a": { dependencies: { shared: "1" } },
    "node_modules/b": { dependencies: { shared: "2" } },
    "node_modules/a/node_modules/shared": { version: "1" },
    "node_modules/b/node_modules/shared": { version: "2" },
    "node_modules/dev": {},
  };
  for (const [path, manifest] of Object.entries(manifests)) {
    await mkdir(join(consumer, path), { recursive: true });
    await writeFile(join(consumer, path, "package.json"), JSON.stringify(manifest));
  }
  await mkdir(join(consumer, "node_modules/a/tests"));
  await writeFile(join(consumer, "node_modules/a/tests/secret.js"), "test only");
  await writeFile(join(consumer, "node_modules/a/index.js.map"), "sourcemap");
  await copyProductionDependencies([consumer], output);
  expect(JSON.parse(await readFile(join(output, "shared/package.json"), "utf8")).version).toBe("1");
  expect(JSON.parse(await readFile(join(output, "b/node_modules/shared/package.json"), "utf8")).version).toBe("2");
  for (const path of ["dev", "a/tests", "a/index.js.map", "a/node_modules"])
    await expect(access(join(output, path))).rejects.toThrow();
});
it("rejects missing required production dependencies", async () => {
  temporary = await mkdtemp(join(tmpdir(), "zcut-package-"));
  await writeFile(join(temporary, "package.json"), JSON.stringify({ dependencies: { "zcut-nonexistent": "1" } }));
  await expect(copyProductionDependencies([temporary], join(temporary, "out"))).rejects.toThrow(
    "Missing production dependency",
  );
});
it("reads official Node checksums, rejects unlisted archives and excludes worker caches, tests and maps", () => {
  const bytes = Buffer.from("node archive");
  const name = "node-v24.14.1-darwin-arm64.tar.gz";
  const sums = `${createHash("sha256").update(bytes).digest("hex")}  ${name}\n`;
  expect(nodeArchiveChecksum(sums, name)).toBe(createHash("sha256").update(bytes).digest("hex"));
  expect(() => nodeArchiveChecksum(sums, "other.zip")).toThrow("Missing official checksum");
  for (const path of ["/asr/.venv", "/asr/__pycache__", "/asr/worker.pyc", "/dist/index.js.map", "/worker/tests"])
    expect(releaseFilter(path)).toBe(false);
  expect(releaseFilter("/asr/zsir_asr/worker.py")).toBe(true);
});
it("reuses only verified downloads and never caches a corrupt response", async () => {
  temporary = await mkdtemp(join(tmpdir(), "zcut-download-"));
  const bytes = Buffer.from("verified release archive");
  const asset = { url: "https://example.invalid/ffmpeg.zip", sha256: createHash("sha256").update(bytes).digest("hex") };
  const fetch = vi.fn(async (_url: string, file: string) => writeFile(file, bytes));
  const file = await cachedDownload(asset, temporary, fetch);
  expect(await readFile(file)).toEqual(bytes);
  expect(await cachedDownload(asset, temporary, fetch)).toBe(file);
  expect(fetch).toHaveBeenCalledTimes(1);
  await writeFile(file, "corrupt cache");
  await cachedDownload(asset, temporary, fetch);
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(await readFile(file)).toEqual(bytes);
  await writeFile(file, "corrupt cache");
  const corrupt = vi.fn(async (_url: string, file: string) => writeFile(file, "corrupt download"));
  await expect(cachedDownload(asset, temporary, corrupt)).rejects.toThrow("Archive checksum mismatch");
  expect(corrupt).toHaveBeenCalledTimes(2);
  await expect(access(file)).rejects.toThrow();
  await expect(access(`${file}.partial`)).rejects.toThrow();
});
it("retries a failed download once and removes partial files when both attempts fail", async () => {
  temporary = await mkdtemp(join(tmpdir(), "zcut-download-"));
  const bytes = Buffer.from("verified release archive");
  const asset = {
    url: "https://example.invalid/python.tar.gz",
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
  const fail = async (_url: string, file: string): Promise<void> => {
    await writeFile(file, "partial");
    throw new Error("connection reset");
  };
  const fetch = vi
    .fn(fail)
    .mockImplementationOnce(fail)
    .mockImplementationOnce(async (_url, file) => writeFile(file, bytes));
  const file = await cachedDownload(asset, temporary, fetch);
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(file).toBe(join(temporary, `${asset.sha256}-python.tar.gz`));
  expect(await readFile(file)).toEqual(bytes);
  await rm(file);
  const failed = vi.fn(fail);
  await expect(cachedDownload(asset, temporary, failed)).rejects.toThrow("connection reset");
  expect(failed).toHaveBeenCalledTimes(2);
  expect(await readdir(temporary)).toEqual([]);
});
it("caches Node SHASUMS by version and verifies Node archives without networking on cache hits", async () => {
  temporary = await mkdtemp(join(tmpdir(), "zcut-download-"));
  const name = "node-v24.14.1-darwin-arm64.tar.gz";
  const bytes = Buffer.from("node archive");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const fetch = vi.fn(async (url: string, file: string) =>
    writeFile(file, url.endsWith("SHASUMS256.txt") ? `${sha256}  ${name}\n` : bytes),
  );
  const base = "https://example.invalid/v24.14.1/";
  const file = await cachedNodeArchive(base, name, temporary, fetch);
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(await readFile(file)).toEqual(bytes);
  fetch.mockImplementation(async () => {
    throw new Error("offline");
  });
  expect(await cachedNodeArchive(base, name, temporary, fetch)).toBe(file);
  expect(fetch).toHaveBeenCalledTimes(2);
  await writeFile(file, "corrupt Node cache");
  const corrupt = vi.fn(async (_url: string, file: string) => writeFile(file, "corrupt Node download"));
  await expect(cachedNodeArchive(base, name, temporary, corrupt)).rejects.toThrow("Archive checksum mismatch");
  await expect(access(file)).rejects.toThrow();
  await expect(access(`${file}.partial`)).rejects.toThrow();
  expect(corrupt).toHaveBeenCalledTimes(2);
  expect(corrupt.mock.calls.every(([url]) => url === `${base}${name}`)).toBe(true);
  const otherVersion = "https://example.invalid/v24.14.2/";
  await expect(cachedNodeArchive(otherVersion, name, temporary, fetch)).rejects.toThrow("offline");
  expect(fetch.mock.calls.at(-1)?.[0]).toBe(`${otherVersion}SHASUMS256.txt`);
});
it("prunes Python installers, test directories and bytecode while preserving runtime libraries and licenses", async () => {
  temporary = await mkdtemp(join(tmpdir(), "zcut-python-"));
  const removed = [
    "bin/pip",
    "bin/pip3.13",
    "lib/pip/__init__.py",
    "lib/pip-26.dist-info/METADATA",
    "lib/ensurepip/_bundled/pip.whl",
    "lib/numpy/tests/test.py",
    "lib/numpy/__pycache__/a.pyc",
    "lib/a.pyc",
  ];
  const retained = [
    "bin/python3",
    "lib/mlx/core.so",
    "lib/mlx/libmlx.dylib",
    "lib/mlx-0.32.4.dist-info/licenses/LICENSE",
    "lib/mlx-0.32.4.dist-info/METADATA",
    "lib/numpy/__init__.py",
  ];
  for (const path of [...removed, ...retained]) {
    await mkdir(join(temporary, path, ".."), { recursive: true });
    await writeFile(join(temporary, path), "payload");
  }
  await prunePython(temporary);
  for (const path of removed) await expect(access(join(temporary, path))).rejects.toThrow();
  for (const path of retained) await expect(access(join(temporary, path))).resolves.toBeUndefined();
});
it("recognizes Mach-O executables, extensions and universal libraries without trying to sign scripts or ELF", () => {
  for (const magic of ["feedface", "cefaedfe", "feedfacf", "cffaedfe", "cafebabe", "bebafeca", "cafebabf", "bfbafeca"])
    expect(isMachO(Buffer.from(`${magic}00000000`, "hex"))).toBe(true);
  expect(isMachO(Buffer.from("#!/bin/sh"))).toBe(false);
  expect(isMachO(Buffer.from("7f454c46", "hex"))).toBe(false);
  expect(isMachO(Buffer.from("cf", "hex"))).toBe(false);
});

it("selects macOS 14 wheels and builds only the pinned source-only jieba separately", async () => {
  temporary = await mkdtemp(join(tmpdir(), "zcut-wheels-"));
  vi.mocked(childProcess.spawnSync).mockReturnValue({ status: 0 } as childProcess.SpawnSyncReturns<Buffer>);
  await installPythonRequirements("bundled-python", temporary, { PYTHONDONTWRITEBYTECODE: "1" });
  const calls = vi.mocked(childProcess.spawnSync).mock.calls;
  expect(calls).toHaveLength(3);
  expect(calls[0]?.[1]).toEqual([
    "-m",
    "pip",
    "wheel",
    "--no-cache-dir",
    "--no-deps",
    "--wheel-dir",
    join(temporary, "wheels"),
    "jieba==0.42.1",
  ]);
  expect(calls[1]?.[1]).toEqual(
    expect.arrayContaining([
      "download",
      "--platform",
      "macosx_14_0_arm64",
      "--only-binary=:all:",
      "--find-links",
      "--dest",
      "-r",
    ]),
  );
  expect(calls[2]?.[1]).toEqual(
    expect.arrayContaining(["install", "--no-index", "--only-binary=:all:", "--no-compile"]),
  );
  vi.mocked(childProcess.spawnSync).mockReturnValue({ status: 1 } as childProcess.SpawnSyncReturns<Buffer>);
  await expect(installPythonRequirements("bundled-python", temporary, {})).rejects.toThrow("failed (1)");
});

it("checks every Mach-O slice recursively and rejects a deployment target above macOS 14.0", async () => {
  temporary = await mkdtemp(join(tmpdir(), "zcut-macho-"));
  await mkdir(join(temporary, "lib"));
  for (const path of ["node", "lib/core.so", "lib/libmlx.dylib"])
    await writeFile(join(temporary, path), Buffer.from("cffaedfe", "hex"));
  await writeFile(join(temporary, "script"), "#!/bin/sh");
  const build = (version: string) =>
    `Load command 0\n      cmd LC_BUILD_VERSION\n platform 1\n    minos ${version}\n      sdk 26.2\n ntools 1\n tool 3\n version 1267.0\n`;
  const inspect = vi.fn(() => ({ status: 0, stdout: build("14.0"), stderr: "" }));
  await expect(checkMacRuntime(temporary, inspect)).resolves.toBeUndefined();
  expect(inspect.mock.calls).toHaveLength(3);
  inspect.mockReturnValue({ status: 0, stdout: "cmd LC_VERSION_MIN_MACOSX\n version 13.0\n sdk 26.2\n", stderr: "" });
  await expect(checkMacRuntime(temporary, inspect)).resolves.toBeUndefined();
  for (const version of ["14.0.1", "14.1", "26.0", "26.2"]) {
    inspect.mockReturnValue({ status: 0, stdout: build("13.0") + build(version), stderr: "" });
    await expect(checkMacRuntime(temporary, inspect)).rejects.toThrow(`requires macOS ${version}, above 14.0`);
  }
  inspect.mockReturnValue({ status: 0, stdout: "cmd LC_SOURCE_VERSION\n version 1.0\n", stderr: "" });
  await expect(checkMacRuntime(temporary, inspect)).rejects.toThrow("Missing macOS deployment target");
  inspect.mockReturnValue({ status: 1, stdout: "", stderr: "unreadable" });
  await expect(checkMacRuntime(temporary, inspect)).rejects.toThrow("otool failed");
});

it("declares macOS 14.0 as the deployment floor", async () => {
  const config = JSON.parse(
    await readFile(new URL("../../apps/desktop-tauri/src-tauri/tauri.macos.conf.json", import.meta.url), "utf8"),
  );
  expect(config.bundle.macOS.minimumSystemVersion).toBe("14.0");
});
