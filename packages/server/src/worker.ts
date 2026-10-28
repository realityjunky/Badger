import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { filesystemBlobStore } from "./skills/blobs.js";
import { systemClock } from "./clock.js";
import {
  ConfigurationError,
  loadConfig,
  type ServiceConfig,
} from "./config.js";
import type { Database } from "./database/database.js";
import {
  loadBundledMigrations,
  applyMigrations,
} from "./database/migrations.js";
import { openDatabase } from "./database/open.js";
import { randomIdSource } from "./ids.js";
import { createJsonLogger, silentLogger, type Logger } from "./log.js";
import { prepareStorage } from "./storage.js";
import { SourceCheckWorker } from "./workflow-source.js";

export interface WorkerOptions {
  database: Database;
  config: ServiceConfig;
  workerId?: string;
  logger?: Logger;
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

/**
 * Runs every job the worker can claim, then waits for a notification or the
 * poll interval. An error is logged and the loop carries on after one wait,
 * so a database restart pauses the worker instead of ending it.
 */
export async function runSourceCheckWorker(
  options: WorkerOptions,
  signal?: AbortSignal,
): Promise<void> {
  const logger = options.logger ?? silentLogger;
  const worker = createSourceCheckWorker(options);
  while (!signal?.aborted) {
    try {
      const job = await worker.runOnce();
      if (job !== null) {
        logger.info({
          event: "worker.job-finished",
          job: job.id,
          kind: job.kind,
          workflowVersion: job.workflowVersionId,
          status: job.status,
        });
        continue;
      }
    } catch (error) {
      logger.error({
        event: "worker.error",
        error: error instanceof Error ? error.message : String(error),
      });
    }
    await worker.waitForWork(signal);
  }
}

/** The worker role's entry point: configure, migrate, work until signalled. */
export async function main(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Promise<void> {
  const config = loadConfig(environment);
  // PGlite on disk serves one process, and local single-user mode's server
  // already runs the worker beside itself.
  if (config.database.kind !== "postgres")
    throw new ConfigurationError(
      "The worker role needs Postgres; local single-user mode runs it inside the server",
    );
  const logger = createJsonLogger(process.stdout);
  await prepareStorage(config.storage);
  const database = await openDatabase(config.database, {
    onConnectionLost: (error) =>
      logger.error({ event: "database.connection-lost", error: error.message }),
  });
  try {
    await applyMigrations(database, await loadBundledMigrations(), systemClock);
    const controller = new AbortController();
    const stop = () => controller.abort();
    process.once("SIGTERM", stop);
    process.once("SIGINT", stop);
    logger.info({ event: "worker.started", revision: config.revision });
    await runSourceCheckWorker({ database, config, logger }, controller.signal);
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
