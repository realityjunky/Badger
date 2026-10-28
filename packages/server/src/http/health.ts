import type { ServiceConfig } from "../config.js";
import type { Queryable } from "../database/database.js";
import {
  inspectMigrations,
  UNAVAILABLE_MIGRATION_STATE,
  type Migration,
  type MigrationState,
} from "../database/migrations.js";
import { withTimeout } from "../util.js";

export interface HealthReport {
  status: "ok" | "degraded";
  revision: string;
  cleanTree: boolean | null;
  database: { reachable: boolean };
  migrations: MigrationState;
}

async function databaseReachable(
  database: Queryable,
  timeoutMilliseconds: number,
): Promise<boolean> {
  try {
    await withTimeout(database.query("select 1"), timeoutMilliseconds);
    return true;
  } catch {
    return false;
  }
}

/**
 * What the platform owner checks after a deploy: the revision that is live,
 * whether it came from a clean tree, whether the database answers, and whether
 * its schema matches this build.
 */
export async function buildHealthReport(options: {
  config: ServiceConfig;
  database: Queryable;
  migrations: readonly Migration[];
  timeoutMilliseconds?: number;
}): Promise<HealthReport> {
  const reachable = await databaseReachable(
    options.database,
    options.timeoutMilliseconds ?? 2_000,
  );
  const migrations = reachable
    ? await inspectMigrations(options.database, options.migrations)
    : UNAVAILABLE_MIGRATION_STATE;

  return {
    status: reachable && migrations.state === "applied" ? "ok" : "degraded",
    revision: options.config.revision,
    cleanTree: options.config.cleanTree,
    database: { reachable },
    migrations,
  };
}
