# Bind Run gate answers to people and runtime context

Status: accepted.

The service opens a durable Run gate when a committed mirrored continuation
contains a decision, a repair manual stop, or a finalization confirmation.
WorkflowRuntime remains the only execution authority. The service reads the
reviewer policy from the immutable published package, resolves current workflow
roles, and records a person's answer. It never chooses a route or advances a Run.

Reviewer subjects in service workflows name stable Badger person IDs. Provider
subjects alone are not globally unique, and email addresses can change. Review
authorities are the workflow roles `workflow-owner`, `engineer`, `field-expert`,
`reviewer`, and `operator`. Every authority the policy requires must be held;
when none is named, the gate is reserved for Operators. A named subject must
also hold the required authority. Administrator access alone does not fabricate
a workflow authority. Personal access tokens may read delivery for their own
registered Run and Agent host, but cannot preview or commit a human answer.

The kernel prepares answer submissions and supplies the bound Run identity,
revision, Node, Cycle, Attempt, and pending action. A person's preview hash also
binds their current attestation and exact answer. Confirmation stores immutable
answer evidence and an Activity log entry, and closes the inbox items in one
transaction. Request IDs replay the original result; different answers conflict.
Inbox inserts use the existing transactional notification channel, which
rechecks recipient authority before sending and links directly to the Run.

The MCP delivers answers only during `next` and `status`. It compares the
kernel's current binding with the answered gate, then submits the service's
attestation to WorkflowRuntime. Concurrent deliveries share one submission.
Committed progress is reconciled to the mirror after a crash, so an answer
cannot be applied again after its revision changes. Service outages leave a
gate waiting; they cannot create a human answer. A changed pending action
supersedes its open gate and closes its old inbox items. Only a Run's most
recent gate can be open or deliver an answer. A binding can recur byte for byte,
as when an edited finalization target is restored; unless the most recent gate
is open or answered for that exact binding, it gets a fresh gate and fresh inbox
items, so an earlier answer is never delivered over a later one.

Finalization reports include the kernel's canonical preview so people can
inspect the actual operations. The service verifies its hash against the pending
confirmation. The MCP refreshes finalization before delivery: changed effects
require a fresh gate and a fresh human answer. Earlier answers remain evidence
of what the person reviewed.
