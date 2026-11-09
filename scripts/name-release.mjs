import assert from "node:assert/strict";
import { cp, mkdir, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { repository } from "./package-release.mjs";

const version = JSON.parse(await readFile(join(repository, "package.json"), "utf8")).version;
const target = join(repository, "apps/desktop-tauri/src-tauri/target");
const mac = process.platform === "darwin";
assert.ok(mac || process.platform === "win32", "Unsupported release platform");
const bundle = join(
  target,
  mac ? "aarch64-apple-darwin/release/bundle/dmg" : "x86_64-pc-windows-msvc/release/bundle/nsis",
);
const files = (await readdir(bundle)).filter((file) => file.endsWith(mac ? ".dmg" : "-setup.exe"));
assert.equal(files.length, 1, "Expected exactly one installer");
const output = join(target, "release-artifacts");
await mkdir(output, { recursive: true });
await cp(join(bundle, files[0]), join(output, `zsir-cut_${version}_${mac ? "aarch64.dmg" : "x64-setup.exe"}`));
