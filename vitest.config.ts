import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    testTimeout: 20_000,
    hookTimeout: 30_000,
    // Integration suites share one PostgreSQL database, so files run one at a time.
    fileParallelism: false,
  },
});
