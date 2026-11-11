import { defineConfig } from "vitest/config";

export default defineConfig({
  esbuild: { jsx: "automatic" },
  test: {
    setupFiles: ["./packages/app-host/test/proxy-setup.ts"],
    include: [
      "packages/**/test/**/*.test.ts",
      "packages/**/test/**/*.test.tsx",
      "fixtures/synth/**/*.test.ts",
      "scripts/test/**/*.test.ts",
    ],
  },
});
