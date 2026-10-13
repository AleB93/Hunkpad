import { defineConfig } from "vite";

// Settings follow the Tauri v2 + Vite template.
export default defineConfig({
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  build: {
    target: "es2021",
    // Monaco is large by nature; it is loaded from disk, not the network.
    chunkSizeWarningLimit: 6000,
  },
});
