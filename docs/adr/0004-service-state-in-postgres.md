# Keep Service-Owned State in Postgres

Status: accepted. The service keeps its records in Postgres 17, in its own container with its own volume; tests and local single-user mode use PGlite. The job queue is a table in the same database, using row locks and woken by Postgres notifications. Every mutable record carries a revision, so a stale write gets a conflict carrying the current revision instead of overwriting. Stored files, such as Skill version trees and packages, are content-addressed by SHA-256.

Today's Creator state is one file per workflow that commands read, modify, and write without a lock: the last writer wins, confirmations record no actor or time, and each evaluation report replaces the last ([handoff](../handoffs/primer-designer-phase1-2026-10-27.md), F19). Several people working on one workflow need transactions, revisions, history, and an audit trail. PGlite runs the same migrations in-process, so each service suite starts from a fresh database without a server.

## Consequences

- Each workflow version gets its own kernel workspace, built from its pinned Skill versions with project-relative paths, and kernel transitions for one workflow version run one at a time through the queue.
- A Run's root on its execution host stays authoritative for that Run. The service keeps the mirrored events, receipts, and gates, and flags mismatches, but never advances a Run itself.
- The local CLI keeps working on its file store.

## Considered Options

- Keep the `.badger` file store as the service's state. Rejected because it has no locking, history, or actor (F19), and its absolute paths break when a project moves (F4).
