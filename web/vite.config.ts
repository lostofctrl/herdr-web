import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const bridgeTarget = process.env.HERDR_WEB_BRIDGE ?? "http://127.0.0.1:8787";
// Comma-separated extra hosts for the dev server, for a Tailscale or LAN name a
// browser reaches instead of localhost. Empty keeps Vite's default host check.
const allowedHosts = (process.env.HERDR_WEB_DEV_ALLOWED_HOSTS ?? "")
  .split(",")
  .map((host) => host.trim())
  .filter(Boolean);

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    allowedHosts: allowedHosts.length > 0 ? allowedHosts : undefined,
    proxy: {
      "/api": bridgeTarget,
      "/ws": {
        target: bridgeTarget,
        ws: true,
      },
    },
  },
});
