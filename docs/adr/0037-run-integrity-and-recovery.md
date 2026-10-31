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
from the published package's directory hash. The service never recompiles routes
or decides which transition is legal.

Decision provenance is checked against immutable dashboard gate answers, including
the exact pending action, revision, Attempt, Cycle, choice, inputs, scope,
rationale, and reviewer attestation. Repair and finalization decisions use their
kernel event forms. Unattested events remain in the immutable mirror with a
finding; rejecting them would permanently prevent subsequent evidence arriving.
A later snapshot or local recovery cannot fabricate the missing human answer.

Recovery runs only through the Operator's local WorkflowRuntime. A separate
protected MCP queue records recovery notices and request identities, including
when an unfinished transition prevents exporting a committed report. Reconnects
retry them. Only the registered person and Agent host can report them. Complete
reports settle gaps once the reported horizon is covered and package mismatches
once the bound identity is restored. A recovery request also settles an explicit
interruption notice. Outcomes and audits are idempotent by Run and request ID;
replaying an older outcome cannot clear a newer interruption. Remaining integrity
or runtime recovery findings make the outcome blocked, and the dashboard keeps
them visible.
