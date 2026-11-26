# Enforce workflow approvals and pinned verifier results

Status: implemented.

The Plan declares the decisions that must already be current when a Node
starts. A Node's optional `approvalRequirements` names the Decision ID,
required choice and Run or Cycle artifact IDs that the Decision must cover.
The Plan normalizer and the runtime compiler validate the declaration against
active Decision Nodes and required artifact scopes. WorkflowRuntime looks up
the latest Decision Receipt, checks its Attempt and each artifact's producer
Attempt, and verifies the selected bytes. It checks the destination before
committing a transition and checks the active Node during inspection and
submission. A missing or stale approval leaves a reason on the pending
action. A permitted route with a different destination can have its own
requirements.

An automated guardrail may declare `verification.verifierPin` with the SHA-256
of its executable and the public key of its trusted verifier. The existing
Verification Receipt submission accepts an Ed25519 signature over the
normalized result, executable digest, execution identity, Run revision,
action and artifact scope. WorkflowRuntime checks the signature before
satisfying the guardrail and when reloading stored receipts. The trusted
verifier owns the private key and must verify the executable's bytes before
running it. The setup for that verifier belongs to the host or workflow
deployment. [Verification Receipt contract](../workflow-runtime-certification.md)

The generated hook checks the active WorkflowRuntime action. Host event
registration requires an actual host event and supported host adapter.
WorkflowRuntime enforces the declarations when the package is driven through
the standard runtime operations or the generated guard.
