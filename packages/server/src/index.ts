import { promises as fs } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { systemClock } from "./clock.js";
import { loadConfig, type ServiceConfig } from "./config.js";
import type { Database } from "./database/database.js";
import { loadBundledMigrations } from "./database/migrations.js";
import { openPgliteDatabase } from "./database/pglite.js";
import { openPostgresDatabase } from "./database/postgres.js";
import { anonymousIdentityAdapter } from "./identity/anonymous.js";
import { createLocalIdentityAdapter } from "./identity/local.js";
import { randomIdSource } from "./ids.js";
import { createJsonLogger } from "./log.js";
import { startHttpServer } from "./start.js";

export { ConfigurationError, loadConfig } from "./config.js";
export type { ServiceConfig } from "./config.js";
export { createService } from "./http/service.js";
export { startHttpServer } from "./start.js";

export async function openDatabase(config: ServiceConfig): Promise<Database> {
  if (config.database.kind === "postgres") {
    return openPostgresDatabase(config.database.url);
  }
  if (config.database.dataDir === null) {
    return openPgliteDatabase();
  }
  await fs.mkdir(path.dirname(config.database.dataDir), { recursive: true });
  return openPgliteDatabase(config.database.dataDir);
}

/** The server role's entry point: configure, migrate, serve, shut down clean. */
export async function main(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Promise<void> {
  const config = loadConfig(environment);
  const logger = createJsonLogger(process.stdout);

  for (const directory of [
    config.storage.root,
    config.storage.blobDirectory,
    config.storage.workspaceDirectory,
    config.storage.runDirectory,
  ]) {
    await fs.mkdir(directory, { recursive: true });
  }

  const database = await openDatabase(config);
  try {
    const migrations = await loadBundledMigrations();
    const server = await startHttpServer({
      config,
      database,
      identity:
        config.identity.kind === "local"
          ? createLocalIdentityAdapter(config.identity.administrator)
          : anonymousIdentityAdapter,
      clock: systemClock,
      ids: randomIdSource,
      migrations,
      logger,
    });

    logger.info({
      event: "server.started",
      url: server.url,
      revision: config.revision,
      mode: config.mode,
      database: config.database.kind,
    });

    await new Promise<void>((resolve) => {
      process.once("SIGTERM", resolve);
      process.once("SIGINT", resolve);
    });

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
