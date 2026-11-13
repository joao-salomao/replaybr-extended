import { crx } from "@crxjs/vite-plugin";
import { defineConfig } from "vite";
import manifest from "./manifest.config.ts";

export default defineConfig({
  plugins: [crx({ manifest })],
  // ffmpeg.wasm spawns its own worker by URL; pre-bundling breaks that path.
  optimizeDeps: { exclude: ["@ffmpeg/ffmpeg", "@ffmpeg/util"] },
  build: {
    rollupOptions: {
      input: { app: "app.html", probe: "probe.html" },
    },
  },
});
