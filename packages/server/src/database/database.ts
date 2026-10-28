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
  close(): Promise<void>;
}
