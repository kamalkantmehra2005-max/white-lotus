import { defineConfig } from "vitest/config";
import path from "node:path";

/** Integration tests use the embedded local database (PGlite, in memory) — no server needed. */
export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname),
      "server-only": path.resolve(__dirname, "tests/stubs/server-only.ts"),
    },
  },
  test: { include: ["tests/integration/**/*.test.ts"], setupFiles: ["tests/integration/setup.ts"], environment: "node", fileParallelism: false, testTimeout: 30_000, hookTimeout: 60_000 },
});
