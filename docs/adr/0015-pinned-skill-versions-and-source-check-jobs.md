# Pin Skill Versions Before Source Study

Status: accepted. A workflow version records immutable Skill version hashes as
pins ([#43](https://github.com/realityjunky/Badger/issues/43)). Each pin
belongs to the workflow version's Group, carries a revision, and may be
replaced or removed only by an Administrator or Engineer signed in as a person;
replacing or removing a pin quotes the revision that was read. Upgrade
workflows may have one `upgrade-source` pin in addition to ordinary source
pins, and their Sources stage stays blocked until it exists.

Changing the pin set invalidates the Sources stage and every later stage that
had progressed, cancels a queued check of the previous pin set, and queues a
source-check job. A check already running finishes, but its result is not
shown. Jobs live in Postgres and retain their requester, timestamps, lease,
pin-set hash, and outcome. Workers claim them with row locks, and a version
with a running job starts no other, so one version's kernel transitions run
one at a time. A worker renews its lease while it works. Once a lease lapses,
another worker may take the job over, and only the current claimant records
an outcome. A new job sends a PostgreSQL notification; workers also poll, which
reclaims abandoned leases and covers a notification sent while they were busy.

The worker materializes each immutable tree beneath a project-relative
workflow-version workspace, writes a source manifest with project-relative
locations that also names the upgrade source, and invokes the kernel's source
check. Each tree's identity must equal its pinned hash. The latest check is a
read model containing each source's purpose, identity, inventory, ignored
files, script effects, and blockers. A passed check marks Sources done; a
blocked check keeps Sources blocked and does not advance later stages; a
failed check leaves Sources active, and its job records the error without
storage paths.

The service never executes uploaded files. It reads only the content-addressed
blobs associated with the pinned hashes, so a check cannot observe a mutable
Skill entry or an unpinned file.

## Consequences

- A service deployment runs the worker role, the same image started with
  `packages/server/dist/src/worker.js`, against the server's Postgres and
  storage. Without it, checks stay queued.
- Local single-user mode runs the worker inside the server, because PGlite on
  disk serves one process. The worker role refuses to start without Postgres.
- Personal access tokens read pins, checks, and jobs, but pinning stays with
  people until a token scope is declared for it.

## Considered Options

- Run checks inside the request that changes a pin. Rejected: kernel
  transitions would hold HTTP requests and run concurrently for one version.
- Keep superseded queued jobs and discard their results. Rejected: they only
  delay the check that matters and fill the history with failures.
- Hold a database lock for the whole check. Rejected: it would block pin
  changes for as long as a check runs, and a stalled worker would block them
  indefinitely.
