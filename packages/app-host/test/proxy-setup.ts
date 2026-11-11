import { expect, vi } from "vitest";

if (expect.getState().testPath?.includes("/packages/app-host/")) {
  for (const key of Object.keys(process.env)) {
    if (/^(https_proxy|http_proxy|all_proxy|no_proxy|node_use_env_proxy)$/i.test(key)) delete process.env[key];
  }
}
vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  if (!expect.getState().testPath?.includes("/packages/app-host/")) return original;
  return {
    ...original,
    execFileSync: ((file: string, ...args: unknown[]) => {
      if (file === "scutil" || file === "reg") throw new Error("System proxy command disabled in tests");
      return (original.execFileSync as (...args: unknown[]) => unknown)(file, ...args);
    }) as typeof original.execFileSync,
  };
});
