# Standalone Badger

This package contains the Badger Creator and Engine seams. It provides a focused, filesystem-based factory for creating and upgrading Skill packages, plus a private Engine foundation for loading, snapshotting, and running Badger-compatible Skills.

Badger's scope also includes a collaborative service around this kernel, so that an organization's field experts, engineers, and reviewers can build and run workflows together. The service is planned in [#24](https://github.com/realityjunky/Badger/issues/24); [Delivery status](#delivery-status) records what is built.

In the Badger repository, this is the kernel package of the npm workspace, in
`packages/kernel/`. Paths below, such as `assets/`, are relative to it; `docs/`
and `GLOSSARY.md` are at the repository root.

## Scope

The kernel package includes:

- a shared workflow-kernel foundation behind the standalone Creator adapters;
- explicit local Skill source inspection with stable hashes and ambiguity reporting;
- deterministic Workflow Contract normalization and validation;
- confirmed plan/state lifecycle in the standalone `.badger` namespace;
- versioned semantic questionnaire dossiers with traceable fact ledgers,
  resumable gaps, and deterministic authoring input identities;
- generated authoring-pending scaffolds with resumable six-lane authoring
  sessions and protocol/evidence references;
- hash-bound quick/full authoring review with deterministic self-consistency findings and composite authoring/runtime/publication readiness;
- WorkflowProtocol-bound cross-validation of authored decisions, routes, Skill Calls, Output Schemas, guardrails, recovery, and artifact selection;
- protected deterministic assembly with separate Auto-zone, Authored-zone, and
  source inventory ownership;
- generated Badger plan, check, hook-guard, and WorkflowRuntime control-plane
  scripts;
- current-hash evaluation, WorkflowRuntime certification, integrity-checked review approval, publication, and non-mutating distribution preview;
- private Skill runtime loading, validation, content identity, and immutable snapshots;
- deterministic and adaptive Engine loop behavior with manual and standalone Run façades;
- protected Run state, pending-action, trajectory, artifact, context, and checkpoint storage;
- exclusive, diagnosable per-Run mutation locks with explicit stale-owner recovery;
- a public WorkflowRuntime for deterministic workflow start, resume, revisioned outcome submission, and recovery;
- bounded declared Cycle execution with stable identities and append-only repeated-visit evidence;
- immutable Attempt-, Cycle-, and Run-lifetime artifact versions with protected content hashes and explicit carry-forward;
- bounded Decision Receipt scope references tied to accepted artifact and evidence versions;
- bounded, content-addressed physical-tree and Git-aware snapshots for explicitly declared project scopes;
- immutable, content-addressed Verification Receipts for automated checks, static inspections, and manual evidence, with bounded redacted summaries and freshness enforcement;
- evidence-bound repair episodes with finite budgets, stagnation decisions, bounded overrides, and restart-safe history;
- bounded transactional finalization for protected local writes, removes, and moves with preview, confirmation, recovery, and final receipts;
- versioned structured findings with bounded redaction, deterministic ordering, continuation dispositions, and derived legacy blockers.

The planned collaborative service adds a server, a web dashboard, the Badger MCP, and a host installer beside the kernel. They call into the kernel and never reimplement it, so WorkflowRuntime stays the only runtime authority. Everything shipped is generic: each deployment keeps its own launcher entries, reverse-proxy routes, and deploy scripts outside the repository. The kernel still excludes ambient resume routing.

## Delivery status

Delivered behavior and planned work are kept apart:

| Surface                                     | Status                  | Contract                                                                                                                                                                                 |
| ------------------------------------------- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Badger Creator and WorkflowRuntime          | Delivered               | Local workflow-kernel package creation, six-lane authoring, deterministic assembly, durable Run execution, current-hash evaluation, publication approval, and distribution preview.      |
| Collaborative service                       | Planned (#24)           | A server, a web dashboard, the Badger MCP, and a host installer around the same kernel, with organization sign-in, workflow roles, and a durable questionnaire. None of it is built yet. |
| Deployment glue                             | Outside this repository | Each deployment's launcher entries, reverse-proxy routes, and deploy scripts live with that deployment.                                                                                  |
| Automatic distribution and domain execution | Out of scope            | Distribution always needs explicit confirmation, Badger never executes domain scripts itself, and fixtures derived from protected raw data are never used.                               |

The release-facing artifact map and verification commands are in
`docs/release-artifacts.md`. It is the authoritative checklist for keeping
the formal Skill references, generated package inventory, compatibility
fixture, workflow manual, and release gate aligned. Architecture decisions,
including the service's scope, identity boundary, storage, and sign-off
rules, are recorded in `docs/adr/`; the domain language is in `GLOSSARY.md`.

## Run persistence

Run files are stored through protected, bounded, atomic adapters. Missing Run
state returns `null`; missing trajectory, pending-action, and checkpoint files
return `[]`, `null`, and `null`, respectively; missing artifacts return `{}`;
missing context returns `null`. Existing files are validated before recovery,
and unsafe references, path escapes, link traversal, oversized content, and
failed writes are rejected without replacing the last valid state.

Authoring leaves are substantive content boundaries, not free-form package edits. Entry Decision Core and Node Guidance must explain their semantic decisions, evidence, completion reasoning, red flags, and recovery behavior; decision-point leaves must distinguish genuine user decisions, automatic handling, stop conditions, and manual handoffs. Placeholder or underspecified content, undeclared route or choice references, contradictory transitions, direct Run-state instructions, alternate recovery authorities, and implicit latest-artifact selection keep assembly blocked. Cross-validation evidence is recorded separately inside the hash-bound authoring review; it does not select routes or mutate WorkflowRuntime state.

## Standalone Run locations

Use `startStandaloneRun`, `resumeStandaloneRun`, `evaluateStandaloneRun`, and
`upgradeStandaloneRun` with a project root and a validated Run id. The adapter
maps each Run to `<projectRoot>/.badger/runs/<run-id>` and keeps the manual
Engine storage layout inside that location. It validates the id before
resolving or creating any Run path, and verifies that recovered state belongs
to the requested id. Execution, retry, snapshot, artifact, trajectory, eval,
and terminal behavior remains shared with the manual adapter.

## Development

Run these from the repository root:

```bash
npm install
npm run build
npm test
npm run format:check
```

`npm test -w packages/kernel -- test/<file>.test.ts` runs one test file.

The user-facing entrypoint is `/badger-create` in an Agent. The Agent supplies each source Skill by
name and location; Badger inspects only those declarations. The CLI is `badger` after `npm run build`;
from the repository root, run it as `node packages/kernel/bin/badger.js`:

```bash
# Candidate inspection is read-only and closed-world.
node packages/kernel/bin/badger.js candidates --skill primer-design=./skills/primer-design --json
node packages/kernel/bin/badger.js guide --project . --json
node packages/kernel/bin/badger.js questionnaire-handoff dossier.json --plan plan.json --project . --json
node packages/kernel/bin/badger.js authoring-plan prepared-workflow --project . --depth quick --json
node packages/kernel/bin/badger.js generate prepared-workflow --project . --depth full --json
node packages/kernel/bin/badger.js authoring-status prepared-workflow --project . --json
node packages/kernel/bin/badger.js authoring-dispatch prepared-workflow --lane script --output /tmp/script.json --project . --json
node packages/kernel/bin/badger.js assemble prepared-workflow --confirm --project . --json
node packages/kernel/bin/badger.js migrate prepared-workflow --confirm --project . --json
```

`badger review <name> --json` reports distinct authoring, runtime, and publication readiness. The `skill-review` lane records quick or full authoring evidence; full review requires three independent voter records and all four review lenses. Deterministic self-consistency and WorkflowProtocol cross-validation findings never replace provider findings or WorkflowRuntime certification. `badger approve` records only human publication approval after authoring, evaluation, and WorkflowRuntime evidence are current.

Library callers that coordinate authoring across processes should use `authoringSessionGateway()`. Its persisted session identity, revision-aware lane decisions, readiness, recovery, lock inspection, and `writeGate()` results are the authoritative surface; recording requires `confirmed: true`, and assembly requires `--confirm` at the CLI or `confirmed: true` through the gateway.

`authoring-plan` is read-only. It accepts a confirmed workflow name after
initialization, derives the six-lane AuthoringPlan from the persisted normalized
proposal, and reports separate
`protocolHash` (AuthoringProtocol) and `workflowProtocolHash` (executable
WorkflowProtocol) identities. It does not create Creator state, authoring
records, or package files.

See `assets/skills/badger-create/SKILL.md` for the user-facing confirmation protocol and `docs/release-artifacts.md` for release status.

`generate` creates a deterministic scaffold and an authoring session under
`.badger/authoring/<name>`. The scaffold remains visibly pending until all
current lane records are submitted with `authoring-record` and the package is
assembled. Use `authoring-dispatch` to create a bounded file handoff for a
lane; the handoff exposes role-brief, input, output, dependency, and hash paths
but no Creator-state, execution, publication, distribution, or credential
authority. Submit the returned JSON with `authoring-record`; pass the status
revision with `--expected-revision` when coordinating concurrent lanes.
Authoring input, authored material, scaffold, and assembled package hashes are
stored separately; source changes retain old records as explicit stale evidence
instead of silently treating them as current. Status output includes completed
lanes, executable dependency waves, claims, artifacts, findings, and fresh-
process recovery paths. A deterministic manual file-provider fixture is
available through the exported `runManualAuthoringFixture` API for tests and
local certification without provider credentials.

Legacy deterministic drafts without an authoring session are classified
`legacy-scaffold-only`. They remain readable compatibility artifacts but are
not authoring-complete or publishable. `badger migrate <name> --confirm`
preserves the draft as source evidence, writes a sibling authoring package,
records retained, replaced, and wrapped source decisions, and requires all six
current lanes before assembly.

Assembly rebuilds a staged scaffold, validates every current lane artifact, and
swaps it into place only after the complete package passes the deterministic
inventory and control-plane checks. The generated
`reference/package-inventory.json` records relative paths and ownership
(`auto`, `authored`, or `source`); the typed `GeneratedPackage.inventory`
additionally carries byte counts and hashes.

The public package façade plus the `@realityjunky/badger/engine` and
`@realityjunky/badger/workflow-runtime` subpaths export the runtime
operations needed by callers. The WorkflowRuntime subpath exposes only one
constructor and its four core operations; compiler, location, projection,
Run-file storage, and protected filesystem implementation modules remain
internal.

## Authoring references

The installed Badger Skill keeps the package-construction contract close to its
entrypoint:

- `assets/skills/badger-create/reference/authoring-protocol.json` defines the
  machine-readable lane DAG and deterministic backbone.
- `assets/skills/badger-create/reference/authoring-subagents.md` defines bounded file
  handoffs and the six role briefs.
- `assets/skills/badger-create/reference/bundle-authoring.md` describes scaffold,
  assembly, content leaves, and upgrade-existing behavior.
- `assets/skills/badger-create/reference/authored-zone-example.md` shows the required
  level of substantive Decision Core and Node Guidance content.
- `assets/skills/badger-create/reference/eval-provider.md` separates authoring review,
  deterministic evaluation, WorkflowRuntime certification, and publication
  approval.
- `assets/skills/badger-create/reference/package-inventory.example.json` shows the
  safe relative-path and ownership view of an assembled package.

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
summary, revision, execution identity, and Attempt identity. A typed decision
response must match the current revision, action, Node, Cycle, Attempt,
protocol/package/snapshot identity, choice, reviewer attestation, input schema,
and rationale policy. Accepted responses route only
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

Workflows may opt into the `content-snapshots` durability capability with a
hash-bound physical-tree or Git snapshot policy. The policy declares a
provider, optional physical-tree fallback, include and exclude patterns, plus
file-count, file-size, total-size, manifest-size, traversal, duration, and
omission-detail limits. Git capture enumerates tracked, dirty, staged,
deleted, and selected untracked paths, then hashes the current working-tree
bytes; commit, index, and status identities are supplemental evidence only.
Captured entries contain only safe relative paths, sizes, and SHA-256 content
hashes; raw file contents are never placed in a manifest. Symlinks,
non-regular files, nested repository boundaries, selection races, provider
errors, and overflow produce bounded incomplete evidence. Git and physical-tree
captures of the same complete bytes have the same provider-independent content
identity, while an actual fallback is explicit in that identity. Snapshot
references are stored through the same protected lock and transition journal
as the Run mutation and recover identically in manual and standalone
locations. Repository-owned protected roots must be supplied by the host and
are rejected before provider enumeration if the declared scope would select
them.

Profiles that enable `repair-policy` declare a finite failure budget, warning and
manual-stop thresholds, allowed retry/stop/contract-change choices, and an
optional one-time override bound. Failed machine outcomes are reduced to a
canonical signature containing protocol and execution identity, Attempt context,
finding and receipt coverage, scope, snapshot, and artifact identities; prose,
timestamps, and retry action ids do not reset an episode. The second equivalent
failure warns, the manual-stop threshold creates a persisted repair `ask_user`
action, and the hard maximum blocks without an override. Repair history is
bounded and checked against the append-only trajectory during recovery. An
accepted retry decision continues the same Attempt, while contract change stops
the captured Run without rewriting its protocol identity.
The normalized policy registers the bounded idempotent `workflow.resume`
operation; automatic retry action materialization dispatches through that
operation inside the same locked transition journal.

Each continuation also carries the versioned `findings` catalog and its
`findingSummary`. Findings are bounded, deterministically ordered, redacted,
and expose registered runtime operations as argument arrays. `blockers` remains
only a compatibility projection for blocked continuations; callers should use
finding codes, required actions, and `requiresUserDecision` instead of parsing
messages.

Submissions are bound to the pending action with `actionId` and may identify
the expected Workflow Node with `nodeId`. Phase 4 submissions additionally
carry the observed `runId`, logical `revision`, and complete `execution`
identity. The runtime checks those values before validation and again at the
protected compare-and-swap boundary; a conflicting submission returns the
current continuation with a structured `revision-conflict` finding and does
not change committed Run records. Each accepted Phase 4 transition leaves a
protected transition-addressed revision claim, so replaying the same transition
cannot advance the Run twice. Output Schema evidence is supplied
under `evidence`, while required Skill-call, augmentation, and guardrail proof
may use the corresponding check identifiers in `evidence.completedChecks`.
Phase 4 mutations are first staged behind a protected write-ahead journal at
`.badger/transition-journal.json`. The journal records the operation, execution
identity, revision/action boundary, and exact previous and intended material for
each affected Run record. `resume` and `submit` return a `recovery-required`
finding while that journal is pending; only explicit `recover` classifies each
record as previous, intended, or unknown, rolls forward known mixtures, and
appends one bounded `recovery_reconciled` event. Unknown material remains
untouched and blocks recovery.
Profiles that enable `mutation-locks` additionally serialize every mutating
`start`, `resume`, `submit`, and `recover` operation through
`.badger/run-lock.json`. Lock owners carry bounded operation, process, host, and
creation-time metadata. Active, foreign, malformed, oversized, or replaced
locks return structured findings and are never stolen; only `recover` may
quarantine a lock whose local owner process is proven absent. Release checks
the owner token and file identity, and takeover evidence is appended to
`.badger/run-lock-recovery.jsonl` before journal recovery continues.

Profiles that enable `verified-checkpoints` additionally publish a bounded
content-addressed manifest and checkpoint record after each committed logical
mutation. The manifest binds the Run revision, execution identity, pending
action, Node, Cycle, Attempt, state identity, trajectory offset and prefix
hash, and referenced artifact version hashes and sizes. Recovery prefers a
fully verified authoritative Run head; it selects or restores an older
checkpoint only when the transition journal is settled and the live trajectory
proves that no later transition committed. Invalid checkpoint candidates and
ambiguous history remain structured findings. Checkpoint restoration uses a
protected recovery journal, appends one `recovery_reconciled` event, and keeps
retention bounded without evicting an active recovery anchor.

Checkpoint manifests and records contain identities and references, not copied
artifact contents. Generated adapters continue to delegate checkpoint
selection and restoration to the bundled WorkflowRuntime.

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
Use `BADGER_RUN_ROOT` or `--run-root` for manual Runs; use
`--project <dir> --run-id <id>` for standalone Runs.
Lock coordination remains private to the bundled runtime; generated adapters
cannot acquire, release, diagnose, or recover locks independently.
Generated state and guard adapters may forward `status: "failed"` outcomes and
repair decision payloads; they do not evaluate budgets, signatures, overrides,
or stop conditions.

`eval` runs the Phase 2 certification over the generated package and separate
synthetic Phase 3 and Phase 4 lifecycle certifications. A durability-declaring
package receives the Phase 4 stop/go matrix over one generated synthetic
package. The report binds the evaluated package hash to the normalized
protocol, compiled package, immutable Engine snapshot, resolver-plan,
capability, Node/action, route, Cycle, Attempt, artifact, decision, snapshot,
receipt, checkpoint, repair, transaction, final-receipt, projection,
fresh-process, concurrency, and source-integrity evidence. Evaluated-package
and synthetic-fixture tree hashes remain distinct. Review readiness fails closed
on missing, stale, mismatched, truncated, or incomplete Phase 4 evidence.
The fixtures use only disposable synthetic files and do not authorize domain
execution or package installation.

See `docs/workflow-runtime-certification.md` for the certification contract.
