// Starts the service the way a local user does: local single-user mode, the
// implicit Administrator, PGlite on disk, and the built dashboard. With
// BADGER_E2E_BASE_PATH, it serves under that prefix, as a deployment behind a
// reverse proxy does.
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startTestService } from "@realityjunky/badger-server/testing";

const here = path.dirname(fileURLToPath(import.meta.url));
const webDirectory = path.resolve(here, "..", "dist");
const storage = await fs.mkdtemp(path.join(os.tmpdir(), "badger-e2e-"));
const basePath = process.env["BADGER_E2E_BASE_PATH"];

const service = await startTestService({
  mode: "local",
  environment: {
    BADGER_PORT: process.env["BADGER_E2E_PORT"] ?? "4319",
    BADGER_WEB_DIR: webDirectory,
    BADGER_STORAGE_DIR: storage,
    BADGER_LOCAL_ADMIN_NAME: "Alex Chen",
    BADGER_LOCAL_ADMIN_EMAIL: "alex@example.com",
    ...(basePath === undefined ? {} : { BADGER_BASE_PATH: basePath }),
  },
});

process.stdout.write(`Badger e2e server on ${service.baseUrl}\n`);

// A deployment runs the worker role beside the server, so source checks
// finish while the dashboard watches. Poll the queue the same way here.
let working = false;
const worker = setInterval(async () => {
  if (working) {
    return;
  }
  working = true;
  try {
    await service.runSourceCheckJobs();
  } catch (error) {
    process.stderr.write(`Source check worker failed: ${error}\n`);
  } finally {
    working = false;
  }
}, 250);

let stopping = false;
async function stop() {
  if (stopping) {
    return;
  }
  stopping = true;
  clearInterval(worker);
  await service.close();
  await fs.rm(storage, { recursive: true, force: true });
  process.exit(0);
}

process.on("SIGTERM", stop);
process.on("SIGINT", stop);
