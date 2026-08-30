# WorkflowRuntime Certification

Phase 2 certifies a generated workflow package against one Engine-backed
WorkflowRuntime authority.

## Supported contract

The package supports one deterministic, acyclic linear route. Every active
Workflow Node compiles to one `invoke_skill` Engine action in the declared
Node order. An empty route uses an explicit terminal `checkpoint` action.
Disabled Nodes are excluded. Conditional decisions, branches, cycles, repeated
visits, attempts, human-decision actions, and Native-derived durability are
not supported by this phase and must remain blocked until a separate proposal
and approval.

## Identity

Every Run carries one execution identity containing:

- the normalized Workflow Protocol hash;
- the compiled Engine package hash;
- the immutable Engine Skill snapshot hash;
- the deterministic Workflow Node-to-Engine-step mapping.

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

## Compatibility

Generated `workflow-state.mjs`, `workflow-guard.mjs`, and
`workflow-handoff.mjs` are adapters over the bundled runtime asset. The state
document is a rebuildable projection and is never used for routing, recovery,
identity, eval truth, or readiness. A Run started through a generated adapter
can be resumed and completed through the public runtime, and a public-runtime
Run can be resumed and completed through the generated adapter.

The public `@rpamis/comet-any-private/workflow-runtime` package seam exposes
only runtime construction and the four operations `start`, `resume`, `submit`,
and `recover`. Compiler, Run-location, projection, storage, and protected
filesystem modules remain private implementation details.
