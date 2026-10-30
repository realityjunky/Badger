export interface QueryResult<Row> {
  rows: Row[];
  rowCount: number;
}

/** Anything the service can run SQL through. */
export interface Queryable {
  query<Row extends object>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<QueryResult<Row>>;
  /** Runs one or more statements without parameters. Migrations use this. */
  exec(sql: string): Promise<void>;
}

/**
 * The service's only route to its records. Adapters run the same reviewed SQL
 * on Postgres in the container and on PGlite in tests and local single-user
 * mode. A transaction hands its work a Queryable, so nested transactions are
 * unrepresentable rather than refused at run time.
 */
export interface Database extends Queryable {
  transaction<T>(work: (tx: Queryable) => Promise<T>): Promise<T>;
  /** Waits for a database notification when the adapter supports LISTEN. */
  waitForNotification?(channel: string, signal?: AbortSignal): Promise<void>;
  close(): Promise<void>;
}

/**
 * Postgres ended the transaction as a deadlock victim (40P01) or on a
 * serialization failure (40001). It rolled back every write, so the same work
 * can run again once the competing transaction commits.
 */
export function isTransactionConflict(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "40P01" || error.code === "40001")
  );
}
