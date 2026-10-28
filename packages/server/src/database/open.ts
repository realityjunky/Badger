import { promises as fs } from "node:fs";
import path from "node:path";
import type { DatabaseConfiguration } from "../config.js";
import type { Database } from "./database.js";
import { openPgliteDatabase } from "./pglite.js";
import { openPostgresDatabase, type PostgresOptions } from "./postgres.js";

/** Connects to the database a deployment's settings name. */
export async function openDatabase(
  configuration: DatabaseConfiguration,
  options: PostgresOptions = {},
): Promise<Database> {
  if (configuration.kind === "postgres") {
    return openPostgresDatabase(configuration.url, options);
  }
  if (configuration.dataDir === null) {
    return openPgliteDatabase();
  }
  await fs.mkdir(path.dirname(configuration.dataDir), { recursive: true });
  return openPgliteDatabase(configuration.dataDir);
}
