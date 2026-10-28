import pg from "pg";
import type { Database, Queryable, QueryResult } from "./database.js";

type PgQueryable = {
  query: (
    sql: string,
    params?: unknown[],
  ) => Promise<{ rows: unknown[]; rowCount: number | null }>;
};

function wrapQueryable(queryable: PgQueryable): Queryable {
  return {
    query: async <Row extends object>(
      sql: string,
      params: readonly unknown[] = [],
    ): Promise<QueryResult<Row>> => {
      const result = await queryable.query(sql, [...params]);
      return {
        rows: result.rows as Row[],
        rowCount: result.rowCount ?? result.rows.length,
      };
    },
    exec: async (sql: string): Promise<void> => {
      await queryable.query(sql);
    },
  };
}

export interface PostgresOptions {
  /** Told when Postgres ends an idle connection, as a restart does. */
  onConnectionLost?: (error: Error) => void;
}

export async function openPostgresDatabase(
  connectionString: string,
  options: PostgresOptions = {},
): Promise<Database> {
  const pool = new pg.Pool({ connectionString, max: 10 });
  // The pool reports a connection the server ended while it sat idle, and
  // replaces it on the next query. Unheard, that report would end the
  // process: a database restart would take the service down instead of
  // degrading /health until the database is back.
  pool.on("error", (error) => options.onConnectionLost?.(error));
  const queryable = wrapQueryable(pool);

  return {
    query: queryable.query,
    exec: queryable.exec,
    transaction: async <T>(work: (tx: Queryable) => Promise<T>): Promise<T> => {
      const client = await pool.connect();
      try {
        await client.query("begin");
        const result = await work(wrapQueryable(client));
        await client.query("commit");
        return result;
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}
