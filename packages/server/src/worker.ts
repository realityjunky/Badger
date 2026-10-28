import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { filesystemBlobStore } from "./skills/blobs.js";
import { systemClock } from "./clock.js";
import { loadConfig } from "./config.js";
import {
  loadBundledMigrations,
  applyMigrations,
} from "./database/migrations.js";
import { openDatabase } from "./database/open.js";
import { randomIdSource } from "./ids.js";
import { prepareStorage } from "./storage.js";
import { SourceCheckWorker } from "./workflow-source.js";

export interface WorkerOptions {
  database: import("./database/database.js").Database;
  config: import("./config.js").ServiceConfig;
  workerId?: string;
}

export function createSourceCheckWorker(
  options: WorkerOptions,
): SourceCheckWorker {
  return new SourceCheckWorker({
    database: options.database,
    config: options.config,
    blobs: filesystemBlobStore(options.config.storage.blobDirectory),
    dependencies: { clock: systemClock, ids: randomIdSource },
    workerId: options.workerId ?? `worker-${randomUUID()}`,
  });
}

export async function runSourceCheckWorker(
  options: WorkerOptions,
  signal?: AbortSignal,
): Promise<void> {
  const worker = createSourceCheckWorker(options);
  while (!signal?.aborted) {
    const job = await worker.runOnce();
    if (job !== null) continue;
    await worker.waitForWork(signal);
  }
}

export async function main(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Promise<void> {
  const config = loadConfig(environment);
  await prepareStorage(config.storage);
  const database = await openDatabase(config.database);
  try {
    await applyMigrations(database, await loadBundledMigrations(), systemClock);
    const controller = new AbortController();
    const stop = () => controller.abort();
    process.once("SIGTERM", stop);
    process.once("SIGINT", stop);
    await runSourceCheckWorker({ database, config }, controller.signal);
  } finally {
    await database.close();
  }
}

const entryPoint = process.argv[1];
if (
  entryPoint !== undefined &&
  import.meta.url === pathToFileURL(entryPoint).href
) {
  main().catch((error: unknown) => {
    console.error(
      error instanceof Error ? error.message : "Badger worker could not start",
    );
    process.exitCode = 1;
  });
}
