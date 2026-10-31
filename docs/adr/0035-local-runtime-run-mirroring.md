# ADR 0035: Local runtime authority and durable Run mirroring

Status: Accepted

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

The kernel exports a stable committed Run report containing its unchanged
continuation, projection, issued artifact receipts, and original trajectory
stream with sequence numbers. The adapter reconciles its queue from that stream
on later calls and retries. Losing the queue after a committed transition cannot
lose the event. Registration is idempotent for its fixed identity; event storage
is immutable and unique by Run and sequence. Changed duplicate bytes, gaps,
identity changes, malformed read models and explicit size limits are refused.
Outcome summaries retain the most recent 256 entries with explicit total and
omission counts. Original events remain complete and readable in ordered pages;
summary bounds never prevent a valid long Run from advancing its mirror.
The observer never evaluates legal routes, Completion, Cycles or Attempts.

Reporting occurs independently of local committed progress, with bounded HTTP
requests and a 1 to 30 second retry backoff. Closing MCP drains its retry work and
removes its timers. A live connection that previously checked its exact bound
identity can continue through a connection outage. A fresh connection must check
the person, role and scope before operating that Run. Rejected authorization
never becomes an offline permission. Human decisions, overrides, manual-stop,
manual verification and finalization confirmations are absent from the machine
submission schema; pending human actions return dashboard links until gate
answer delivery is implemented.

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
with a reporting error. Deep gate attestation and Run integrity workflows remain
separate work. A pending interrupted kernel transition still requires explicit
recovery; reporting does not silently commit it. Active replacement of the
transition journal, Run state, or trajectory is handled by retrying only typed
changed-file reads, a bounded number of times, preserving all protected-file
validation and never replaying a submitted mutation with a newer revision.
