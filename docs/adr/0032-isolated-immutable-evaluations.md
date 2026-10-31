# Retain Immutable Evaluation Evidence Without Mutating Authoring State

Status: accepted. A signed-in Engineer or Administrator confirms evaluation of
one assembled package hash. The service binds a durable worker job to the
package generation and exact committed Creator state. Personal tokens can read
status through the Engineer MCP profile but cannot start evaluation.

The worker clones the kernel state and calls the public evaluator without
persisting Creator state. Each attempt owns a unique report directory under
`.badger/evaluations/` in the fixed Project root. Certification runs outside a
database transaction, so progress remains readable and upstream edits remain
available. Completion rechecks the lease, current package bytes and committed
state under the Workflow version lock. It commits the append-only report,
outcome, stage change, audit and starter's inbox item together. A rollback
leaves the committed Authoring session and package bytes unchanged. A retry
uses another attempt directory. SQL rejects updates and deletes of reports.

Reports retain all kernel checks, Authoring cross-validation and runtime
certification evidence, including each phase's negative cases. Earlier reports
remain available when upstream changes invalidate a package. Queued jobs are
cancelled immediately. A running worker can retain its eventual result as
superseded; that result cannot satisfy current readiness.

Publication readiness overlays a passing report for the current package
generation and assembled hash onto a clone of the committed Creator state,
then delegates to kernel `reviewState`. The report file stays inside the
Project so the kernel can verify the persisted evidence. The service never
recreates the kernel's certification or publication predicates. The recorded
Creator state hash is provenance and a worker completion fence; later review
metadata need not invalidate evaluation of unchanged package bytes.

All certification child-process paths share one opt-in kernel boundary. The
service requires Linux and `/usr/bin/prlimit` (util-linux, included in the
service image), and fails closed when unavailable. Every Node adapter inherits
a 512 MiB `RLIMIT_DATA` allocation bound and disabled core dumps, and runs with
JIT disabled to avoid V8's large executable-memory reservation. A 10 ms monitor
accounts for aggregate resident memory of the adapter and its descendants and
kills their process group above 512 MiB. This aggregate threshold is sampled;
individual allocation bounds are enforced by the operating system. Every child
has at most 15 seconds of wall time and 4 MiB of combined output; the evaluation
has a 180-second certification deadline shared by all children. Timeout, memory,
output, or accounting failures terminate the entire child process group and
every descendant the adapter's process tree still lists. A child whose
descendant holds its output open more than a second after the adapter exits
fails, so the evaluation never waits on that descendant.

Only PATH and explicit synthetic certification inputs reach the child, together
with the controlled Node option and a private 0700 HOME/TMPDIR/TMP/TEMP directory.
Synthetic Run roots also live beneath the evaluation's private temp directory.
Generated deterministic adapters are the only scripts invoked; domain scripts
are never executed. This is a resource and environment boundary for the trusted
generated backbone, not a general-purpose executor for arbitrary uploaded code:
without cgroups, a descendant that both detaches from the process group and
outlives the adapter can still escape the kill.
Standalone CLI evaluation keeps its original defaults and persistence behavior;
the service opts into the limits and immutable destination explicitly.
