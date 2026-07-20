import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      input: {
        main: new URL("./index.html", import.meta.url).pathname,
        showcase: new URL("./showcase.html", import.meta.url).pathname,
      },
    },
  },
  server: {
    port: 5666,
    // The daemon sends no CORS headers (by design — it is same-origin only),
    // so dev traffic must reach it same-origin too: proxy /api and /ws to the
    // daemon's default port. api.ts keeps baseUrl = "" in every mode.
    proxy: {
      "/api": "http://127.0.0.1:4666",
      "/ws": { target: "ws://127.0.0.1:4666", ws: true },
    },
  },
  optimizeDeps: {
    // ghostty-web locates ghostty-vt.wasm via `new URL('../ghostty-vt.wasm', import.meta.url)`.
    // Pre-bundling would relocate the module to .vite/deps and break that relative URL,
    // so serve the package from its real location instead.
    exclude: ["ghostty-web"],
  },
});
