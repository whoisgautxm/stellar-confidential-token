import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { nodePolyfills } from "vite-plugin-node-polyfills";

// Circuit wasm/zkey artifacts are copied into `public/circuits/` by
// `scripts/sync-env.mjs` (which runs automatically via `predev` / `prebuild`).
// Vite then serves them from /circuits/<name>/<name>.{wasm,zkey} natively.

export default defineConfig({
  plugins: [
    react(),
    nodePolyfills({
      // The SDK's poseidon module imports `node:crypto`; jub + stellar use
      // `Buffer.from`. Polyfill both so packages/sdk/* runs unchanged in the browser.
      include: ["buffer", "crypto", "process", "stream", "util"],
      globals: { Buffer: true, global: true, process: true },
    }),
  ],
  server: {
    port: 5173,
    fs: { allow: [".."] },
  },
  optimizeDeps: {
    exclude: ["snarkjs"],
  },
  build: {
    target: "esnext",
  },
});
