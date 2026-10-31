# Keep Run integrity evidence separate from local recovery

Status: accepted.

The service records bounded integrity findings on a Run and audits each changed
finding, resolution, recovery notice, and recovery outcome. One current finding
per discrepancy class keeps the dashboard bounded; earlier evidence remains in
the Activity log. Signed-in workflow readers see the findings, and Auditors can
read both the Run and its Activity log without acquiring write access.

Event gaps and execution identity mismatches still refuse the report. A savepoint
discards every event and snapshot from that request before committing its finding
and audit entry. Registration checks execution against the kernel's compilation
of the immutable published protocol. Its runtime package identity is distinct
from the published package's directory hash. Changed installed bytes, such as a
cache an interpreter writes into the package, refuse neither registration nor
reports: their finding stays current until a registration observes the bound
bytes again. The service never recompiles routes or decides which transition is
legal.

Decision provenance is checked against immutable dashboard gate answers, including
the exact pending action, revision, Attempt, Cycle, choice, inputs, scope,
rationale, and reviewer attestation. Repair and finalization decisions use their
kernel event forms. Unattested events remain in the immutable mirror with a
finding; rejecting them would permanently prevent subsequent evidence arriving.
A later snapshot or local recovery cannot fabricate the missing human answer.

Recovery runs only through the Operator's local WorkflowRuntime. A separate
protected MCP queue records recovery notices and request identities, including
when an unfinished transition prevents exporting a committed report. Reconnects
retry them. The request is written before local recovery, and notices have stable
identities, so a lost HTTP response cannot reopen a settled interruption. Blocked
attempts report outcomes even when the kernel cannot export a committed report.
Only the registered person and Agent host can report them. Complete
reports settle gaps once the reported horizon is covered and execution identity
mismatches once the bound identity is restored. A recovery request also settles an explicit
interruption notice. Outcomes and audits are idempotent by Run and request ID.
Each recovery request binds its notice identity, so even a delayed first delivery
of an earlier outcome cannot clear a newer interruption. Remaining integrity
or runtime recovery findings make the outcome blocked, and the dashboard keeps
them visible.

An interruption can also clear outside the MCP's own recovery: through the
package's state script, another MCP process, or a transient read. So the MCP
keeps a notice until a complete report settles it, and a later recovery request
binds that notice. A complete report whose runtime needs no recovery and that
carries no request bound to the notice names the notice as settled. The service
accepts this only for its current notice, records no recovery outcome, and
audits the settlement. A settlement that names any other notice is ignored, so a
delayed or stale delivery cannot clear a newer interruption. A settled notice
cannot reopen under its own identity, so the MCP raises a new notice for any
later interruption, including one that recurs while a settlement is in flight.
