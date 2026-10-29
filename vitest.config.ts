import { defineConfig } from "vitest/config";

export default defineConfig({
  esbuild: { jsx: "automatic" },
  test: {
    include: ["packages/**/test/**/*.test.ts", "packages/**/test/**/*.test.tsx", "fixtures/synth/**/*.test.ts"],
  },
});
