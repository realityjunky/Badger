import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Each file migrates isolated databases. Bound their combined lock demand
    // on Postgres; concurrency inside HTTP regression tests stays unchanged.
    maxWorkers:
      process.env["BADGER_TEST_DATABASE_URL"] === undefined ? undefined : 4,
    testTimeout: 30_000,
  },
});
