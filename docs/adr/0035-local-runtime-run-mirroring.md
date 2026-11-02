# Local runtime authority and durable Run mirroring

Status: accepted.

## Context

Published workflows run on a person's computer through the local Badger MCP.
The service must observe progress during intermittent connectivity, while every
runtime refusal and root/Attempt binding continues to come from WorkflowRuntime.
A process can die after the runtime commits but before an adapter writes its
reporting queue. Personal tokens and Agents cannot supply human sign-off.

## Decision

The MCP fetches immutable publication bytes and verifies the kernel package
snapshot before starting. The signed-in person's identity, local Run ID, machine
label, Agent host, deployment URL, publication ID and publication package hash are
persisted in a start intent before calling WorkflowRuntime. Runtime acceptance
precedes service registration. A Run-local binding and queue contain no token and
reject links, junctions and path traversal. Root requirements and Completion
plans are kernel read models, and only start accepts external root bindings.

The kernel exports a stable committed Run report containing its bounded
continuation, projection, issued artifact receipts, and original trajectory
stream with sequence numbers. The adapter reconciles its queue from that stream
on later calls and retries. Losing the queue after a committed transition cannot
lose the event. Registration is idempotent for its fixed identity; event storage
is immutable and unique by Run and sequence. Changed duplicate bytes, gaps,
identity changes, malformed read models and explicit size limits are refused.
Snapshot limits come from the kernel: 256 entries per observation ledger and
per Attempt's outcomes, and 1 MiB for the projection and continuation together.
Older observation evidence is shortened to that budget; execution identity and
pending gate context stay intact. `snapshotCompacted` states that full evidence
must be read from the unchanged original events. A refused bounded snapshot keeps
the previous snapshot and still commits that request's valid events, returning
`snapshotRejected` with the exceeded bound. Malformed models and integrity
violations retain their existing refusal behavior.
A large finalization preview travels outside the snapshot pair, referenced by
its exact plan hash and operation count. The service parses the original preview
and stores it with the human gate, so the person still reviews every operation.
Preview bytes are limited to 16 MiB and the complete request to 18 MiB; ordinary
event batching remains about 768 KiB.
Outcome summaries retain the most recent 256 entries with explicit total and
omission counts. Original events remain complete and readable in ordered pages;
summary bounds never prevent a valid long Run from advancing its mirror.
The observer never evaluates legal routes, Completion, Cycles or Attempts.

Registration compares the service's cursor with the durable acknowledgement and
rewinds it after a restore, replaying missing original events idempotently. The
Run root's `.badger/mcp-queue.lock` serializes queue and recovery-file updates
across MCP processes. An interrupted owner leaves an explicit lock conflict; the
message names the file and permits manual removal only when no MCP process is
using that Run.

Submissions own an exclusive revision claim even without a durability profile.
This protects the interval between a revision check and filesystem publication
across processes. Legacy claims record their local process owner; explicit
recovery clears a prepared claim only when its hashed host identity matches the
current boot and PID namespace and its owner is proven dead. A live, remote, or
unknown owner remains protected, as ADR 0018 requires.

Reporting occurs independently of local committed progress, with bounded HTTP
requests and a 1 to 30 second retry backoff. A token rate limit pauses reporting
until its Retry-After. Closing MCP drains its retry work and
removes its timers. A live connection that previously checked its exact bound
identity can continue through a connection outage or a rate limit, which is never
a denial. A fresh connection must check
the person, role and scope before operating that Run. Rejected authorization
never becomes an offline permission. Human decisions, overrides, manual-stop,
manual verification and finalization confirmations are absent from the machine
submission schema; pending human actions return dashboard links, where people
answer them, and the MCP delivers those answers as
[ADR 0036](0036-dashboard-run-gates.md) records.

Evaluation retains script certification and invokes a trusted host-supplied MCP
certifier inside the existing sandbox. Its executable belongs to the installed
service distribution. Actual MCP SDK calls start the exact selected immutable
package and certify synthetic root bindings, receipts, Completion, routes and
Cycles; synthetic negative replies are compared with the generated script
adapter. The kernel has no MCP workspace dependency. Node HTTP supplies the
certification transport because the sandbox's JIT-less Node cannot use the
WebAssembly parser in fetch. Nested adapter processes retain JIT-less execution,
inherited resource limits and process-tree accounting.

## Consequences

The service is an observer and the local Run root remains the runtime authority.
At-least-once delivery produces one immutable service record per sequence.
Explicit bounds keep service validation auditable; oversized data stays local
with a reporting error. Gate attestation is recorded in
[ADR 0036](0036-dashboard-run-gates.md), and Run integrity and recovery in
[ADR 0037](0037-run-integrity-and-recovery.md). A pending interrupted kernel
transition still requires explicit recovery; reporting does not silently commit
it. Active replacement of the transition journal, Run state, or trajectory is
handled by retrying only typed changed-file reads, a bounded number of times,
preserving all protected-file validation and never replaying a submitted
mutation with a newer revision.
