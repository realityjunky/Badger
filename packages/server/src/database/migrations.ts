import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Clock } from "../clock.js";
import type { Database, Queryable } from "./database.js";

/**
 * The lock serializes schema changes across every server and worker process
 * that starts at once. It is a constant so all processes agree on it.
 */
const MIGRATION_LOCK_KEY = "8231130000000001";
const MIGRATION_FILE_NAME = /^(\d{4,})_([a-z0-9-]+)\.sql$/u;

export interface Migration {
  version: string;
  name: string;
  sql: string;
}

export type MigrationHealth =
  "applied" | "pending" | "drifted" | "ahead" | "unavailable";

export interface MigrationState {
  state: MigrationHealth;
  applied: string[];
  pending: string[];
  drifted: string[];
}

export const UNAVAILABLE_MIGRATION_STATE: MigrationState = {
  state: "unavailable",
  applied: [],
  pending: [],
  drifted: [],
};

interface RecordedMigration {
  version: string;
  checksum: string;
}

function checksumOf(sql: string): string {
  return createHash("sha256").update(sql, "utf8").digest("hex");
}

function compareMigrations(
  ordered: readonly Migration[],
  recorded: readonly RecordedMigration[],
): {
  applied: string[];
  pending: Migration[];
  drifted: string[];
  unknown: string[];
} {
  const recordedChecksums = new Map(
    recorded.map((migration) => [migration.version, migration.checksum]),
  );
  const knownVersions = new Set(ordered.map((migration) => migration.version));

  const applied: string[] = [];
  const pending: Migration[] = [];
  const drifted: string[] = [];

  for (const migration of ordered) {
    const recordedChecksum = recordedChecksums.get(migration.version);
    if (recordedChecksum === undefined) {
      pending.push(migration);
      continue;
    }
    applied.push(migration.version);
    if (recordedChecksum !== checksumOf(migration.sql)) {
      drifted.push(migration.version);
    }
  }

  const unknown = recorded
    .map((migration) => migration.version)
    .filter((version) => !knownVersions.has(version));

  return { applied, pending, drifted, unknown };
}

function orderMigrations(migrations: readonly Migration[]): Migration[] {
  const ordered = [...migrations].sort((left, right) =>
    left.version.localeCompare(right.version),
  );
  for (let index = 1; index < ordered.length; index += 1) {
    if (ordered[index]?.version === ordered[index - 1]?.version) {
      throw new Error(`Duplicate migration version ${ordered[index].version}`);
    }
  }
  return ordered;
}

async function isDirectory(candidate: string): Promise<boolean> {
  try {
    return (await fs.stat(candidate)).isDirectory();
  } catch {
    return false;
  }
}

async function bundledMigrationsDirectory(): Promise<string> {
  let directory = path.dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const candidate = path.join(directory, "migrations");
    if (await isDirectory(candidate)) {
      return candidate;
    }
    const parent = path.dirname(directory);
    if (parent === directory) {
      throw new Error("Could not find the server package's migrations/ folder");
    }
    directory = parent;
  }
}

/** Reads the reviewed SQL that ships with this build, in version order. */
export async function loadBundledMigrations(): Promise<Migration[]> {
  const directory = await bundledMigrationsDirectory();
  const fileNames = (await fs.readdir(directory))
    .filter((fileName) => MIGRATION_FILE_NAME.test(fileName))
    .sort();

  const migrations = await Promise.all(
    fileNames.map(async (fileName): Promise<Migration> => {
      const match = MIGRATION_FILE_NAME.exec(fileName);
      if (!match) {
        throw new Error(`Unreadable migration file name ${fileName}`);
      }
      return {
        version: match[1] as string,
        name: match[2] as string,
        sql: await fs.readFile(path.join(directory, fileName), "utf8"),
      };
    }),
  );

  return orderMigrations(migrations);
}

async function recordedMigrations(
  database: Queryable,
): Promise<RecordedMigration[] | null> {
  const table = await database.query<{ present: boolean }>(
    "select to_regclass('public.schema_migrations') is not null as present",
  );
  if (!table.rows[0]?.present) {
    return null;
  }
  const rows = await database.query<RecordedMigration>(
    "select version, checksum from schema_migrations order by version",
  );
  return rows.rows;
}

/**
 * Brings the database up to this build under a lock. Every pending migration
 * commits together, so a failure leaves the schema where it was.
 */
export async function applyMigrations(
  database: Database,
  migrations: readonly Migration[],
  clock: Clock,
): Promise<MigrationState> {
  const ordered = orderMigrations(migrations);

  return database.transaction(async (tx) => {
    // Take the lock before touching any catalog object, so two first starts
    // cannot race on creating schema_migrations itself.
    await tx.query(`select pg_advisory_xact_lock(${MIGRATION_LOCK_KEY})`);
    await tx.exec(`
      create table if not exists schema_migrations (
        version text primary key,
        name text not null,
        checksum text not null,
        applied_at timestamptz not null
      );
    `);

    const recorded = (await recordedMigrations(tx)) ?? [];
    const comparison = compareMigrations(ordered, recorded);

    if (comparison.drifted.length > 0) {
      throw new Error(
        `Reviewed migration SQL changed after it was applied: ${comparison.drifted.join(", ")}`,
      );
    }
    if (comparison.unknown.length > 0) {
      throw new Error(
        `The database has migrations this build does not contain: ${comparison.unknown.join(", ")}`,
      );
    }

    const latestApplied = comparison.applied.at(-1);
    const outOfOrder = comparison.pending.filter(
      (migration) =>
        latestApplied !== undefined && migration.version < latestApplied,
    );
    if (outOfOrder.length > 0) {
      throw new Error(
        `The database has a later migration applied; missing: ${outOfOrder
          .map((migration) => migration.version)
          .join(", ")}`,
      );
    }

    for (const migration of comparison.pending) {
      await tx.exec(migration.sql);
      await tx.query(
        `insert into schema_migrations (version, name, checksum, applied_at)
         values ($1, $2, $3, $4)`,
        [
          migration.version,
          migration.name,
          checksumOf(migration.sql),
          clock.now(),
        ],
      );
    }

    return {
      state: "applied",
      applied: ordered.map((migration) => migration.version),
      pending: [],
      drifted: [],
    };
  });
}

/**
 * Reports migration state without changing the database, for the health
 * endpoint.
 */
export async function inspectMigrations(
  database: Queryable,
  migrations: readonly Migration[],
): Promise<MigrationState> {
  const ordered = orderMigrations(migrations);
  try {
    const recorded = await recordedMigrations(database);
    if (recorded === null) {
      return {
        state: "pending",
        applied: [],
        pending: ordered.map((migration) => migration.version),
        drifted: [],
      };
    }
    const comparison = compareMigrations(ordered, recorded);
    const state: MigrationHealth =
      comparison.drifted.length > 0
        ? "drifted"
        : comparison.unknown.length > 0
          ? "ahead"
          : comparison.pending.length > 0
            ? "pending"
            : "applied";
    return {
      state,
      applied: comparison.applied,
      pending: comparison.pending.map((migration) => migration.version),
      drifted: comparison.drifted,
    };
  } catch {
    return UNAVAILABLE_MIGRATION_STATE;
  }
}
