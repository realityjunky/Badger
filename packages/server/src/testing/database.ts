import { randomUUID } from "node:crypto";
import pg from "pg";
import type { DatabaseConfiguration } from "../config.js";
import type { Database } from "../database/database.js";
import { openPgliteDatabase } from "../database/pglite.js";
import { openPostgresDatabase } from "../database/postgres.js";

export interface TestDatabase {
  kind: "pglite" | "postgres";
  database: Database;
  configuration: DatabaseConfiguration;
  /** Opens another connection pool to the same database; Postgres only. */
  connect(): Promise<Database>;
  /** Closes every connection and, on Postgres, drops the database. */
  drop(): Promise<void>;
}

/**
 * A fresh, empty database: in-memory PGlite, or a new database on the
 * Postgres 17 server that BADGER_TEST_DATABASE_URL names. The harness serves
 * from one; migration checks run SQL on one directly.
 */
export async function openTestDatabase(): Promise<TestDatabase> {
  const serverUrl = process.env["BADGER_TEST_DATABASE_URL"];
  if (serverUrl === undefined) {
    const database = await openPgliteDatabase();
    return {
      kind: "pglite",
      database,
      configuration: { kind: "pglite", dataDir: null },
      connect: async () => {
        throw new Error("In-memory PGlite serves one connection");
      },
      drop: () => database.close().catch(() => undefined),
    };
  }

  const name = `badger_test_${randomUUID().replaceAll("-", "")}`;
  const admin = new pg.Client({ connectionString: serverUrl });
  await admin.connect();
  try {
    await admin.query(`create database "${name}"`);
  } finally {
    await admin.end();
  }

  const url = new URL(serverUrl);
  url.pathname = `/${name}`;
  const database = await openPostgresDatabase(url.toString());
  const connections = [database];

  let dropped = false;
  return {
    kind: "postgres",
    database,
    configuration: { kind: "postgres", url: url.toString() },
    connect: async () => {
      const connection = await openPostgresDatabase(url.toString());
      connections.push(connection);
      return connection;
    },
    drop: async () => {
      if (dropped) {
        return;
      }
      dropped = true;
      await Promise.all(
        connections.map((connection) =>
          connection.close().catch(() => undefined),
        ),
      );
      const cleanup = new pg.Client({ connectionString: serverUrl });
      await cleanup.connect();
      try {
        await cleanup.query(`drop database if exists "${name}" with (force)`);
      } finally {
        await cleanup.end();
      }
    },
  };
}
