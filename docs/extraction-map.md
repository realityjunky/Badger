# Badger Extraction Map

## Upstream provenance

- Upstream checkout: `/home/hugo/AI/repos/comet`
- Upstream remote: `git@github.com:rpamis/comet.git`
- Audited upstream commit: `99fd749` (`0.4.0-beta.19`)
- Source scenario: `assets/skills/badger-create/SKILL.md`, `domains/workflow-contract/`, `domains/bundle/`, `domains/factory/`, the Creator CLI facade, and the audited Engine closure in `domains/engine/`.

## Standalone seam

| Standalone module                   | Upstream responsibility retained                                                                                                                      |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/workflow-kernel/discovery.ts`  | Explicit Skill source locations, frontmatter description, reference/script inventory, content hash, missing/ambiguous status                          |
| `src/workflow-kernel/hash.ts`       | Stable source-tree fingerprints over sorted regular files and supported symbolic links                                                                |
| `src/workflow/contract.ts`          | Workflow-kernel Node vocabulary, binding enforcement, Output Schema validation, canonical edges, run-state contract, route eval metadata              |
| `src/workflow-kernel/foundation.ts` | Shared explicit-source plan loading, candidate resolution, proposal normalization, blockers, plan hash, confirmed state, and atomic state persistence                 |
| `src/skill/find.ts`                 | Compatibility adapter to the shared discovery seam                                                                                                    |
| `src/factory/proposal.ts`           | Standalone compatibility adapter to the shared proposal seam                                                                                          |
| `src/factory/generate.ts`           | Deterministic entry/Node package generation and protocol/evidence artifacts                                                                           |
| `src/authoring/`                    | Hash-bound six-lane authoring sessions, provider-neutral file handoff, record validation, readiness, and deterministic authored-content assembly      |
| `src/factory/state.ts`              | Standalone compatibility adapter to the shared state seam and `.badger` namespace                                                                     |
| `src/eval/run.ts`                   | Current-package hash, route-conformance evidence, and WorkflowRuntime certification                                                                   |
| `src/publish/lifecycle.ts`          | Readiness, reviewer approval, hash-bound publication, and distribution preview                                                                        |
| `src/cli.ts`                        | Thin Creator-facing command interface                                                                                                                 |
| `src/skill-runtime/`                | Engine-compatible Skill types, YAML loading, validation, content identity, and immutable snapshots                                                    |
| `src/engine/`                       | Run state, resolver, loop, guardrails, evals, protected persistence, manual and standalone Run façades                                                |

## Deliberate exclusions

The upstream Creator closure also reaches `domains/comet-classic`, `domains/comet-native`, `domains/comet-entry`, `domains/skill/platform-install`, and host platform registries through the general upstream Bundle distribution path. Those policy and platform modules are not copied or imported here. The standalone seam uses local package publication and preview-only distribution instead.

The upstream `comet-five-phase-overlay` and `comet-native` built-in contracts are excluded. Only `workflow-kernel` is accepted by the standalone plan loader. The source checkout remains available for comparison and is protected from edits by the parent repository instructions.

The extracted foundation accepts a project root and state namespace. The standalone adapter fixes the namespace to `.badger`; source resolution is closed-world and fail-closed: missing, invalid, unsafe, or ambiguous declarations remain proposal blockers.

## Authoring delivery map

Badger now owns the package-construction authoring plane inside the Creator.
The six-lane `AuthoringProtocol` is restored from the pinned upstream contract;
Badger's durable records, fresh-process recovery, revision fencing, bounded
file handoff, cross-validation, and current-hash readiness are explicit Badger
extensions.

| Delivery surface | Current authority |
| --- | --- |
| Lane DAG, claims, review depth, and content leaves | `src/authoring/protocol.ts` and `assets/skills/badger-create/reference/authoring-protocol.json` |
| Plan, handoff, records, assembly, and readiness | `src/authoring/plan.ts`, `dispatch.ts`, `lifecycle.ts`, `review.ts`, and `cross-validation.ts` |
| Generated package inventory and control plane | `src/factory/generate.ts` and `reference/package-inventory.json` in each assembled package |
| User-facing role and quality guidance | `assets/skills/badger-create/reference/authoring-subagents.md`, `bundle-authoring.md`, `authored-zone-example.md`, and `eval-provider.md` |
| Compatibility and release evidence | `test/fixtures/authoring/authoring-compatibility.json`, `src/differential/authoring/`, and `docs/release-artifacts.md` |

The generated `workflow-state`, `workflow-guard`, and `workflow-handoff` files
remain adapters. WorkflowRuntime remains the only authority for executable
routes, Run state, Decision Receipts, artifact versions, and runtime recovery.
Platform or dashboard adapters are future consumers of these local contracts,
not part of the standalone package.

## Creator differential baseline

`/home/hugo/AI/Badger-workflows/primer_designer_harness/differential/primer-designer-workflow.json` is the pinned three-Skill fixture for comparing candidate resolution, source/reference evidence, source hashes, normalized workflow protocol, generated artifact inventory, and initial readiness. `/home/hugo/AI/Badger-workflows/primer_designer_harness/differential/extraction-manifest.json` records the reusable workflow-kernel closure and the deliberate Classic, Native, installer, Engine, and host-platform exclusions.

The differential runner uses disposable projects and home directories. It never builds or writes the upstream checkout, reads `primer_designer_harness/raw_data/`, executes biological resources, submits schedulers, or installs host-platform files.

## Official Engine characterization

`test/fixtures/engine/engine-characterization.json` and
`test/fixtures/engine/manifest.json` provide the Phase 0 official Engine
baseline. The fixture contains only synthetic Skills and exercises deterministic
single-step and multi-step Runs, failed outcomes and retries, pending-action
recovery, confirmation guardrails, unsafe state, manual Runs, standalone Runs,
and corrupt current-step rejection. The completed Phase 1 fixture extends that
matrix with adaptive guardrail rejection, checkpoint recovery, unsafe Run ids,
source drift, snapshot identity, compatible upgrades, and incompatible upgrades.

`src/differential/engine/` records durable Run state, pending actions, outcomes,
artifacts, trajectories, checkpoints, Skill snapshots, evals, and classified
errors from the pinned official CLI. It verifies the official revision and
compares source snapshots before and after each run. The private command
adapter executes the same fixture through the extracted public Engine façade,
and the differential report records matrix coverage and classifies exact
matches, expected packaging coordinates, and semantic mismatches. Missing
coverage or a semantic mismatch blocks certification and makes the CLI return
a non-zero exit status.

The Engine source closure is recorded as evidence in the characterization
manifest and is extracted under `src/engine/`. The official checkout remains
read-only, and the harness never reads or derives data from
`primer_designer_harness/raw_data/`.

## Private Engine closure

The extracted closure is derived from the audited imports and official
characterization at the upstream reference Engine `0.4.0-beta.19`, revision
`99fd7495f8b9217efbaae3a46d885f6fa7f4102a`:

- `src/skill-runtime/` owns the `badger/v1alpha1` Skill definition, guardrail,
  runtime-eval, YAML layout, validation, hashing, and snapshot contracts.
- `src/engine/` owns deterministic and adaptive loop decisions, resolver
  injection, Run state validation, eval evidence, manual/standalone adapters,
  storage layouts, and protected Run persistence.
- `src/engine/race-safe-read.ts`, `contained-atomic-write.ts`, and
  `protected-project-path.ts` are private filesystem supports for bounded,
  identity-checked reads and writes.

The public façade is `src/index.ts` through `src/skill-runtime/index.ts` and
`src/engine/index.ts`. It does not export `run-store.ts`, `state.ts`, storage
layout adapters, or protected filesystem helpers. Classic, Native, Entry,
platform installation, and host registry behavior remain excluded.

The standalone Run façade validates the caller-provided Run id before deriving
the `<projectRoot>/.badger/runs/<run-id>` location, checks recovered state
identity, and delegates all execution operations to the manual Run service.
This keeps storage coordinates and caller inputs separate from the shared
Engine loop and its persisted semantics.

The WorkflowRuntime façade is exposed through `src/workflow-runtime/public.ts`
and the package `./workflow-runtime` export. It contains only runtime
construction and the `start`, `resume`, `submit`, and `recover` operations.
Compiler, Run-location, projection, storage, and protected filesystem modules
remain private. Creator evaluation uses that public seam for its synthetic
linear certification and stores the resulting identity and recovery evidence
for readiness. Explicit decision Nodes use the same seam: generated adapters
project and forward their `ask_user` contracts without authenticating
reviewers, validating policy, selecting transitions, or writing receipts.

Phase 1 certification is the stop/go gate for the next runtime phase. The
Engine report must have `certification.status` equal to `certified`, no missing
matrix capabilities, unchanged official and fixture sources, and no semantic
mismatches. The deterministic linear WorkflowRuntime is delivered under Phase
2, and issue #24 extends it with versioned conditional routing and revisioned
Attempts. Issue #25 adds first-class decision Nodes with identity-bound
receipts, and issue #26 adds bounded declared Cycles with stable identities and
append-only repeated-visit evidence. Issue #27 adds immutable Attempt-, Cycle-,
and Run-lifetime artifact versions, protected content hashing, explicit
carry-forward selections, and generated projections through the same runtime
authority. Issue #28 binds Decision Receipts to immutable artifact and
append-only evidence scope references without introducing attachment storage or
a second receipt store. Complete Phase 3 certification, Native hardening, and
Primer Designer migration remain separately scoped.

`runEngineDifferential` runs official and private observations against one
synthetic fixture matrix. `createPrivateEngineCommandRunner` is an injected
command-bound adapter used by the differential harness; it is not an upstream
CLI dependency.

The copied parity responsibilities are the `badger/v1alpha1` Skill data model,
YAML narrowing, validation messages, stable package hashing, snapshot document
format, Run state shape, resolver contract, loop transitions, guardrails, eval
evidence, and storage references. Private packaging adaptations are module
locality under `src/`, the public façade, the command adapter, and explicit
classification of process-generated manual identities. These adaptations do
not import or modify the upstream checkout.

## Follow-up candidates

These are intentionally separate future batches:

1. Add a production-quality platform adapter interface with filesystem and in-memory adapters.
2. Add additional injected provider-backed authoring review and richer domain guidance.
3. Add external eval runners behind an injected adapter.
4. Add package signing and publication registry integration.
