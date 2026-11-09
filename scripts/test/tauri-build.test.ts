import { spawnSync } from "node:child_process";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({ spawnSync: vi.fn() }));
const argv = process.argv;
const exitCode = process.exitCode;
afterEach(() => {
  process.argv = argv;
  process.exitCode = exitCode;
  vi.resetModules();
});

it.each([0, 7, null])(
  "sets CI and forwards Tauri build arguments and exit status %s without building",
  async (status) => {
    process.argv = [process.execPath, "build.mjs", "--target", "aarch64-apple-darwin"];
    vi.mocked(spawnSync).mockReturnValue({ status } as ReturnType<typeof spawnSync>);
    await import(new URL("../../apps/desktop-tauri/build.mjs", import.meta.url).href);
    expect(spawnSync).toHaveBeenLastCalledWith(
      process.execPath,
      [
        expect.stringMatching(/[/\\]tauri\.js$/),
        "build",
        "--config",
        "src-tauri/tauri.release.conf.json",
        "--target",
        "aarch64-apple-darwin",
      ],
      { env: expect.objectContaining({ CI: "true" }), stdio: "inherit", windowsHide: true },
    );
    expect(process.exitCode).toBe(status ?? 1);
  },
);

it("reports a failure to start the Tauri CLI", async () => {
  vi.mocked(spawnSync).mockReturnValue({ error: new Error("spawn failed") } as ReturnType<typeof spawnSync>);
  await expect(import(new URL("../../apps/desktop-tauri/build.mjs", import.meta.url).href)).rejects.toThrow(
    "spawn failed",
  );
});
