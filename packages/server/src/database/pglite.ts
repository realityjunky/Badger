import { PGlite, type Transaction } from "@electric-sql/pglite";
import type { Database, Queryable, QueryResult } from "./database.js";

function wrapTransaction(tx: Transaction): Queryable {
  return {
    query: async <Row extends object>(
      sql: string,
      params: readonly unknown[] = [],
    ): Promise<QueryResult<Row>> => {
      const result = await tx.query<Row>(sql, [...params]);
      return { rows: result.rows, rowCount: result.affectedRows ?? 0 };
    },
    exec: async (sql: string): Promise<void> => {
      await tx.exec(sql);
    },
  };
}

/**
 * Opens PGlite for tests and local single-user mode. Without a directory it
 * keeps everything in memory, which is how each test suite starts fresh.
 */
export async function openPgliteDatabase(dataDir?: string): Promise<Database> {
  const pglite = dataDir ? new PGlite(dataDir) : new PGlite();
  await pglite.waitReady;

  return {
    query: async <Row extends object>(
      sql: string,
      params: readonly unknown[] = [],
    ): Promise<QueryResult<Row>> => {
      const result = await pglite.query<Row>(sql, [...params]);
      return { rows: result.rows, rowCount: result.affectedRows ?? 0 };
    },
    exec: async (sql: string): Promise<void> => {
      await pglite.exec(sql);
    },
    transaction: async <T>(work: (tx: Queryable) => Promise<T>): Promise<T> =>
      pglite.transaction(async (tx) => work(wrapTransaction(tx))),
    close: () => pglite.close(),
  };
}
