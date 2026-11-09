import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";

const { copyProductionDependencies, releaseFilter, verifyNodeArchive } = await import(
  new URL("../package-release.mjs", import.meta.url).href
);
let temporary: string;
afterEach(async () => {
  if (temporary) await rm(temporary, { recursive: true, force: true });
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
it("rejects corrupt or unlisted Node archives and excludes worker caches, tests and maps", () => {
  const bytes = Buffer.from("node archive");
  const name = "node-v24.14.1-darwin-arm64.tar.gz";
  const sums = `${createHash("sha256").update(bytes).digest("hex")}  ${name}\n`;
  expect(() => verifyNodeArchive(bytes, sums, name)).not.toThrow();
  expect(() => verifyNodeArchive(Buffer.from("corrupt"), sums, name)).toThrow("Node checksum mismatch");
  expect(() => verifyNodeArchive(bytes, sums, "other.zip")).toThrow("Missing official checksum");
  for (const path of ["/asr/.venv", "/asr/__pycache__", "/asr/worker.pyc", "/dist/index.js.map", "/worker/tests"])
    expect(releaseFilter(path)).toBe(false);
  expect(releaseFilter("/asr/zsir_asr/worker.py")).toBe(true);
});
