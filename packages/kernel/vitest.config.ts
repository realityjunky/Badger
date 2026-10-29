import { defineConfig } from "vitest/config";
import { realpathSync } from "node:fs";
import os from "node:os";

// macOS's temporary directory can traverse /var -> /private/var. Fixtures
// must use its real path so standalone Run tests retain the link guards.
const temporaryRoot = realpathSync(os.tmpdir());
for (const name of ["TMPDIR", "TMP", "TEMP"]) {
  process.env[name] = temporaryRoot;
}

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
  },
});
