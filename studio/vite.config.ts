import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const uiPort = Number(process.env.TOMOTA_STUDIO_PORT || 43127);
const apiPort = Number(process.env.TOMOTA_STUDIO_API_PORT || 43128);

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: uiPort,
    strictPort: true,
    proxy: {
      "/api": `http://127.0.0.1:${apiPort}`,
    },
  },
  build: {
    outDir: "dist",
    sourcemap: true,
  },
});
