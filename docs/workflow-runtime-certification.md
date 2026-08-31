# WorkflowRuntime Certification

The certification package is validated against one Engine-backed
WorkflowRuntime authority.

## Supported contract

The package supports deterministic routes, including explicitly declared
bounded Cycles. Legacy protocols retain
their linear action identity. Opted-in branch protocols declare routing fields
and allowed scalar values; exact equality and conjunction select one matching
success edge or one declared fallback. Ordinary active Nodes compile to
`invoke_skill`; explicit decision Nodes compile to `ask_user` with a stable
question, choices, bounded inputs, rationale policy, and reviewer policy.
Decision responses are revision-, action-, Node-, Cycle-, Attempt-, execution-,
choice-, and attestation-bound. Each accepted decision creates one
identity-bound receipt;
invalid and replayed responses do not mutate state. Each entry gets a
deterministic Attempt and visit ordinal; Engine retries retain the Attempt and
increment its retry ordinal. Declared Cycles require an entry Node, explicit
repeat transitions, and a finite `maxInstances` budget. Cycle identities are
stable per Run, key, and instance ordinal; an exhausted repeat returns a
non-mutating blocker. Versioned artifact declarations use Attempt lifetime by
default and may opt into Cycle or Run lifetime. Accepted updates append
content-bound versions, and later work selects exact accepted ids; incompatible
scope, stale references, and content drift block before mutation. Decision
Nodes may declare bounded artifact and evidence scope. Pending actions and
receipts carry only accepted version ids, hashes, and producer identities;
required references must be echoed by the response, optional references may be
omitted, and drift blocks acceptance before mutation. Scope references do not
add attachment storage or generalized content snapshots.

## Identity

Every Run carries one execution identity containing:

- the normalized Workflow Protocol hash;
- the compiled Engine package hash;
- the immutable Engine Skill snapshot hash;
- the deterministic Workflow Node-to-Engine-step mapping.

Revisioned branch packages additionally carry capability version and resolver
plan identities. The Run state retains the logical revision, current Cycle,
current Attempt, Cycle ledger, visit ledger, retry context, immutable artifact
version ledger, and append-only selection ledger.

The logical revision starts at `0` and advances exactly once for each accepted
machine outcome or decision response. Rejected, stale, or route-blocked
submissions leave the revision and pending Attempt unchanged.

The Creator evaluation report additionally records the generated package tree
hash. Review readiness rejects missing, stale, mismatched, or incomplete
identity evidence.

## Certification run

`eval` creates synthetic disposable Runs. It starts one through the generated
state adapter, resumes it through the generated compatibility command, checks
the generated guard and handoff identity, recovers it in a fresh process, then
resumes, submits, and completes it through the public WorkflowRuntime. It
starts a second Run through the public runtime and completes it through the
generated adapter. Required Output Schema artifacts are synthetic files in
those temporary Runs only; no biological inputs or external tools are used.

The certification passes only when all three Node orders match, package and
snapshot hashes match, generated guard and handoff identities match, every
recovery reproduces the prior continuation, both entry directions complete,
and the primary Run reaches a recovered `done` continuation.

Issue #27 adds focused synthetic public-runtime, both-location, fresh-process,
and generated-adapter tests for artifact provenance. The existing Creator
certification fixture remains linear until the combined Phase 3 lifecycle gate
owned by #29; this document does not treat focused artifact coverage alone as
complete Phase 3 certification.

## Compatibility

Generated `workflow-state.mjs`, `workflow-guard.mjs`, and
`workflow-handoff.mjs` are adapters over the bundled runtime asset. The state
document is a rebuildable projection and is never used for routing, recovery,
identity, eval truth, or readiness. A Run started through a generated adapter
can be resumed and completed through the public runtime, and a public-runtime
Run can be resumed and completed through the generated adapter.

The public `@rpamis/comet-any-private/workflow-runtime` package seam exposes
only runtime construction and the four operations `start`, `resume`, `submit`,
and `recover`. Revisioned continuations add `revision`, `attemptId`,
`visitOrdinal`, `retryOrdinal`, `cycleId`, Cycle and visit ledgers, and
decision receipt projections. Versioned continuations also project immutable
artifact versions, selection evidence, current scope-valid selections, and
bounded pending decision scope references. Awaiting decisions redact prior
evidence payloads from continuation and state projections. Compiler, Run-location,
projection, storage, and protected filesystem modules remain private
implementation details.
