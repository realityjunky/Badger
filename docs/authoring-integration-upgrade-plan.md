# Badger Authoring Integration Upgrade Plan

Status: Implemented delivery record

Date: 2026-09-04

The implementation phases in this document are complete through Phase 7. This
file remains the design and provenance record; its historical `target`,
`recommended`, and `Add` language records decisions made before implementation.
For the current shipped surface, artifact inventory, and release commands, see
`docs/release-artifacts.md`. The package-facing contract is kept in
`assets/skills/badger/SKILL.md` and its references.

## 1. Executive decision

The delivery decision is to keep authoring as a first-class subsystem of the
Badger Creator. It is implemented inside Badger rather than as a separate
orchestration product layered above it, and it remains distinct from execution
of a generated workflow.

The implemented system is an integrated two-stage system:

1. Badger authoring turns a confirmed goal and real Skill evidence into a
   reviewable, high-quality workflow package.
2. Badger WorkflowRuntime executes that generated package with the existing
   deterministic, hash-bound, durable semantics.

The authoring stage owns semantic content and authoring evidence. The existing
workflow-kernel and WorkflowRuntime remain authoritative for normalized
workflow structure, executable transitions, state, evidence, recovery, and
durable local effects.

This plan restores the important authoring functions from the audited upstream
Comet-any package while keeping the current Badger runtime and its
workflow-kernel-only boundary.

## 2. Scope

### In scope

- A six-lane authoring process for workflow-kernel Skills.
- Authoring state, lane dependencies, records, claims, artifact evidence, and
  cross-context recovery.
- Subagent/provider-neutral authoring dispatch through file handoff.
- Deterministic assembly of authored content with the Badger control plane.
- Authored entry Decision Core and internal Node Guidance.
- Authoring-time pause-point classification and recovery guidance.
- Source/composition evidence and preference/deviation reporting.
- Quick and full authoring review modes.
- A separate authoring-quality review gate combined with existing deterministic
  runtime evaluation and publication approval.
- Current-hash binding across source evidence, authoring material, generated
  package, runtime evaluation, and publication.
- Platform-neutral local filesystem behavior.

### Explicitly out of scope

- Comet Classic policy or the five-phase overlay.
- Comet Native policy, adapters, or Native-derived behavior.
- Comet Entry routing.
- Host platform installers and platform registry integration.
- Dashboard, web, or visual authoring interfaces.
- Biological execution, scheduler submission, genome download, or domain
  execution.
- Credentials, provider-specific secrets, or automatic external-agent
  authentication.
- A second implementation of WorkflowRuntime, Engine execution, or durable Run
  storage.

Platform and dashboard integration remain future adapters. They must consume
the stable Badger authoring and publication contracts rather than introduce a
second authoring state machine.

## 3. Problem statement and baseline

The upstream Comet-any Skill was not only a workflow factory. It was a
meta-workflow for authoring a usable Skill package. Its authoring protocol
separated:

- deterministic control-plane generation;
- source and composition evidence;
- semantic entry and Node guidance;
- decision-point and recovery guidance;
- independent authoring review.

At the time this plan was written, the Badger package retained the
workflow-kernel contract and its Creator accepted a plan, normalized it,
generated deterministic Markdown templates, evaluated runtime behavior, and
recorded publication approval. The delivered implementation now adds the
six-lane authoring session, authored-leaf assembly, review, and readiness
evidence described in this document.

The planning baseline had this gap:

    goal and plan
        |
        v
    deterministic scaffold
        |
        v
    runtime evaluation
        |
        v
    publication approval

The required architecture is:

    goal and plan
        |
        v
    authoring plan and lane DAG
        |
        v
    authored drafts, claims, and review
        |
        v
    deterministic assembly of control plane plus authored content
        |
        v
    runtime evaluation and publication approval

The delivered implementation makes the second flow the normal path for new and
upgrade-existing workflows. A deterministic scaffold without authored content
must remain visibly incomplete, not silently become a ready Skill.

### 3.1 Upstream implementation baseline

The audited upstream authoring mechanism is larger than
domains/bundle/authoring.ts, but it is also narrower than the whole Comet
application. The following code is the compatibility baseline for this plan:

The comparison baseline is the official Comet revision
99fd7495f8b9217efbaae3a46d885f6fa7f4102a (0.4.0-beta.19). A newer upstream
checkout may contain unrelated changes; parity evidence must use this pinned
revision or a disposable byte-equivalent copy and must identify any later
source observations separately.

- assets/skills/comet-any/SKILL.md defines the user-facing authoring sequence
  and instructs the main session when to dispatch authoring workers.
- assets/skills/comet-any/reference/authoring-protocol.json defines the
  canonical lane ids, wave DAG, claims, review depth, deterministic backbone,
  and authored content leaves.
- assets/skills/comet-any/reference/authoring-subagents.md and
  reference/subagents/*.md define the six role briefs, file-handoff boundary,
  output format, and review barrier.
- domains/bundle/authoring.ts defines the lane constants and claims, hashes
  the authoring protocol constants, builds the quick/full AuthoringPlan,
  validates lane output and review metadata, filters content-leaf paths, and
  merges accepted content into factory metadata.
- domains/bundle/state.ts persists BundleAuthoringState, serializes project
  paths, reconciles draft and ready hashes, invalidates stale eval/review
  evidence, and records drift conflicts.
- domains/bundle/types.ts carries BundleAuthoringState, AuthoringReview,
  generated-package metadata, authoringContent, and authoringReview.
- domains/bundle/factory.ts passes authoring content and review into package
  generation after proposal confirmation and composition.
- domains/factory/package.ts renders the deterministic Auto zone, inserts
  authored Decision Core and Guidance content, emits authoring reference
  artifacts, detects AUTHORING PENDING markers, and rejects a failing
  generated-package authoring review.
- domains/factory/types.ts carries contentDrafts and authoringReview into the
  package assembler.
- domains/bundle/review-summary.ts reports missing authored content, pending
  markers, missing or failed authoring review, composition issues, and
  current-hash readiness.
- domains/bundle/eval.ts validates the authoring-related control-plane
  inventory and records quick/full repository evaluation evidence.
- domains/bundle/publish.ts gates review and publication on current-hash eval,
  control-plane validity, reviewer approval, and final package identity.
- app/cli/index.ts, app/commands/bundle.ts, and app/commands/creator.ts expose
  authoring-plan and authoring-record alongside the ordinary Creator
  lifecycle.
- test/domains/bundle/bundle-authoring.test.ts and
  test/domains/factory/factory-content-merge.test.ts exercise the authoring
  plan, state, content-leaf merge, pending markers, and review behavior.

The current upstream implementation does not provide a separate durable record
file for every lane. Lane output is validated by domains/bundle/authoring.ts,
then accepted content and the review object are carried in factory metadata.
The per-lane record store and explicit authoring-session recovery proposed
below are therefore deliberate Badger extensions, not a claim of textual
upstream parity.

The upstream authoring references and TypeScript constants already contain the
authoring-protocol concept. Badger is restoring and formalizing an existing
concept; it is not inventing the six-lane model.

The exact upstream-compatible authoring core is:

| Concern | Upstream contract |
| --- | --- |
| Lane ids | script, reference, pause-points, workflow-entry, skill-core, skill-review |
| Scheduling | wave 1 runs script/reference/pause-points; wave 2 runs workflow-entry/skill-core after script; skill-review is the barrier |
| Quick depth | one voter and one review round |
| Full depth | three voters and up to four review rounds |
| Review lenses | contract-fit, usability, evidence-trace, self-consistency |
| Authored leaves | entry SKILL.md, internal Node SKILL.md files, decision-points.md, recovery.md, skill-review.md |
| Deterministic backbone | protocol, resolved-source evidence, composition report, authoring-lanes metadata, scripts, manifests, rules, hooks, guardrails, checks, and eval declarations |

This table is the restoration contract. The plan's additional record,
hash, storage, and concurrency fields are Badger hardening and must not be
silently treated as fields that existed in the upstream implementation.

One naming detail is important. In the upstream TypeScript implementation,
AuthoringPlan.protocolHash is the hash of the authoring protocol constants
(DAG and lane claims), not the hash of the generated workflow's executable
WorkflowProtocol. Badger must preserve that meaning for compatibility and use
a separately named workflowProtocolHash for the normalized executable
WorkflowProtocol. Reusing protocolHash for both would make stale-evidence
diagnosis ambiguous.

The upstream material also contains a claim-contract mismatch: the protocol
declares no lane claims for skill-core, while the skill-core brief requires one
node-skill claim per active Node. Phase 0 must record this discrepancy. The
Badger target should retain the upstream claim ids for compatibility and add
deterministically derived node-skill claims for each active Node, treating that
addition as a Badger correction rather than silently calling it upstream
parity.

There is a second, related script-claim mismatch. The protocol and
AUTHORING_LANE_CLAIMS enumerate six script claims, but the script role brief's
required-claim section explicitly names only the three workflow adapters. The
three additional plan/check/hook claims describe deterministic backbone
artifacts rather than worker-authored content. Badger must preserve all six
artifacts and their claim/evidence mapping, while making the distinction
explicit: adapter-contract claims come from the script lane, and
plan/check/hook completeness claims are assembler-validated. Treating the
brief's shorter required-claim list as permission to omit the latter would be
a compatibility regression.

### 3.2 Restoration versus Badger hardening

The implementation must report two separate compatibility dimensions:

1. Upstream restoration:
   preserve the six lane ids, wave DAG, claims, quick/full metadata,
   Auto-zone/Authored-zone boundary, content-leaf allowlist, deterministic
   backbone, lane output shape, authoring review shape, and Creator command
   intent for generic workflow-kernel packages.
2. Badger hardening:
   add per-lane durable records, explicit authoring-session recovery,
   source-evidence and authored-material hashes, serialized concurrent updates,
   stronger path and size bounds, runtime cross-validation, and a composite
   readiness gate.

Badger hardening may be stricter than upstream, but it must be labeled as an
extension and tested separately from the restoration comparison. A stricter
Badger policy must not silently be presented as original Comet behavior.

### 3.3 Current Badger seams that authoring must respect

The current Badger implementation creates Creator state under `.badger/states`,
generates a package under the configured draft root, hashes the package during
evaluation, and runs WorkflowRuntime certification against the generated
package. Authoring sessions now live under `.badger/authoring`, while the
package generator and `src/authoring/lifecycle.ts` keep scaffold, authored
material, assembled-package, evaluation, and publication identities distinct.

The implementation addresses these seams explicitly:

- refactor generation so scaffold creation cannot erase an authoring session
  or valid source evidence;
- make scaffold, authored material, and assembled package identities distinct;
- preserve the existing protected WorkflowRuntime asset and generated adapter
  contract;
- integrate authoring blockers into readiness without making the runtime
  responsible for lane scheduling;
- preserve the existing current-hash evaluation and Phase 3/Phase 4
  certification gates;
- rebuild generated runtime assets from source whenever the runtime contract
  changes;
- retain upgrade-existing source preservation and the existing destination
  containment check.

The release ledger in `docs/release-artifacts.md` records the resulting
artifact set and the checks that keep these seams aligned.

## 4. Authoring responsibilities

Authoring is a package-construction workflow. It does not execute the
generated workflow.

### 4.1 Script lane

The script lane defines the contract for the generated workflow-state,
workflow-guard, and workflow-handoff adapters.

It must explain:

- state and evidence inputs;
- state and evidence outputs;
- Node completion conditions;
- NEXT and SKILL output semantics;
- blocking and recovery behavior;
- how incomplete work remains in the current Node;
- how the generated package remains recoverable across processes and devices;
- how the contract maps to the current Badger WorkflowRuntime adapters.

The lane produces a contract and claims. It does not replace the current
bundled WorkflowRuntime or generate an independent runtime implementation.

### 4.2 Reference lane

The reference lane organizes evidence for the package.

It must produce or validate:

- resolved Skill names, roots, descriptions, references, scripts, and hashes;
- the normalized workflow protocol;
- source summaries derived from actual Skill files;
- composition and call-order reasoning;
- preference matches and deviations with reasons;
- executable disclosures;
- the boundary between user-visible guidance and internal audit evidence;
- the evidence inputs from which the assembler renders authoring-lane metadata.

The lane must not copy complete source Skill bodies into the generated
package. It must preserve traceability through bounded summaries, paths, and
hashes.

### 4.3 Pause-points lane

The pause-points lane classifies possible interruptions before writing
decision guidance.

Each candidate must be classified as exactly one of:

- genuine user decision;
- automatic handling;
- stop condition;
- manual handoff.

A user pause is valid only when at least two currently executable options change
scope, behavior, accepted risk, or an irreversible outcome.

The lane must produce:

- reference/decision-points.md;
- reference/recovery.md;
- claims for decision classification and recovery.

The lane must cross-check all declared runtime decision Nodes. It may explain
or refine their user-facing guidance, but it must not invent choices or
transitions absent from the normalized WorkflowProtocol.

### 4.4 Workflow-entry lane

The workflow-entry lane authors the entry Skill Decision Core.

It must cover:

- semantic current-Node detection;
- state-first startup;
- protocol and artifact evidence over conversation memory;
- resume and drift handling;
- topic changes while a Node is active;
- genuine user decisions;
- automatic repair and stop-condition handling;
- red flags that catch false progress;
- loading only the Node identified by the authoritative runtime continuation.

The lane may write only the allowed authored section of the entry Skill.
Frontmatter, runtime commands, route metadata, guard requirements, and
security-sensitive control-plane sections remain deterministic.

### 4.5 Skill-core lane

The Skill-core lane authors one Guidance section for every active internal
Workflow Node.

Each Node Guidance must include, as applicable:

- prerequisites;
- domain-specific steps;
- when to load the bound Skill;
- required Skill-call obligations;
- evidence to record;
- completion reasoning beyond mechanical checks;
- red flags and false-progress patterns;
- recovery entry.

The lane must not copy a bound Skill body wholesale. It must add the domain
judgment that a structural protocol and runtime cannot infer.

### 4.6 Skill-review lane

The Skill-review lane is the authoring barrier.

It reviews all preceding lane outputs and claims, not merely their summaries.
It must return two verdicts:

- contract fit;
- usability quality.

It must inspect:

- authored entry and Node content;
- protocol consistency;
- Required Skill Calls;
- Node advancement and guards;
- pause-point classification;
- recovery guidance;
- source and composition evidence;
- command references;
- generated artifact expectations;
- leakage of audit metadata into user-visible files.

It must report concrete findings with paths, claims, impact, and recommended
fixes. A review cannot pass while a Critical or Important finding remains.

## 5. Implemented architecture and retained design decisions

### 5.1 Integrated layers

The implemented Badger architecture contains four internal layers:

    Authoring plane
      AuthoringProtocol, lane DAG, providers, records, authored content,
      authoring review, and authoring readiness
              |
              v
    Creator and contract plane
      candidate discovery, source hashes, plan normalization, WorkflowProtocol,
      deterministic scaffold, and final assembly
              |
              v
    Runtime plane
      bundled WorkflowRuntime, Engine, Run state, decisions, evidence,
      artifacts, receipts, recovery, durability, and finalization
              |
              v
    Publication boundary
      current-hash evaluation, human approval, local publication, and preview

The first three layers belong inside Badger. The publication boundary exposes
provider-neutral contracts that future platform and dashboard adapters may
consume.

### 5.2 Delivered module boundaries

The delivered authoring modules are:

- src/authoring/types.ts
  AuthoringProtocol, lanes, claims, artifact evidence, records, review
  output, readiness, and authoring session types.
- src/authoring/protocol.ts
  Canonical six-lane definitions, wave dependencies, depth settings, and
  deterministic backbone/content-leaf declarations.
- src/authoring/plan.ts
  Derive and validate an AuthoringPlan from the normalized WorkflowProtocol
  and resolved source evidence.
- src/authoring/lifecycle.ts
  Owns session storage, record validation, dependency and readiness evaluation,
  authored-leaf assembly, atomic writes, safe paths, and mutation serialization.
- src/authoring/dispatch.ts
  Provider-neutral dispatch and file-handoff contracts. The first provider
  may be manual file submission; external providers remain injected adapters.
- src/authoring/review.ts
  Normalize quick/full review results and combine independent findings without
  fabricating approval.
- src/authoring/cross-validation.ts
  Check authored content against declared decisions, routes, calls, schemas,
  guardrails, recovery, and artifact selection.

Reuse existing modules rather than duplicating them:

- src/workflow-kernel/discovery.ts for real source Skills and hashes;
- src/workflow-kernel/foundation.ts for project, preference, proposal, and
  confirmed-state foundations;
- src/workflow/contract.ts for normalized executable WorkflowProtocol;
- src/workflow-kernel/hash.ts and src/util.ts for stable hashing and safe
  filesystem operations;
- src/factory/generate.ts for deterministic package primitives after it is
  refactored into scaffold and assembly seams;
- src/eval/run.ts for deterministic package and runtime evaluation;
- src/publish/lifecycle.ts for final current-hash publication readiness;
- src/workflow-runtime/public.ts for execution certification and Run behavior.

Authoring must not import or reimplement private runtime storage, route
selection, decision validation, receipt creation, or Engine mutation logic.

### 5.3 Why authoring is not a WorkflowRuntime Run

Authoring belongs inside Badger, but it should not be represented as an ordinary
generated-workflow Run. The two processes have different semantics:

- authoring has a parallel lane DAG and a review barrier;
- a generated Run has one authoritative pending action and one committed
  transition at a time;
- authoring workers return bounded draft artifacts and claims;
- Run executors return machine outcomes or typed runtime decisions;
- authoring changes package construction inputs;
- Run submissions change an execution ledger.

Forcing the authoring DAG into WorkflowRuntime would require new parallel-Run
semantics and would mix package-construction state with execution state. The
The implementation therefore uses an in-process AuthoringLifecycle with shared hashing,
atomic-write, findings, and safe-path primitives. WorkflowRuntime remains the
sole authority once the assembled package is executed.

## 6. Two protocols, one executable authority

The architecture must keep two protocols because they describe different
things:

### AuthoringProtocol

AuthoringProtocol describes how a package is authored:

- lane identities;
- lane dependencies;
- required claims;
- required authoring artifacts;
- authoring depth;
- review lenses;
- deterministic backbone;
- authored content leaves.

It governs the Creator meta-workflow only.

### WorkflowProtocol

WorkflowProtocol describes what the generated package executes:

- Nodes and responsibilities;
- bindings and Required Skill Calls;
- Output Schemas;
- guards and evidence;
- routes and transitions;
- decisions and choices;
- Cycles and Attempts;
- durability capabilities;
- runtime recovery.

It remains the only authority for generated workflow execution.

The Badger AuthoringPlan must reference the exact normalized WorkflowProtocol
through a separately named workflowProtocolHash field. Its compatibility
protocolHash field must continue to identify the AuthoringProtocol itself.
Authoring content may explain WorkflowProtocol behavior but may not alter it.
Any protocol change invalidates dependent authoring records and requires the
affected lanes to be re-authored.

## 7. Authoring domain model

### 7.1 AuthoringPlan

AuthoringPlan should contain:

- The upstream-compatible core: schemaVersion, workflow name, depth,
  protocolHash (the AuthoringProtocol hash), canonical DAG, lane definitions,
  and verification settings.
- Badger extension fields: kind, planHash, workflowProtocolHash, resolved
  source evidence hash, generator contract version, deterministic backbone
  paths, authored content-leaf paths, and creation timestamp.

The plan must be derived only after proposal normalization. It must not
re-normalize or independently reinterpret executable Node transitions.

The minimum compatibility fixture must validate the upstream-compatible core
without requiring Badger extension fields. Badger readiness may require the
extension fields once the integrated authoring mode is enabled. A fixture must
assert that protocolHash and workflowProtocolHash are different fields with
different meanings.

### 7.2 Lane definition

Each lane definition should contain:

- stable lane id;
- dependency lane ids;
- brief/reference path;
- required claims;
- required artifact declarations;
- produced content-leaf paths;
- whether a review object is required;
- bounded output limits.

The canonical lane order remains:

    script
    reference
    pause-points
    workflow-entry
    skill-core
    skill-review

The dependency DAG remains:

    wave 1: script, reference, pause-points
    wave 2: workflow-entry, skill-core
    barrier: skill-review

The workflow-entry and skill-core lanes must not start until the script
contract is recorded. The review lane must not start until all five other
lanes are complete.

### 7.3 AuthoringRecord

Each record should contain:

- schemaVersion;
- kind: authoring-record;
- workflow name;
- lane id;
- authoringPlanHash;
- workflowProtocolHash;
- sourceEvidenceHash;
- authoringInputHash;
- status;
- claims and claim status;
- bounded artifact references;
- optional review output;
- bounded summary;
- authoring timestamp.

The upstream lane-output envelope remains the input compatibility contract. It
contains a lane id, one of the upstream statuses, optional dispatch metadata,
optional artifacts with path/kind/content, optional claims, optional findings,
and a review object for the skill-review lane. Badger may wrap that envelope in
a durable AuthoringRecord, but it must not require workers to know
Badger-specific storage paths or Creator-state internals.

Claims and artifacts are different kinds of evidence. A claim says what a lane
asserts; an artifact identifies the bounded content or report supporting that
assertion. The validator must require every required claim and declared
artifact according to the lane definition, reject unknown claims and paths,
and preserve findings even when the lane cannot complete.

Lane output statuses should preserve the upstream semantics:

- DONE;
- DONE_WITH_CONCERNS;
- BLOCKED;
- NEEDS_CONTEXT.

DONE requires every required claim to be supported, every required artifact to
be present and hash-consistent, and any required review output to pass
validation under the Badger target policy. DONE_WITH_CONCERNS is recordable but
must expose its concerns to readiness and review; it must not silently become
an unqualified pass.

DONE_WITH_CONCERNS may be assembled into a visibly non-ready candidate when
the recorded concerns do not invalidate the deterministic backbone. It cannot
satisfy final authoring readiness until the concerns are resolved or an
explicit Badger policy records why they are accepted. BLOCKED and
NEEDS_CONTEXT cannot be assembled into a ready package.

BLOCKED and NEEDS_CONTEXT require a bounded explanation. They must stop
dependent lanes and must never be silently converted into warnings. The
upstream record command rejects these statuses as continuations; Badger may
persist them as explicit stop records so authoring can recover without losing
the worker's evidence. That persistence is a deliberate Badger extension, not
an upstream compatibility claim.

PENDING and IN_PROGRESS may be derived session display states for work that
has not produced a lane output. They are not valid completed lane-record
statuses and cannot satisfy authoring readiness.

### 7.4 Content leaves

Content leaves are authored files or authored sections whose paths are
declared by AuthoringProtocol.

The initial allowlist should be:

- entry SKILL.md Decision Core;
- one internal Node SKILL.md Guidance section per active Node;
- reference/decision-points.md;
- reference/recovery.md;
- reference/skill-review.md.

Subagent outputs should be stored in the authoring session first. The final
package is written only by the deterministic assembler.

The following are deterministic backbone artifacts rendered from validated
records and source evidence, not authored content leaves:

- reference/authoring-lanes.json;
- reference/composition-report.md.

Workers may propose evidence for these artifacts, but only the assembler may
render their final forms.

No subagent may directly modify:

- frontmatter;
- reference/workflow-protocol.json;
- reference/resolved-skills.json;
- reference/authoring-lanes.json;
- reference/composition-report.md;
- scripts/workflow-runtime.mjs;
- scripts/workflow-state.mjs;
- scripts/workflow-guard.mjs;
- scripts/workflow-handoff.mjs;
- badger/eval.yaml;
- generated runtime manifests;
- package identity or hash metadata.

## 8. State and hash design

### 8.1 Separate authoring state from Run state

Authoring state and generated workflow Run state must remain separate:

    .badger/
      states/<name>.json
      authoring/<name>/
        plan.json
        records/<lane>.json
        artifacts/<lane>/*
        review/
        state.json
      drafts/<name>/
      eval/<name>.json
      runs/<run-id>/
      published/<name>/

The existing .badger/states/<name>.json remains the Creator lifecycle summary.
It may gain an authoring summary and pointers, but it must not contain all
lane content or become the authoring record store.

The existing .badger/runs/<run-id>/ location remains exclusively for an
executed generated workflow. Authoring records must never be represented as
runtime Attempts, Cycles, Decisions, or Engine actions.

### 8.2 Hash layers

Use separate hashes with explicit meanings:

- planHash: exact user/orchestrator plan input;
  - protocolHash: the upstream-compatible hash of the AuthoringProtocol
    constants;
  - workflowProtocolHash: normalized executable WorkflowProtocol;
- sourceEvidenceHash: resolved Skill roots, source hashes, and reference
  evidence;
- authoringPlanHash: canonical AuthoringPlan;
- authoringInputHash: protocol, source evidence, authoring plan, and generator
  contract identity;
- authoredMaterialHash: canonical authored content and lane claims;
- generatedPackageHash: final assembled package tree;
- evalHash: package tree hash evaluated by deterministic checks;
- runtime identity hashes: existing protocol, package, snapshot, resolver, and
  durability identities.

Authoring records bind to authoringInputHash and their dependencies. The
skill-review record also binds to authoredMaterialHash. Deterministic
evaluation binds to generatedPackageHash. Publication approval binds to the
current generatedPackageHash and all current evaluation evidence.

This avoids a circular dependency in which a record must contain the final
package hash before the record itself can be assembled into that package.

### 8.3 Stale evidence rules

The following changes invalidate authoring records:

- plan input changes;
- normalized Node, route, decision, schema, or durability changes;
- source Skill content or reference hash changes;
- authoring protocol or generator contract changes;
- authored content changes after review;
- changes to required lane artifacts.

The invalidated lane and all dependent lanes must be re-recorded. Existing
records remain audit evidence but cannot satisfy current readiness.

## 9. Creator lifecycle

The integrated lifecycle should be:

    draft
      -> confirmed
      -> scaffolded
      -> authoring
      -> authored
      -> assembled
      -> evaluated
      -> reviewable
      -> review-approved
      -> published

The externally visible CreatorStatus preserves the current statuses while
exposing authoring readiness as a nested status. Older state documents remain
readable, while new reports use the explicit authoring status.

Delivered behavior:

1. guide reads Creator state and authoring session state.
2. candidates discovers real Skills and source evidence.
3. propose validates and normalizes an existing plan; it does not pretend to
   author a plan.
4. init requires explicit confirmation and records the exact plan/proposal
   hashes.
5. generate creates or refreshes the deterministic scaffold and derives the
   AuthoringPlan. It must leave explicit authoring-pending markers.
6. authoring-plan reads the canonical AuthoringPlan and lane readiness.
7. authoring-record validates and persists one lane result.
8. authoring-status shows dependency waves, current blockers, hashes, claims,
   artifacts, and next executable lane actions.
9. assemble consumes only complete current authored records and writes the
   final package through the deterministic assembler.
10. eval runs deterministic route and WorkflowRuntime checks against the final
    current package hash.
11. review reports authoring, runtime, and publication evidence separately.
12. approve requires current authoring review, current deterministic
    evaluation, and explicit reviewer confirmation.
13. publish copies only the approved current-hash package.
14. distribute remains local preview-only; platform and dashboard adapters are
future work.

The existing generate command remains the scaffold command for backward
compatibility. The distinct assemble command prevents users and tools from
mistaking a scaffold for a ready package.

## 10. CLI and API changes

### 10.1 Commands to add

Add:

- badger authoring-plan <name> --depth quick|full --json;
- badger authoring-status <name> --json;
- badger authoring-record <name> --lane <lane> --file <record.json> --json;
- badger assemble <name> --json.

Optional future commands:

- badger authoring-dispatch <name> --lane <lane>;
- badger authoring-revise <name> --lane <lane>;
- badger authoring-review <name> --json.

The first implementation should not require a provider-specific dispatch
command. The main session or a future provider adapter can dispatch a fresh
authoring worker and submit the resulting record through the stable
authoring-record contract.

### 10.2 Existing commands to change

guide:

- show authoring status and resumable lane information;
- distinguish Creator state from authoring state and generated Run state.

propose:

- continue to validate and normalize;
- report the authoring profile and expected lane DAG;
- never claim that a plan was semantically authored merely because it parsed.

init:

- persist confirmation, planHash, protocolHash, workflowProtocolHash, and
  sourceEvidenceHash;
- initialize an authoring session without creating fake lane records.

generate:

- generate deterministic scaffold content;
- derive the current AuthoringPlan;
- mark entry and substance Nodes as AUTHORING PENDING;
- never clear valid authoring outputs unless their input hashes changed.

eval:

- refuse to certify a final authored package when required authoring content is
  still pending;
- preserve the existing deterministic runtime certification;
- write separate authoring and runtime evidence sections.

review:

- return a structured readiness object with authoring, runtime, and
  publication sections;
- show missing or stale records, claims, artifacts, and review findings;
- distinguish deterministic-check-only from authoring-review-passed.

approve:

- require a current authoring review verdict;
- require current deterministic evaluation and runtime certification;
- record the final publication reviewer separately from the authoring reviewer.

publish:

- retain current hash-bound behavior;
- never publish an assembled package whose authoring evidence is stale.

### 10.3 Public TypeScript surface

Export the authoring types and pure validators needed by callers, but keep
filesystem storage, process dispatch, and package assembly internals private.

Recommended public exports:

- AuthoringProtocol;
- AuthoringPlan;
- AuthoringLane;
- AuthoringRecord;
- AuthoringReadiness;
- AuthoringReview;
- createAuthoringSession;
- deriveAuthoringPlan;
- validateAuthoringPlan;
- validateAuthoringRecord;
- readAuthoringStatus.

Do not export a provider-specific agent SDK or a second runtime constructor.

## 11. Generator and assembly design

### 11.1 Refactor the existing generator

Refactor src/factory/generate.ts into explicit stages:

- scaffold generation;
- authored material collection;
- authored material validation;
- deterministic assembly;
- package tree hashing;
- generated artifact inventory.

The current entryMarkdown and nodeMarkdown functions should be split into:

- deterministic Auto-zone rendering;
- authored-zone insertion;
- final section-order validation.

### 11.2 Auto zone

The Auto zone remains generated from the normalized WorkflowProtocol and
current Badger runtime contract.

For the entry Skill it owns:

- frontmatter;
- workflow identity;
- route and Node metadata;
- runtime and recovery commands;
- guardrail and evidence summaries;
- generated runtime contract;
- certification boundary.

For each Node Skill it owns:

- frontmatter;
- Node responsibility;
- entry check;
- bound implementation;
- Required Skill Calls;
- Output Schemas;
- evidence record;
- guardrails;
- exit check;
- recovery contract;
- explicit decision schema when declared.

### 11.3 Authored zone

The Authored zone contains only domain judgment that cannot be derived
mechanically.

Entry:

    ## Decision Core

Node:

    ## Guidance

The assembler must reject:

- missing required authored sections;
- multiple authored sections for one target;
- frontmatter edits;
- altered control-plane sections;
- unknown Node targets;
- content outside declared paths;
- hidden executable commands not declared by the protocol;
- provider-specific prefixes where only Skill names are allowed;
- unbounded content;
- placeholder markers such as AUTHORING PENDING in a final package.

The assembler must preserve Markdown content as authored, subject to bounded
syntax and path validation. It must not rewrite domain prose through an
unreviewed normalization step.

### 11.4 Generated reference layer

The final package should contain:

- reference/workflow-protocol.json;
- reference/resolved-skills.json;
- reference/authoring-lanes.json;
- reference/composition-report.md;
- reference/decision-points.md;
- reference/recovery.md;
- reference/skill-review.md;
- badger/eval.yaml;
- reference/eval-manifest.json.

These files belong to the generated workflow package. The Badger authoring
Skill itself is a separate package-facing asset and should carry the
AuthoringProtocol, authored-zone quality example, authoring overview, and six
generic role briefs. Do not copy the entire authoring tool and all of its role
briefs into every generated workflow package.

The package should also contain the current Badger runtime asset and its thin
state, guard, and handoff adapters.

The generic workflow-kernel package must retain the upstream control-plane
coverage of six generated scripts:

- workflow-state;
- workflow-guard;
- workflow-handoff;
- a deterministic Badger plan/protocol inspection script;
- a deterministic Badger required-files/completeness check script;
- badger-hook-guard.

The last three are the Badger-named adaptation of the upstream
comet-plan, comet-check, and comet-hook-guard roles. They must read the same
normalized WorkflowProtocol and must not import Classic or Native policy.
The compatibility fixture should record the name mapping explicitly rather
than treating a rename as a semantic mismatch. The existing bundled
badger-hook-guard asset should be reused where its current contract matches;
the plan/check roles need explicit generated implementations and tests.

The final package should also carry the Badger evaluation manifest and the
bundled WorkflowRuntime asset. Authoring references and script inventory must
be generated from validated records and the protocol, not supplied as
unverified worker assertions.

The authoring reference documents are audit and maintenance artifacts. They
must not be injected wholesale into the user-visible entry Skill.
The authoring-lanes and composition-report files are deterministic projections
of validated authoring records and source evidence; they are not worker-owned
content leaves.

## 12. Dispatch and provider model

### 12.1 Provider-neutral contract

Authoring dispatch should use a narrow interface:

- lane id;
- input artifact paths;
- common input manifest;
- output report path;
- output limits;
- no inherited conversation history;
- no direct state-store access;
- no candidate script execution;
- no publish or distribution authority.

The worker returns a structured status, claims, artifact references, and
findings. The main Badger process validates and records it.

### 12.2 Initial provider

The first implementation should support manual/file-based authoring:

- generate a lane brief;
- write the expected report JSON or Markdown files;
- submit them through authoring-record;
- validate the complete result.

This provides deterministic tests and does not require provider credentials.

An injected process or model provider can be added later. It must not receive
repository secrets, protected raw-data inputs, or unrestricted write access.

### 12.3 Parallel lanes

Wave-one lanes may run concurrently because they write distinct output
locations. Wave-two lanes start only after their dependencies are recorded.
The review lane is a barrier.

Concurrent lane records must not race on the Creator summary. Use a serialized
authoring-state mutation path with:

- a monotonic state revision;
- atomic replacement;
- expected-revision checks;
- bounded conflict findings;
- retry only for the same idempotent record.

The existing per-Run mutation lock is not the authoring-state lock. Do not
reuse a Run lock with a different semantic owner.

## 13. Readiness and review composition

Readiness should be a structured conjunction, not one opaque boolean:

    authoring:
      proposalConfirmed
      planCurrent
      laneDependenciesSatisfied
      requiredClaimsSupported
      requiredArtifactsCurrent
      authoredContentComplete
      authoringReviewPassed

    runtime:
      protocolValid
      generatedPackageCurrent
      routeConformancePassed
      WorkflowRuntimeCertificationPassed
      runtimeIdentityCurrent

    publication:
      humanPublicationApproval
      currentHashMatchesAllEvidence

Each section should expose blockers, warnings, evidence paths, and hashes.

Rules:

- authoring blockers prevent assembly;
- assembly blockers prevent evaluation;
- runtime blockers prevent publication;
- publication approval cannot repair an authoring or runtime blocker;
- a stale authoring review cannot satisfy a new package hash;
- a deterministic runtime pass cannot substitute for missing authored
  guidance;
- an authoring review pass cannot substitute for deterministic runtime checks.

### 13.1 Quick mode

Quick mode uses one authoring reviewer and one review round. It still requires
all required lanes and all required claims. It is not a way to skip
authoring.

### 13.2 Full mode

Full mode uses three independent review voters with the lenses:

- contract-fit;
- usability;
- evidence-trace;
- self-consistency.

The upstream contract declares three voters, four lenses, a maximum of four
rounds, and a two-round dry threshold. It does not specify a one-to-one
assignment between three voters and four lenses, and
domains/bundle/authoring.ts validates the resulting review object rather than
dispatching or aggregating voters.

Recommended Badger rule: dispatch three independent voters, each evaluating
contract-fit, usability, and evidence-trace; run self-consistency as a
deterministic cross-check over commands, paths, claims, and generated
artifacts. Record all four lenses in the review metadata. Model/provider
findings are confirmed by a two-of-three majority; deterministic
self-consistency findings are always retained and block when their severity
is Critical or Important. Repeat until two consecutive rounds produce no new
blocking findings or four rounds have run. This is a documented Badger
extension that resolves the upstream metadata ambiguity.

The review record must identify the mode, voters, lenses, rounds, findings,
input hashes, and final verdict. It must never contain fabricated provider
results.

The upstream readiness summary can warn when an LLM authoring review is
missing, while the Badger authoring-required profile will make a missing or
stale authoring review a publication blocker. That is an intentional Badger
policy extension and must be reported separately from upstream parity.

## 14. Runtime integration rules

The existing WorkflowRuntime remains the execution authority.

Authoring may:

- derive guidance from a normalized protocol;
- explain declared decisions and Required Skill Calls;
- produce human-readable recovery and pause-point references;
- add bounded authored evidence to the generated package;
- request deterministic validation.

Authoring may not:

- select runtime routes;
- allocate Cycles or Attempts;
- write Decision Receipts;
- validate reviewer authority for runtime decisions;
- create or mutate runtime Run state;
- infer an implicit latest artifact;
- bypass verification receipts;
- bypass repair policy or hard stops;
- execute generated workflow scripts during authoring.

The authoring review must check that authored prose agrees with runtime
contracts. The runtime certification must check that generated adapters agree
with WorkflowProtocol. This creates a two-direction consistency check without
creating two runtime authorities.

## 15. Source evidence and composition

The current discovery implementation already supplies real candidate roots,
descriptions, reference inventories, script inventories, and stable hashes.
Authoring should consume that evidence rather than reimplement discovery.

The reference lane should produce a bounded composition report containing:

- selected Skills and source hashes;
- why each Skill supports its assigned Node;
- required Skill-call relationships;
- preference order and preference indices;
- deviations and their reasons;
- missing or ambiguous candidates;
- executable disclosures;
- known capability gaps;
- the exact WorkflowProtocol and AuthoringPlan hashes.

The report is internal evidence. The user-visible entry Skill should summarize
what a user needs to operate the workflow without exposing source hashes or
internal metadata unnecessarily.

## 16. Migration and compatibility

### 16.1 New workflows

All new workflows use authoring-required mode by default. The first generated
scaffold is not publishable until authoring is complete and reviewed.

### 16.2 Upgrade-existing workflows

The source Skill package is copied as current Badger already does. The
authoring system then:

- records source identity and source tree hash;
- preserves source files;
- adds deterministic control-plane files;
- authors only the new entry and Node content required by the protocol;
- records which source content was retained, replaced, or wrapped;
- rejects destination paths nested inside the source package;
- re-runs source evidence after assembly.

The source Skill body remains evidence and implementation input. It is not
silently replaced by a generated summary.

### 16.3 Existing deterministic Badger drafts

Existing drafts without authoring records should be classified as
legacy/scaffold-only. They may remain readable and evaluable for compatibility,
but they must not be presented as authoring-complete.

Do not silently mark existing packages as authoring-complete. Provide an
explicit migration path that derives an AuthoringPlan and requires the
authoring lanes to fill missing semantic content.

### 16.4 Upstream Comet-any package

The upstream Comet-any package remains evidence and a source of authoring
requirements. Its Classic, Native, Entry, and platform-specific branches are
not reintroduced. Generic workflow-kernel authoring concepts should be
ported into Badger using Badger names, paths, and runtime contracts.

## 17. Conflict and duplication controls

### 17.1 Protocol duplication

Control:

- AuthoringProtocol is authoritative only for authoring lanes.
- WorkflowProtocol is authoritative only for generated execution.
- AuthoringPlan stores the exact WorkflowProtocol hash.
- Cross-validation rejects prose that declares undeclared runtime behavior.

### 17.2 State duplication

Control:

- Creator lifecycle state remains under .badger/states.
- Authoring records remain under .badger/authoring.
- Runtime Runs remain under .badger/runs.
- Each state model has a distinct schema, owner, and recovery operation.

### 17.3 Generator duplication

Control:

- subagents write reports and content leaves only;
- the Badger assembler writes final package files;
- deterministic Auto-zone sections cannot be replaced by authored content;
- one package has one runtime asset and one set of state/guard/handoff
  authorities.

### 17.4 Review duplication

Control:

- authoring review evaluates content and composition;
- deterministic eval evaluates package and runtime behavior;
- publication approval records the human decision to publish;
- each verdict has separate evidence and hashes.

### 17.5 Decision duplication

Control:

- pause-points guidance explains choices;
- WorkflowProtocol declares executable choices;
- WorkflowRuntime validates and records decisions;
- authored Markdown cannot add hidden decision exits.

### 17.6 Recovery duplication

Control:

- reference/recovery.md explains how an agent should resume authoring or a
  generated Node;
- WorkflowRuntime recover reconstructs executed Run state;
- authoring storage recovery reconstructs lane status and record validity;
- neither recovery system treats conversation history as authoritative.

### 17.7 Eval duplication

Control:

- authoring review may be provider-backed;
- runtime evaluation remains deterministic and mandatory;
- readiness combines both evidence classes without allowing one to replace the
  other.

## 18. Implementation phases

The phases below record separately reviewed delivery batches. Phases 0 through
7 are complete on the current branch; the acceptance lists remain useful
regression criteria for future changes.

### Phase 0: Contract and evidence baseline

Deliver:

- a reference-by-reference parity matrix for generic upstream authoring;
- exact current Badger generated artifact inventory;
- current Creator lifecycle and hash inventory;
- explicit decisions for default authoring mode, command compatibility, and
  review depth;
- no source behavior changes.

Acceptance:

- upstream authoring functions are mapped to retained, replaced, or restored
  Badger mechanisms;
- Classic, Native, Entry, and platform behavior is visibly excluded;
- the matrix becomes the acceptance source for later phases.

Phases 1 through 4 restore the upstream-compatible authoring core. Phases 5
through 7 add Badger hardening and integration. A phase must not be marked
complete merely because its new types compile; its restoration or hardening
acceptance criteria must pass independently.

### Phase 1: Authoring domain model

Deliver:

- src/authoring/types.ts;
- src/authoring/protocol.ts;
- AuthoringPlan derivation and validation;
- lane, claim, artifact, review, and readiness types;
- bounded hash model;
- reference/authoring-protocol.json and generic authoring references.

Acceptance:

- canonical six-lane DAG validates;
- malformed, duplicated, unknown, or reordered lanes fail closed;
- AuthoringPlan carries the normalized WorkflowProtocol in
  workflowProtocolHash and preserves protocolHash for the AuthoringProtocol;
- no runtime behavior changes;
- current package tests remain green.

### Phase 2: Authoring storage and lifecycle

Deliver:

- .badger/authoring storage;
- state summary integration;
- record validation and atomic persistence;
- dependency checks;
- stale hash detection;
- authoring-status read path;
- fresh-process recovery tests;
- concurrent record conflict tests.

Acceptance:

- records cannot bypass dependencies;
- BLOCKED and NEEDS_CONTEXT stop downstream lanes;
- stale plan, protocol, source, or authoring-input evidence is rejected;
- partial writes do not replace the last valid record;
- recovered authoring state is identical across processes.

### Phase 3: CLI and dispatch seam

Deliver:

- authoring-plan;
- authoring-status;
- authoring-record;
- provider-neutral file handoff;
- manual authoring fixture provider;
- bounded report validation;
- no provider credential handling.

Acceptance:

- all six lanes can be completed through file handoff;
- an invalid lane report cannot mutate state;
- a provider cannot write Bundle state directly;
- authoring operations do not execute candidate scripts;
- parallel wave-one records are safe.

### Phase 4: Scaffold and authored assembly

Deliver:

- generator refactor into scaffold and assembly;
- Auto-zone/Authored-zone composition;
- authored content allowlist;
- generated authoring references;
- the three upstream-equivalent deterministic plan/check/hook roles under
  Badger naming;
- placeholder detection;
- deterministic authored material hashing;
- upgrade-existing source preservation.

Acceptance:

- generated entry and Node Skills contain substantive authored sections;
- Auto-zone sections are unchanged by authored content;
- missing guidance blocks assembly;
- source files remain preserved in upgrade mode;
- generated package hashing is deterministic;
- the complete six-script control-plane coverage is present and protocol
  bound;
- no second runtime or adapter authority is emitted.

### Phase 5: Authoring review and readiness

Deliver:

- quick/full authoring review records;
- review findings and verdict normalization;
- contract-fit, usability, evidence-trace, and self-consistency checks;
- combined authoring/runtime/publication readiness;
- updated review and approve commands.

Acceptance:

- missing or stale review blocks publication;
- Critical and Important findings block readiness;
- publication reviewer and authoring reviewer remain distinct evidence;
- deterministic runtime evaluation remains mandatory;
- no fabricated LLM/provider evidence is accepted.

### Phase 6: Runtime cross-validation

Deliver:

- consistency checks between authored content and WorkflowProtocol;
- checks that declared decisions, Required Skill Calls, routes, Output Schemas,
  and recovery references agree;
- current WorkflowRuntime certification over assembled packages;
- negative cases for hidden exits and stale authored content.

Acceptance:

- authored content cannot alter route selection;
- runtime state and authoring state remain separate;
- generated adapters remain thin over WorkflowRuntime;
- all current Phase 3 and Phase 4 runtime certifications remain valid.

### Phase 7: Documentation, fixtures, and release

Status: Complete. See `docs/release-artifacts.md` for the shipped artifact map
and release gate.

Deliver:

- Badger Skill entrypoint updated with authoring protocol;
- authoring references and role briefs;
- README and extraction-map corrections;
- complete synthetic authoring fixture;
- package inventory and differential report updates;
- build, test, format, package, and diff checks.

Acceptance:

- documentation describes the actual lifecycle and no deferred feature as
  present;
- generated package contains all required authoring references;
- fresh-process, crash-boundary, stale-hash, and concurrent-lane tests pass;
- platform/dashboard behavior remains absent and clearly deferred.

## 19. Test strategy

### Unit tests

- AuthoringProtocol schema and lane order;
- dependency DAG validation;
- claim and artifact validation;
- content-leaf path and heading validation;
- hash derivation and stale evidence;
- review verdict and finding severity;
- readiness composition;
- safe bounded output handling.

### Integration tests

- full manual six-lane authoring lifecycle;
- blocked and NEEDS_CONTEXT lane recovery;
- parallel wave-one and wave-two scheduling;
- authored assembly for one Node and multiple Nodes;
- upgrade-existing source preservation;
- deterministic regeneration;
- package publication only after all gates;
- authoring-state and Creator-state recovery.

### Runtime compatibility tests

- generated state, guard, and handoff adapters;
- route conformance;
- decision Nodes and receipts;
- Cycles and Attempts;
- versioned artifacts;
- snapshots, receipts, repair, checkpoints, locks, and finalization;
- fresh-process recovery;
- current Phase 3 and Phase 4 certifications.

### Negative tests

- missing authoring record;
- stale protocol or source hash;
- missing claim;
- unsupported claim;
- missing authored section;
- placeholder content;
- authored route or decision not present in WorkflowProtocol;
- direct subagent state write;
- command/provider prefix leakage;
- content path escape;
- symlink authoring artifact;
- concurrent record conflict;
- publication with authoring review missing;
- publication with runtime evaluation stale;
- publication with mismatched package hash.

### Differential evidence

Extend the current differential harness with an authoring-aware comparison:

- source candidate status;
- source and reference hashes;
- normalized WorkflowProtocol;
- AuthoringPlan lane DAG;
- generated Auto-zone inventory;
- authored content-leaf inventory;
- authoring readiness;
- deterministic runtime readiness.

The comparison must classify expected Badger naming and namespace differences
separately from semantic mismatches. It must not claim full upstream parity for
excluded Classic, Native, Entry, or platform behavior.

## 20. Documentation changes

Update:

- assets/skills/badger/SKILL.md
  Add the integrated authoring lifecycle, lane semantics, confirmation rules,
  and distinction between authoring review and runtime evaluation.
- assets/skills/badger/reference/workflow-contract.md
  Keep it as the executable WorkflowProtocol reference and cross-link the
  separate AuthoringProtocol.
- assets/skills/badger/reference/authoring-protocol.json
  Add the canonical authoring DAG and merge contract.
- assets/skills/badger/reference/authored-zone-example.md
  Document the quality bar for entry Decision Core and Node Guidance.
- assets/skills/badger/reference/authoring-subagents.md
  Document provider-neutral role briefs and file handoff.
- assets/skills/badger/reference/subagents/*.md
  Add the six generic workflow-kernel briefs, without Classic or Native
  instructions.
- assets/skills/badger/reference/bundle-authoring.md
  Describe Badger scaffold, assembly, generated artifacts, and lifecycle.
- assets/skills/badger/reference/eval-provider.md
  Separate authoring review, deterministic runtime evaluation, and publication
  approval.
- docs/extraction-map.md
  Replace the current authoring follow-up with the integrated architecture and
  explicit exclusions.
- README.md
  Describe authoring-required generation and the two protocol layers.

All formal Skill and package-facing documentation remains in English.

The completed Phase 7 release artifacts are indexed in
`docs/release-artifacts.md`. The checked-in
`assets/skills/badger/reference/package-inventory.example.json` covers every
deterministic backbone path and all six role briefs without session or audit
material. The compatibility fixture and differential source snapshots include
the reference set and explicit excluded scopes.

## 21. Retained delivery decisions

The following choices were settled by the implementation and remain the
compatibility policy:

1. Default mode:
   Recommended: authoring is required for all new and upgrade-existing
   workflows. Legacy scaffold-only packages remain readable but are not
   authoring-complete.
2. Command compatibility:
   Recommended: retain generate as scaffold generation and add assemble as the
   final authored-package operation.
3. Storage:
   Recommended: separate .badger/authoring state from .badger/runs while
   reusing shared hashing, atomic-write, and finding primitives.
4. Runtime reuse:
   Recommended: do not model authoring as an ordinary user Run. Build a
   domain-specific AuthoringLifecycle that uses shared primitives and leaves
   WorkflowRuntime authoritative for generated workflow execution.
5. Provider model:
Recommended: implement manual/file-based authoring first, then add injected
   providers without credentials or direct filesystem authority.
6. Review policy:
   Recommended: quick and full modes both require all lanes; full mode adds
   independent multi-vote review.
7. Authored content boundary:
   Recommended: protect Auto zones and allow authored content only in declared
   Decision Core, Guidance, and reference leaves.
8. Platform/dashboard:
   Recommended: expose stable local contracts now and defer all UI/platform
   adapters to a separate future project.

## 22. Definition of done

The upgrade is complete only when all of the following are true:

- Badger can author a workflow-kernel Skill from a confirmed goal and real
  source Skill evidence through the six lanes.
- Authoring can pause, block, resume, and recover without conversation-memory
  dependence.
- Every authored claim and artifact is hash-bound and auditable.
- Entry and Node content contains substantive domain guidance rather than only
  deterministic boilerplate.
- Authored content is assembled into a deterministic package without allowing
  authored prose to become a hidden runtime authority.
- Authoring review, deterministic runtime evaluation, and publication approval
  are distinct current-hash gates.
- WorkflowRuntime remains the sole execution authority.
- Existing runtime durability and certification behavior remains intact.
- Upgrade-existing preserves source package identity and content.
- No Classic, Native, Entry, host platform, or dashboard behavior is silently
  reintroduced.
- Documentation, generated assets, tests, and package inventory agree with the
  implementation.

The important architectural conclusion is that authoring belongs inside
Badger, but it must remain a distinct meta-workflow with its own protocol,
state, evidence, and review. Deep integration means shared foundations and a
single deterministic assembly boundary; it does not mean merging authoring
state with executed Runs or allowing two systems to compete over runtime
behavior.
