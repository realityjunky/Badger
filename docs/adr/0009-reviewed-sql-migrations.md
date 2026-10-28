# Apply Reviewed SQL Migrations at Startup Under a Lock

Status: accepted. The server's schema is a numbered series of reviewed SQL files in `packages/server/migrations/`, applied forward only. At startup, before it opens its socket, the server takes a transaction-scoped Postgres advisory lock, applies every pending migration in one transaction, and records each migration's SHA-256 checksum. It refuses to start when an applied migration's SQL has changed, when the database records a migration this build does not contain, or when a pending migration is older than one already applied. PGlite runs the same SQL in tests and local single-user mode, and the health endpoint reports the same migration state.

Several server and worker processes may start against one database at once, and each must find the schema exactly where its build expects it. Reviewed SQL keeps the schema readable in review and identical on Postgres and PGlite.

## Consequences

- A migration that has shipped, meaning a deployment applied it or a release contains it, is never edited; a change goes in a new numbered migration.
- Rolling back to an older image fails once a newer migration is applied, so a bad release is fixed by rolling forward.
- A failed migration leaves the schema as it was, because the pending migrations commit together.
- Only Postgres can show the lock working, since PGlite serves one connection; the suite's Postgres 17 run covers it.

## Considered Options

- Down migrations for rollbacks. Rejected: a reverse script is rarely exercised and can lose data, while rolling forward is the one path that is always tested.
- A migration framework, or a schema generated from TypeScript types. Rejected: the runner is one small module, and reviewed SQL is the contract that issue #24 asks for.
- A lock row in a table. Rejected: an advisory lock needs no table before the first migration, and Postgres releases it when the transaction or the connection ends.
