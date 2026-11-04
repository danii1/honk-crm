import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "src") } },
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        // The plugin drops the wrangler assets binding unless miniflare is given a directory.
        assets: { directory: path.resolve(import.meta.dirname, "dist/client") },
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations(path.join(import.meta.dirname, "migrations")),
          BETTER_AUTH_SECRET: "test-secret-0123456789abcdef0123456789",
          BETTER_AUTH_URL: "http://localhost",
          ALLOWED_SIGNUP_EMAILS: "@test.dev",
        },
      },
    })),
  ],
  test: { globalSetup: ["./test/global-setup.ts"], setupFiles: ["./test/apply-migrations.ts"] },
});
