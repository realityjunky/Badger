import { createRequire } from "node:module";
import path from "node:path";

// npm hoists vitest to the workspace root, so resolve its CLI rather than
// assume a package-local node_modules.
export const vitestCli = path.join(
  path.dirname(createRequire(import.meta.url).resolve("vitest/package.json")),
  "vitest.mjs",
);
