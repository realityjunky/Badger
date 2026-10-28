# Pin Skill Versions Before Source Study

Status: accepted. A workflow version records immutable Skill version hashes as
pins. Each pin belongs to the workflow version's Group, carries a revision, and
may be replaced or removed only by an Administrator or Engineer. Upgrade
workflows may have one `upgrade-source` pin in addition to ordinary source
pins.

Changing the pin set invalidates the Sources stage and all later stages, then
queues a source-check job. Jobs live in Postgres, retain their requester,
timestamps, lease, pin-set hash, and outcome, and are claimed with row locks.
The migration emits a PostgreSQL notification for workers; a worker may poll
as a fallback when its database adapter has no notification listener.

The worker materializes each immutable tree beneath a project-relative
workflow-version workspace, writes a source manifest with project-relative
locations, and invokes the kernel's source check. The latest check is a read
model containing each source's identity, inventory, ignored files, script
effects, and blockers. A passed check marks Sources done; a blocked check keeps
Sources blocked and does not advance later stages.

The service never executes uploaded files. It reads only the content-addressed
blobs associated with the pinned hashes, so a check cannot observe a mutable
Skill entry or an unpinned file.
