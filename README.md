# Standalone Comet-any

This repository extracts the Comet-any Creator and Engine seams from the upstream Comet checkout. It provides a focused, filesystem-based factory for creating and upgrading Skill packages, plus a private Engine foundation for loading, snapshotting, and running Engine-compatible Skills.

## Scope

The package includes:

- a shared workflow-kernel foundation behind the standalone Creator adapters;
- real local Skill discovery with stable source hashes, strict preferences, and ambiguity reporting;
- deterministic Workflow Contract normalization and validation;
- confirmed plan/state lifecycle in the standalone `.comet-any` namespace;
- generated entry and Node Skills with protocol/evidence references;
- current-hash evaluation, review approval, publication, and distribution preview;
- private Skill runtime loading, validation, content identity, and immutable snapshots;
- deterministic and adaptive Engine loop behavior with manual and standalone Run façades;
- protected Run state, pending-action, trajectory, artifact, context, and checkpoint storage;
- a public WorkflowRuntime for deterministic linear workflow start, resume, outcome submission, and recovery;
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
operations needed by callers. Run-file storage and protected filesystem
implementation modules remain internal. The Engine closure is pinned to Comet
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

Phase 2 compiles active Nodes into one deterministic Engine action per Node,
excludes disabled Nodes, and uses an explicit checkpoint for an empty route. A
successful submission checks the current Node's required Output Schema
artifacts and evidence, required Skill calls, enforced augmentations, and
guardrail evidence before advancing. Advisory augmentations remain
non-blocking. Missing prerequisites return a bounded `blocked` continuation
with the same pending action so corrected evidence can be submitted without
re-executing the Node; failed submissions use the Engine retry policy.

`recover` reconstructs the continuation from the persisted identity, Skill
snapshot, Run state, and pending action. It does not use conversation context
or generated source files, and rejects Run-id, protocol, package, snapshot, or
pending-action drift before returning a continuation.

Submissions are bound to the pending action with `actionId` and may identify
the expected Workflow Node with `nodeId`. Output Schema evidence is supplied
under `evidence`, while required Skill-call, augmentation, and guardrail proof
may use the corresponding check identifiers in `evidence.completedChecks`.
The returned continuation reports the current Workflow Node, pending Engine
action, stable Node-to-step mapping, and protocol/package/snapshot identity.
Conditional routes, ambiguous routes, cycles, and repeated Node visits are
rejected before Run state is created.

Generated workflow packages include `scripts/workflow-runtime.mjs`, a bundled
WorkflowRuntime implementation, and `scripts/workflow-state.mjs`, a thin
compatibility adapter for `init`, `status`, `next`, and `record`. The adapter
uses the runtime's persisted action and current Node, never routes from a
completed-Node list, and maintains the legacy state document only as a
rebuildable projection. `status` and `next` are read-only; rebuild a deleted
or stale projection with `status --rebuild --confirm legacy-state`. Use
`COMET_RUN_ROOT` or `--run-root` for manual Runs; use
`--project <dir> --run-id <id>` for standalone Runs.
