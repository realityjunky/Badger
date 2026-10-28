# Backup and restore

Back up the database, stored files, and kernel workspaces as one recovery set.
Rehearse a restore into an isolated environment before the first real workflow,
after a storage or database change, and periodically thereafter. Each deployment
owns its schedule, scripts, destinations, and retention policy outside this
repository. This procedure applies to any deployment; ADRs [0004](adr/0004-service-state-in-postgres.md)
and [0009](adr/0009-reviewed-sql-migrations.md) describe its storage and migrations.

## What to preserve

| State                                                                  | Location                                                                  | Recovery requirement                                                                                                               |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Service records, people, bindings, audit history, and migration ledger | Postgres 17                                                               | A complete logical dump, including the migration ledger.                                                                           |
| Stored files and Runs                                                  | `BADGER_STORAGE_DIR`, including `blob/` and `runs/`                       | Preserve names, contents, ownership, modes, and directory structure.                                                               |
| Kernel workspaces                                                      | `BADGER_STORAGE_DIR/workspaces`                                           | Include its own volume or mount when it is separate from the storage root.                                                         |
| Local single-user database                                             | `BADGER_DATABASE_PATH`, default `.badger/pglite`                          | Stop the process and copy the complete PGlite directory.                                                                           |
| Standalone Projects and execution-host Runs                            | The Project's `.badger/` and declared workflow inputs                     | Back them up on their owning host; the service's mirror does not replace the authoritative Run files.                              |
| Deployment configuration and executable version                        | Deployment's configuration, secret store, image registry, Badger revision | Retain the exact images and settings needed to read the backup. Keep the platform issuer stable so people retain their identities. |

Backups contain private workflow material and identity records. Keep them outside
the repository, readable only by the backup operator, and copy completed sets to
an independently recoverable destination. An on-host copy handles application
recovery but cannot recover a lost host. Store deployment secrets separately in
the deployment's secret store; do not put credentials in manifests or logs.

## Take a consistent backup

1. Record the UTC time, Badger revision, server and database image digests, and
   the response from `/health` (including the deployment's base path). Start
   only when the database is reachable and migrations are applied. Check free
   space before the maintenance window.
2. Prevent new work and gracefully stop every process that can write this
   database, these stored files, or these workspaces. This includes server and
   worker roles and any execution host writing the same storage. Keep Postgres
   running for the logical dump. Stop the local process too when using PGlite.
   Install an exit handler that restarts the writers even if the backup fails.
3. Use a Postgres 17 client to dump the service database in custom format:

   ```bash
   umask 077
   docker exec "$database_container" pg_dump --username=badger --dbname=badger \
     --format=custom --no-owner --no-privileges > "$staging/database.dump"
   docker exec -i "$database_container" pg_restore --list < "$staging/database.dump"
   ```

   Use the deployment's database and role names. These examples use the
   container's local socket, so no password appears on a command line. Where
   authentication requires a credential, use the deployment's protected
   credential mechanism. Do not copy a running Postgres data directory as a
   substitute for a logical dump. For PGlite, copy its stopped directory instead.

4. Archive every file volume while writers remain stopped. For a named volume,
   a helper container can mount it read-only and stream its contents:

   ```bash
   docker run --rm --network none --read-only \
     --mount "type=volume,src=$files_volume,dst=/source,readonly" \
     --entrypoint tar "$database_image" \
     --numeric-owner -czf - -C /source . > "$staging/files.tar.gz"
   ```

   Repeat for a separately mounted workspace volume. A parent volume's archive
   does not include the contents of a nested volume. For bind mounts, archive
   each actual host directory, including dotfiles. A database dump alone cannot
   make a concurrently changing file tree consistent with its records.

5. Restart the writers and verify `/health` again. On failure, report the
   failed backup or failed restart and retain the previous complete sets.
6. Write a manifest with the format version, capture time, recorded image
   identities and health response, and each archive's size and SHA-256. Verify
   every archive, then atomically rename the private staging directory into a
   complete set. Schedulers and retention jobs must ignore incomplete sets.
   Preserve the three archives and manifest together; never mix capture times.

Schedule the whole operation nightly in the deployment's maintenance window,
without overlapping deployments or another backup. Record failures in the
scheduler's logs and check both the last successful run and the age of the newest
complete set. Choose retention and off-host copying for the deployment's recovery
needs; monitor space before expired sets are removed. A nightly schedule alone
does not prove that a backup succeeded.

## Restore into scratch first

1. Verify every archive's size and SHA-256 against the manifest before creating
   scratch resources. Retain the original backup unchanged.
2. Create a fresh Postgres database, fresh stored-file and workspace volumes,
   and an isolated network. Publish no database port. Use distinct names and
   prevent the scratch service from reaching production identity, notifications,
   workers, or other systems that cause side effects.
3. Restore with the matching Postgres client into an empty database:

   ```bash
   docker exec -i "$scratch_database" pg_restore \
     --username=badger --dbname=badger --no-owner --no-privileges \
     --exit-on-error < "$backup/database.dump"
   ```

   Recreate the deployment's database role through its secret mechanism.
   Restore PGlite by copying the complete stopped directory to a fresh path.

4. Extract each file archive into its corresponding fresh volume, preserving
   numeric ownership and modes. Compare the restored files to the archives
   before starting the service. Mount the workspace volume at the same logical
   path under the restored storage root. Preserve execution-host Run paths;
   do not hand-edit paths or hashes inside protected Run state.
5. Start the exact server image recorded in the manifest. In scratch, local
   single-user mode with loopback binding can inspect the restored database
   without contacting the production identity provider. Probe from inside its
   isolated container, with an allowed Host header. Require `/health` to answer
   200 with the recorded revision, a reachable database, and applied migrations.
   Check representative restored records through the signed-in HTTP API.
   Health on an empty database is insufficient evidence for restored records.
6. Verify a sample workflow using the kernel's public WorkflowRuntime. The
   service's workflow-building API is still planned; a synthetic kernel Run
   tests the delivered runtime without pretending that API exists. Build the
   kernel, then in a scratch workspace run:

   ```bash
   node docs/examples/restore-smoke.mjs start /scratch/workspaces/restore-smoke
   ```

   With writers stopped, archive that workspace volume and restore it into
   another fresh volume at the same logical path. In a fresh process run:

   ```bash
   node docs/examples/restore-smoke.mjs resume /scratch/workspaces/restore-smoke
   ```

   The example recovers the exact persisted pending action and completes the
   synthetic Run through WorkflowRuntime. It performs no publication, human
   sign-off, or domain execution. Also check a representative existing workflow
   when real workflows exist.

7. Record the backup identity, rehearsal time, image identities, health result,
   representative-record check, archive comparisons, and sample Run outcome.
   Remove only the scratch resources created by the rehearsal. Check production
   health after the rehearsal.

## Recover production

The operator chooses the complete recovery set and confirms the recovery window
before replacing production state. Stop and fence all writers, preserve the
current volumes for investigation, and restore into new volumes using the
rehearsed procedure. Start with the recorded executable version and confirm
health, representative records, file availability, and workflow recovery before
reopening access. Restore identity configuration from its protected source and
verify sign-in and roles. Upgrade afterwards through the deployment's normal
gate. Shipped migrations are immutable and forward-only: an older image cannot
be used against a database that already applied newer migrations.

If any check fails, keep access closed and the previous volumes intact. Record
what failed and choose another complete set or fix the deployment; do not repair
protected workflow state with direct file or SQL edits.
