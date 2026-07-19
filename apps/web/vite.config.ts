import { defineConfig } from "vite";

export default defineConfig({
  optimizeDeps: {
    // ghostty-web locates ghostty-vt.wasm via `new URL('../ghostty-vt.wasm', import.meta.url)`.
    // Pre-bundling would relocate the module to .vite/deps and break that relative URL,
    // so serve the package from its real location instead.
    exclude: ["ghostty-web"],
  },
});
