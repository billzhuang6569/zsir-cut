import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { tokenCss } from "./src/tokens.js";

export default defineConfig({
  build: { target: "es2022" },
  plugins: [
    react(),
    {
      name: "design-tokens",
      resolveId: (id) => (id === "virtual:tokens.css" ? "\0tokens.css" : undefined),
      load: (id) => (id === "\0tokens.css" ? tokenCss() : undefined),
    },
  ],
});
