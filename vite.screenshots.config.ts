import path from "node:path";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss(), cloudflare({
    configPath: ".wrangler/screenshot-config/wrangler.jsonc",
    viteEnvironment: { name: "worker" },
    persistState: { path: ".wrangler/screenshot-state" },
  })],
  server: { port: 5174, strictPort: true },
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "src") } },
});
