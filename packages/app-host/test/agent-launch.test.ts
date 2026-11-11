import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { codexEnvironment, codexNative, findProgram } from "../src/agent-management.js";

it("skips a broken executable and falls back to it when no version works", async () => {
  const root = await mkdtemp(join(tmpdir(), "zcut-discovery-"));
  try {
    const bad = join(root, "bad");
    const good = join(root, "good");
    await mkdir(bad);
    await mkdir(good);
    await writeFile(join(bad, "claude"), "#!/bin/sh\nexit 1\n", { mode: 0o700 });
    await writeFile(join(good, "claude"), "#!/bin/sh\necho 1.2.3\n", { mode: 0o700 });
    expect(await findProgram("claude", [bad, good])).toBe(join(good, "claude"));
    expect(await findProgram("claude", [bad])).toBe(join(bad, "claude"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it.skipIf(process.platform === "win32")(
  "resolves the npm Codex native executable and its managed environment",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "zcut-native-"));
    try {
      const pkg = join(root, "node_modules/@openai/codex");
      const bin = join(pkg, "bin");
      const native = join(pkg, "node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex");
      await mkdir(bin, { recursive: true });
      await mkdir(join(native, ".."), { recursive: true });
      await writeFile(join(bin, "codex.js"), "#!/bin/sh\nexit 1\n", { mode: 0o700 });
      await writeFile(native, "#!/bin/sh\necho 1.2.3\n", { mode: 0o700 });
      const link = join(root, "codex");
      await symlink(join(bin, "codex.js"), link);
      expect(await codexNative(link, "darwin", "arm64")).toEqual({
        path: await realpath(native),
        root: await realpath(pkg),
      });
      expect(codexEnvironment(native)).toEqual({ CODEX_MANAGED_BY_NPM: "1", CODEX_MANAGED_PACKAGE_ROOT: pkg });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
