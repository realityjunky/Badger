# Standalone Comet-any

This repository extracts the Comet-any Creator and Engine seams from the upstream Comet checkout. It provides a focused, filesystem-based factory for creating and upgrading Skill packages, plus a private Engine foundation for loading, snapshotting, and running Engine-compatible Skills.

## Scope

The package includes:

- a shared workflow-kernel foundation behind the standalone Creator adapters;
- real local Skill discovery with stable source hashes, strict preferences, and ambiguity reporting;
- deterministic Workflow Contract normalization and validation;
- confirmed plan/state lifecycle in the standalone `.comet-any` namespace;
- generated entry and Node Skills with protocol/evidence references;
- current-hash evaluation, WorkflowRuntime certification, review approval, publication, and distribution preview;
- private Skill runtime loading, validation, content identity, and immutable snapshots;
- deterministic and adaptive Engine loop behavior with manual and standalone Run façades;
- protected Run state, pending-action, trajectory, artifact, context, and checkpoint storage;
- a public WorkflowRuntime for deterministic workflow start, resume, revisioned outcome submission, and recovery;
- bounded declared Cycle execution with stable identities and append-only repeated-visit evidence;
- immutable Attempt-, Cycle-, and Run-lifetime artifact versions with protected content hashes and explicit carry-forward;
- bounded Decision Receipt scope references tied to accepted artifact and evidence versions;
- official/private differential observations for the pinned Engine behavior.

It intentionally excludes Comet Classic policy, Comet Native policy and hardening, Comet Entry, host platform installers, ambient resume routing, and external platform adapters.

## Run persistence

Run files are stored through protected, bounded, atomic adapters. Missing Run
state returns `null`; missing trajectory, pending-action, and checkpoint files
return `[]`, `null`, and `null`, respectively; missing artifacts return `{}`;
missing context returns `null`. Existing files are validated before recovery,
and unsafe references, path escapes, link traversal, oversized content, and
failed writes are rejected without replacing the last valid state.

## Standalone Run locations

Use `startStandaloneRun`, `resumeStandaloneRun`, `evaluateStandaloneRun`, and
`upgradeStandaloneRun` with a project root and a validated Run id. The adapter
maps each Run to `<projectRoot>/.comet/runs/<run-id>` and keeps the manual
Engine storage layout inside that location. It validates the id before
resolving or creating any Run path, and verifies that recovered state belongs
to the requested id. Execution, retry, snapshot, artifact, trajectory, eval,
and terminal behavior remains shared with the manual adapter.

## Development

```bash
npm install
npm test
npm run build
npm run format:check
```

The CLI is `comet-any` after `npm run build`:

```bash
node bin/comet-any.js guide --project . --json
```

See `assets/skills/comet-any/SKILL.md` for the user-facing confirmation protocol and `docs/extraction-map.md` for upstream provenance.

The public package façade plus the `@rpamis/comet-any-private/engine` and
`@rpamis/comet-any-private/workflow-runtime` subpaths export the runtime
operations needed by callers. The WorkflowRuntime subpath exposes only one
constructor and its four core operations; compiler, location, projection,
Run-file storage, and protected filesystem implementation modules remain
internal. The Engine closure is pinned to Comet
`0.4.0-beta.19` at revision `99fd7495f8b9217efbaae3a46d885f6fa7f4102a` and
contains no runtime import from the upstream checkout.

The pinned three-Skill differential harness is documented in `docs/differential-harness.md`. The Engine parity matrix and certification gate are documented in `docs/engine-phase-1-certification.md`. Both harnesses run only in disposable temporary projects and reject protected raw-data paths.

## WorkflowRuntime

`createWorkflowRuntime()` accepts a normalized `WorkflowProtocol` and exposes
`start`, `resume`, `submit`, and `recover` operations. A Run location is either
`{ kind: "manual", runRoot }` or
`{ kind: "standalone", projectRoot, runId }`; the older `runRoot` start and
target forms remain supported for manual compatibility. Both locations use
the same compiled route, completion validation, identity checks, continuation
projection, retry behavior, and recovery semantics.

The runtime compiles active Nodes into deterministic Engine actions, excludes
disabled Nodes, and uses an explicit checkpoint for an empty route. A
successful machine submission checks the current Node's required Output Schema
artifacts and evidence, required Skill calls, enforced augmentations, and
guardrail evidence before advancing. Advisory augmentations remain
non-blocking. Missing prerequisites return a bounded `blocked` continuation
with the same pending action so corrected evidence can be submitted without
re-executing the Node; failed submissions use the Engine retry policy.

Explicit decision Nodes compile to persisted `ask_user` actions. Their
continuation uses `await-user` and includes the stable decision question,
choices, bounded required-input schema, rationale policy, reviewer requirement
summary, revision, and Attempt identity. A typed decision response must match
the current revision, action, Node, Cycle, Attempt, choice, reviewer
attestation, input schema, and rationale policy. Accepted responses route only
through declared choice transitions and create one runtime-timestamped,
identity-bound Decision Receipt. Invalid, stale, replayed, and cross-kind
submissions do not mutate the Run. A decision may declare optional or required
artifact and evidence scope entries. The pending action exposes only accepted
version ids, hashes, and producer identities; responses must echo required
references and may omit optional ones. Physical artifact drift and changed
append-only evidence reject the response before mutation. Scope data is
reference-only and does not add attachment storage or generalized snapshots.

`recover` reconstructs the continuation from the persisted identity, Skill
snapshot, Run state, and pending action. It does not use conversation context
or generated source files, and rejects Run-id, protocol, package, snapshot, or
pending-action drift before returning a continuation.

Submissions are bound to the pending action with `actionId` and may identify
the expected Workflow Node with `nodeId`. Output Schema evidence is supplied
under `evidence`, while required Skill-call, augmentation, and guardrail proof
may use the corresponding check identifiers in `evidence.completedChecks`.
The returned continuation reports the current Workflow Node, pending Engine
action, current Cycle and Attempt, full Cycle and visit ledgers, stable
Node-to-step mapping, artifact version and selection ledgers, current valid
artifact selections, and protocol/package/snapshot identity.
Opted-in branch protocols declare routing fields and allowed scalar values. The
runtime supports exact equality, conjunction, one fallback edge, revisioned
outcomes, deterministic visit ordinals, and append-only Attempt evidence.
Ambiguous routes, undeclared values, undeclared graph cycles, and unreachable
required Nodes are rejected before Run state is created. Declared Cycles require
an entry Node, explicit repeat transitions, and a finite `maxInstances` budget.
First entry and accepted repeat transitions allocate stable Cycle identities
before the target Node is entered; exhausting the budget returns a non-mutating
blocker. Re-entered Nodes receive new Attempts, while Engine retries remain
within the existing Attempt.

Workflows opt into artifact provenance with the `versioned-artifacts`
capability. Output artifacts use Attempt lifetime by default and may declare
`cycle` or `run` lifetime. A successful producer action hashes one declared,
protected, bounded physical path and appends an immutable version containing
the logical artifact id, lifetime scope, producer Run/Node/Cycle/Attempt/action,
accepted revision, and runtime timestamp. Every required versioned output must
identify either one physical update under `artifacts` or one exact accepted
version under `artifactVersions`; ambient files are never captured implicitly.
Attempt-lifetime update paths include the current Attempt id as a path segment,
so repeated visits use physically isolated coordinates. The runtime never
selects an implicit latest version;
undeclared updates, incompatible scopes, unknown versions, and physical content
drift block before committed Run state changes.

Revisioned Runs start at logical revision `0`. Each accepted machine outcome or
decision response advances it once; route blockers, invalid submissions, and
stale submissions do not advance it.

Generated workflow packages include `scripts/workflow-runtime.mjs`, a bundled
WorkflowRuntime implementation, and thin `workflow-state.mjs`,
`workflow-guard.mjs`, and `workflow-handoff.mjs` adapters. State commands use
the runtime's persisted action and current Node, never route from a completed-
Node list, and maintain the legacy state document only as a rebuildable
projection. Guard verification, entry checks, completion validation, and
explicit apply all use the runtime's protocol and pending-action identity;
handoff only reads protocol metadata and the current continuation. `status`,
`next`, guard entry, dry guard exit, and handoff are read-only. Rebuild a
deleted or stale projection with `status --rebuild --confirm legacy-state`.
Use `COMET_RUN_ROOT` or `--run-root` for manual Runs; use
`--project <dir> --run-id <id>` for standalone Runs.

`eval` runs a synthetic WorkflowRuntime certification over the generated
package, including both generated-adapter and public-runtime entry paths. Its
report binds the generated-package hash to the normalized protocol hash,
compiled package hash, Engine snapshot hash, declared and observed Node order,
recovery evidence, and terminal completion. Review readiness requires this
evidence to remain current. Phase 3 branch/Attempt, decision/receipt, and
declared-Cycle behavior is covered by focused synthetic runtime tests. Artifact
versioning and scoped Decision Receipt evidence have focused public-runtime and
generated-adapter coverage; complete Phase 3 lifecycle certification,
Native-derived durability, and Primer Designer migration remain separate
follow-up tickets.

See `docs/workflow-runtime-certification.md` for the certification contract.
