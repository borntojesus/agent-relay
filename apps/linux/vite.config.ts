import { defineConfig } from "vite";

// Tauri serves the built files from dist-ui/; dev uses a fixed port.
export default defineConfig({
  clearScreen: false,
  server: { port: 1430, strictPort: true, host: "127.0.0.1" },
  build: { outDir: "dist-ui", target: "safari15", emptyOutDir: true },
});
