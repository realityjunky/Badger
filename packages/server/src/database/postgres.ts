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

  // LISTEN holds a connection of its own, outside the pool, opened by the
  // first wait. When Postgres ends it, its waiters wake and the next wait
  // opens another, so a restart never leaves a worker asleep or crashes it.
  let listener: { client: pg.Client; ready: Promise<void> } | null = null;
  const listening = new Set<string>();
  let closed = false;
  const openListener = () => {
    const client = new pg.Client({ connectionString });
    const entry = { client, ready: client.connect().then(() => undefined) };
    const drop = () => {
      if (listener !== entry) return;
      listener = null;
      listening.clear();
    };
    client.on("error", (error) => {
      drop();
      options.onConnectionLost?.(error);
      void client.end().catch(() => undefined);
    });
    client.on("end", drop);
    entry.ready.catch(drop);
    return entry;
  };

  const waitForNotification = async (
    channel: string,
    signal?: AbortSignal,
  ): Promise<void> => {
    if (!/^[a-z_][a-z0-9_]*$/u.test(channel))
      throw new Error(`Invalid notification channel: ${channel}`);
    if (closed || signal?.aborted) return;
    listener ??= openListener();
    const { client, ready } = listener;
    await ready;
    if (!listening.has(channel)) {
      await client.query(`listen ${channel}`);
      listening.add(channel);
    }
    await new Promise<void>((resolve) => {
      const wake = () => {
        client.off("notification", onNotification);
        client.off("error", wake);
        client.off("end", wake);
        signal?.removeEventListener("abort", wake);
        resolve();
      };
      const onNotification = (message: pg.Notification) => {
        if (message.channel === channel) wake();
      };
      client.on("notification", onNotification);
      client.on("error", wake);
      client.on("end", wake);
      signal?.addEventListener("abort", wake, { once: true });
      if (signal?.aborted || listener?.client !== client) wake();
    });
  };

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
    waitForNotification,
    close: async () => {
      closed = true;
      const open = listener;
      listener = null;
      await open?.client.end().catch(() => undefined);
      await pool.end();
    },
  };
}
