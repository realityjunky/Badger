import { pathToFileURL } from "node:url";
import { systemClock } from "./clock.js";
import { loadConfig } from "./config.js";
import { loadBundledMigrations } from "./database/migrations.js";
import { openDatabase } from "./database/open.js";
import { configuredIdentityAdapter } from "./identity/configured.js";
import { randomIdSource } from "./ids.js";
import { createJsonLogger } from "./log.js";
import { startHttpServer } from "./start.js";
import { prepareStorage } from "./storage.js";
import { runServiceWorker } from "./worker.js";

export { ConfigurationError, loadConfig } from "./config.js";
export type { ServiceConfig } from "./config.js";
export type { EffectRevision } from "./script-effects.js";
export { openDatabase } from "./database/open.js";
export { createService } from "./http/service.js";
export { startHttpServer } from "./start.js";
export {
  createSourceCheckWorker,
  runSourceCheckWorker,
  runNotificationWorker,
  runServiceWorker,
  type WorkerOptions,
} from "./worker.js";

/** The server role's entry point: configure, migrate, serve, shut down clean. */
export async function main(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Promise<void> {
  const config = loadConfig(environment);
  const logger = createJsonLogger(process.stdout);

  await prepareStorage(config.storage);

  const database = await openDatabase(config.database, {
    onConnectionLost: (error) =>
      logger.error({ event: "database.connection-lost", error: error.message }),
  });
  try {
    const migrations = await loadBundledMigrations();
    const server = await startHttpServer({
      config,
      database,
      identity: configuredIdentityAdapter(
        config,
        systemClock,
        database,
        logger,
      ),
      clock: systemClock,
      ids: randomIdSource,
      migrations,
      logger,
    });

    // Local single-user mode is one process, and PGlite on disk serves only
    // one, so its server runs the worker role beside itself. A service
    // deployment runs the worker role in its own container.
    const stopWorker = new AbortController();
    const worker =
      config.mode === "local"
        ? runServiceWorker(
            { database, config, logger },
            stopWorker.signal,
          ).catch((error: unknown) =>
            logger.error({
              event: "worker.stopped",
              error: error instanceof Error ? error.message : String(error),
            }),
          )
        : null;

    logger.info({
      event: "server.started",
      url: server.url,
      revision: config.revision,
      mode: config.mode,
      database: config.database.kind,
      worker: worker === null ? "separate" : "embedded",
    });

    await new Promise<void>((resolve) => {
      process.once("SIGTERM", resolve);
      process.once("SIGINT", resolve);
    });

    stopWorker.abort();
    await worker;
    await server.close();
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
      error instanceof Error ? error.message : "Badger could not start",
    );
    process.exitCode = 1;
  });
}
