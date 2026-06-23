import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// During `bun run dev`, proxy the control-plane routes to a locally running
// control plane (default :8080) so the SPA works against real APIs + session.
const CONTROL_PLANE = process.env.CONTROL_PLANE_URL ?? "http://localhost:8080";

export default defineConfig({
  base: "/",
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: Object.fromEntries(
      ["/api", "/login", "/logout", "/claim", "/health"].map((p) => [
        p,
        { target: CONTROL_PLANE, changeOrigin: true },
      ])
    ),
  },
  build: {
    outDir: "dist",
    sourcemap: false,
  },
});
