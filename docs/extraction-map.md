# Comet-any Extraction Map

## Upstream provenance

- Upstream checkout: `comet-any-private/comet`
- Upstream remote: `git@github.com:rpamis/comet.git`
- Audited upstream commit: `99fd749` (`0.4.0-beta.19`)
- Source scenario: `assets/skills/comet-any/SKILL.md`, `domains/workflow-contract/`, `domains/bundle/`, `domains/factory/`, the Creator CLI facade, and the audited Engine closure in `domains/engine/`.

## Standalone seam

| Standalone module                   | Upstream responsibility retained                                                                                                                      |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/workflow-kernel/discovery.ts`  | Real local Skill roots, frontmatter description, reference/script inventory, content hash, strict preference resolution, and missing/ambiguous status |
| `src/workflow-kernel/hash.ts`       | Stable source-tree fingerprints over sorted regular files and supported symbolic links                                                                |
| `src/workflow/contract.ts`          | Workflow-kernel Node vocabulary, binding enforcement, Output Schema validation, canonical edges, run-state contract, route eval metadata              |
| `src/workflow-kernel/foundation.ts` | Shared plan loading, candidate resolution, proposal normalization, blockers, plan hash, confirmed state, and atomic state persistence                 |
| `src/skill/find.ts`                 | Compatibility adapter to the shared discovery seam                                                                                                    |
| `src/factory/proposal.ts`           | Standalone compatibility adapter to the shared proposal seam                                                                                          |
| `src/factory/generate.ts`           | Deterministic entry/Node package generation and protocol/evidence artifacts                                                                           |
| `src/factory/state.ts`              | Standalone compatibility adapter to the shared state seam and `.comet-any` namespace                                                                  |
| `src/eval/run.ts`                   | Current-package hash, route-conformance evidence, and WorkflowRuntime certification                                                                   |
| `src/publish/lifecycle.ts`          | Readiness, reviewer approval, hash-bound publication, and distribution preview                                                                        |
| `src/cli.ts`                        | Thin Creator-facing command interface                                                                                                                 |
| `src/skill-runtime/`                | Engine-compatible Skill types, YAML loading, validation, content identity, and immutable snapshots                                                    |
| `src/engine/`                       | Run state, resolver, loop, guardrails, evals, protected persistence, manual and standalone Run façades                                                |

## Deliberate exclusions

The upstream Creator closure also reaches `domains/comet-classic`, `domains/comet-native`, `domains/comet-entry`, `domains/skill/platform-install`, and host platform registries through the general Comet Bundle distribution path. Those policy and platform modules are not copied or imported here. The standalone seam uses local package publication and preview-only distribution instead.

The upstream `comet-five-phase-overlay` and `comet-native` built-in contracts are excluded. Only `workflow-kernel` is accepted by the standalone plan loader. The source checkout remains available for comparison and is protected from edits by the parent repository instructions.

The extracted foundation accepts a project root, optional home directory, and state namespace. The standalone adapter fixes the namespace to `.comet-any`; it does not change the workflow contract or candidate-resolution semantics. Strict preference resolution is fail-closed: a missing or ambiguous source remains a proposal blocker.

## Creator differential baseline

`primer_designer_harness/differential/primer-designer-workflow.json` is the pinned three-Skill fixture for comparing candidate resolution, source/reference evidence, source hashes, normalized workflow protocol, generated artifact inventory, and initial readiness. `primer_designer_harness/differential/extraction-manifest.json` records the reusable workflow-kernel closure and the deliberate Classic, Native, installer, Engine, and host-platform exclusions.

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
characterization at Comet `0.4.0-beta.19`, revision
`99fd7495f8b9217efbaae3a46d885f6fa7f4102a`:

- `src/skill-runtime/` owns the `comet/v1alpha1` Skill definition, guardrail,
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
the `<projectRoot>/.comet/runs/<run-id>` location, checks recovered state
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
2, and issue #24 extends it with versioned acyclic conditional routing and
revisioned Attempts and first-class decision Nodes with identity-bound receipts.
Declared Cycles, artifact versions, Native hardening, and Primer Designer
migration remain separately scoped.

`runEngineDifferential` runs official and private observations against one
synthetic fixture matrix. `createPrivateEngineCommandRunner` is an injected
command-bound adapter used by the differential harness; it is not an upstream
CLI dependency.

The copied parity responsibilities are the `comet/v1alpha1` Skill data model,
YAML narrowing, validation messages, stable package hashing, snapshot document
format, Run state shape, resolver contract, loop transitions, guardrails, eval
evidence, and storage references. Private packaging adaptations are module
locality under `src/`, the public façade, the command adapter, and explicit
classification of process-generated manual identities. These adaptations do
not import or modify the upstream checkout.

## Follow-up candidates

These are intentionally separate future batches:

1. Add a production-quality platform adapter interface with filesystem and in-memory adapters.
2. Add richer authored content lanes and human review artifacts.
3. Add external eval runners behind an injected adapter.
4. Add package signing and publication registry integration.
