# Commit Kernel Initialization with Its Job Outcome

Status: accepted. Proposal approval binds the current approved Plan version,
Dossier version, pinned sources, and kernel proposal hash through the shared
human gate. Initialization is a durable job that records that confirmation
and rechecks it under the Workflow version lock immediately before calling
the kernel. Plan or dossier changes invalidate the proposal and cancel its
unfinished initialization jobs in the writer's transaction.

The current Creator state is the kernel's exact serialized bytes and their
hash stored in Postgres. Each initialization attempt restores those bytes in
a private kernel namespace and delegates replacement checks to the kernel.
Its state, job outcome, stage changes, and audit entry commit together. An
aborted transaction leaves a disposable namespace; a retry starts from the
last committed bytes. Writing directly over a shared state file was rejected
because a worker crash between that write and database commit could replace
the project without recording the transition. Source checks replace only the
source trees and preserve kernel state. Service plans use managed artifact
roots so a plan cannot redirect initialization writes outside its namespace.

The Engineer quotes the approved proposal hash and, for replacement, the
current Creator state hash. A person's initialization request ID identifies
the durable job across retries; it does not authorize another replacement.
The worker rechecks state identity, confirmation identity, and current plan
and source evidence. Concurrent replacements cannot consume the same state
twice. Personal access tokens may read the proposal and job history but never
approve or initialize a service project.

The kernel derives the proposal hash, so it can change without any service
write, as after a kernel upgrade. The owner's next commit then supersedes an
active approval of another proposal hash under the version lock, with the
invalidation, notices, audit, and job cancellation a writer's change causes,
before recording the new approval. Each failed or cancelled initialization is
recorded once, by the worker or by the writer whose invalidation withdrew it.
The stored plan text is authoritative over its materialized file: the file is
written through a temporary name and a rename, and a differing file, such as
one an interrupted write truncated, is rewritten from the database rather than
blocking every proposal read and initialization.
