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
- the deterministic Workflow Node-to-Engine-step mapping;
- the versioned structured-finding catalog.

Revisioned branch packages additionally carry capability version and resolver
plan identities. The Run state retains the logical revision, current Cycle,
current Attempt, Cycle ledger, visit ledger, retry context, immutable artifact
version ledger, and append-only selection ledger.

Phase 4 packages additionally carry a versioned durability profile containing
enabled capabilities, record bounds, record schema versions, and the finding
catalog version. That profile is included in the protocol hash, compiled
package metadata, resolver-plan hash, and execution identity. Phase 4 machine
and decision submissions must include the observed Run id, logical revision,
pending action id, and complete execution identity.

The logical revision starts at `0` and advances exactly once for each accepted
machine outcome or decision response. Rejected, stale, or route-blocked
submissions leave the revision and pending Attempt unchanged.

For Phase 4 submissions, an exclusive protected revision claim is created for
the expected revision/action and intended next revision. The claim is checked
again immediately before durable mutation and the Run state write performs a
second protected compare-and-swap check. A competing, stale, replayed, or
cross-Run envelope returns a blocked continuation with the current revision,
current action identity, and a stable `revision-conflict` finding.

The Creator evaluation report additionally records the generated package tree
hash. Review readiness rejects missing, stale, mismatched, or incomplete
identity evidence.

## Certification run

`eval` retains the Phase 2 certification for the generated package and adds a
separate synthetic Phase 3 package. The fixture is generated in a disposable
temporary directory and contains a machine-derived conditional branch, a
scoped authorized decision, a terminal choice, a declared bounded Cycle, a
repeated review Node, a rework Attempt, and Attempt- and Run-lifetime artifacts.
It has no biological inputs, host services, network access, or dependency on
the protected upstream checkout.

The Phase 3 run starts through a generated state adapter and completes through
the public WorkflowRuntime at a manual location. A second Run starts through
the public runtime and completes through generated adapters at a standalone
location. Equivalent manual and standalone Runs are also compared. Fresh
process recovery is checked at a pending machine action, an awaiting decision,
after the accepted scoped receipt and branch, between Cycle instances, and at
terminal completion.

The certification records every continuation disposition, route and identity
reconciliation, Cycle and Attempt ledger, immutable artifact version and
carry-forward selection, Decision Receipt, generated projection, and required
negative case. It records the evaluated package tree hash separately from the
generated fixture tree and fixture execution identity; neither identity is
silently substituted for the other. Rejected submissions must preserve the
committed continuation. Readiness requires all evidence to be complete and
current for the evaluated package hash.

The Phase 2 linear certification remains the compatibility gate for legacy
packages. Phase 3 certification does not publish or install generated Skills,
authorize biological execution, start Native-derived durability work, or
migrate Primer Designer.

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

Continuations and generated projections also carry deterministic structured
findings, truncation summaries, and the catalog version. Legacy blocker strings
are derived from blocked findings and are retained only for compatibility.
