// Starts the service the way a local user does: local single-user mode, the
// implicit Administrator, PGlite on disk, and the built dashboard.
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startTestService } from "@realityjunky/badger-server/testing";

const here = path.dirname(fileURLToPath(import.meta.url));
const webDirectory = path.resolve(here, "..", "dist");
const storage = await fs.mkdtemp(path.join(os.tmpdir(), "badger-e2e-"));

const service = await startTestService({
  mode: "local",
  environment: {
    BADGER_PORT: process.env["BADGER_E2E_PORT"] ?? "4319",
    BADGER_WEB_DIR: webDirectory,
    BADGER_STORAGE_DIR: storage,
    BADGER_LOCAL_ADMIN_NAME: "Alex Chen",
    BADGER_LOCAL_ADMIN_EMAIL: "alex@example.com",
  },
});

process.stdout.write(`Badger e2e server on ${service.baseUrl}\n`);

let stopping = false;
async function stop() {
  if (stopping) {
    return;
  }
  stopping = true;
  await service.close();
  await fs.rm(storage, { recursive: true, force: true });
  process.exit(0);
}

process.on("SIGTERM", stop);
process.on("SIGINT", stop);
