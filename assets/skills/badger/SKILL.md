---
name: badger
description: Create or upgrade a workflow Skill through standalone Badger Creator from inside an Agent. Supply explicit Skill sources before discovery. Not for general Skill cleanup, Classic/Native workflow management, or platform installation.
disable-model-invocation: true
---

# Badger Creator

This Skill is the user-facing Agent coordinator for the standalone Badger factory. The user invokes
it explicitly in an Agent (for example, `/badger`); the Agent turns the user's goal and explicitly
supplied Skill evidence into a deterministic `workflow-kernel` package. The Agent owns source
selection, candidate interpretation, plan presentation, and the handoff to the read-only and
write-gated Badger CLI commands.

## Explicit source workflow

Badger uses a closed-world source set. Every Skill used by a workflow must be supplied as a name and
location in the FactoryPlan's `skillSources` array. Locations may be project-relative or absolute;
Badger canonicalizes and hashes the actual package and never scans project or home Skill roots.

1. Establish the project root and intent, then inspect resumable Creator state without changing it.
2. Inspect each supplied source with `badger candidates --skill <name=location> --json`; repeat
   `--skill` for every source. Review canonical roots, descriptions, references, scripts, and hashes.
3. Ask focused questions about the desired outcome, inputs, outputs, Nodes, decisions, evidence,
   guardrails, recovery, and each Skill's workflow role.
4. Build a complete FactoryPlan with explicit `skillSources`, implementation bindings, Required Skill
   Calls, augmentations, schemas, routes, and upgrade source identity where applicable.
5. Run `badger guide --project <dir> --json`, then `badger propose`, show the complete proposal, and
   wait for explicit confirmation before `badger init --confirm` or any generation.

Candidate inspection is read-only. It never executes scripts, writes a FactoryPlan or Creator state,
copies a package, publishes, distributes, or accesses credentials.

## Supported intents

- **Create a new workflow Skill**: design custom Workflow Nodes, bindings, Output Schemas, guardrails, and handoffs from the goal and resolved source Skills.
- **Upgrade an existing Skill**: copy a selected source package, add the workflow control plane, and preserve the source package identity in the draft evidence.

The standalone package deliberately excludes Classic customization, Native workflow management, ambient Entry routing, and host platform installers. Its generated runtime adapters are thin projections over Badger WorkflowRuntime; they are not a second execution authority.

## Confirmation protocol

1. Complete the explicit source workflow above and run `badger candidates` for every supplied source.
2. Write a complete plan JSON with `skillSources` and run `badger propose <plan.json> --project <dir> --json`.
3. Show the user the goal, intent, Nodes, implementations, Required Skill Calls, Output Schemas, blockers, and warnings.
4. Wait for explicit confirmation. Do not initialize state or generate files before confirmation.
5. Run `badger init <plan.json> --confirm --project <dir>`.
6. Run `badger generate <name> --project <dir>` to create the deterministic authoring-pending scaffold. Existing deterministic drafts without an authoring session are `legacy-scaffold-only`: they remain readable compatibility artifacts but are not authoring-complete or publishable. Use `badger migrate <name> --confirm` to preserve the draft as source evidence, derive a fresh AuthoringPlan, and resume all required lanes.
7. Run `badger authoring-status <name> --project <dir> --json`. For each executable lane, create a bounded file handoff with `badger authoring-dispatch <name> --lane <lane> --output <file>`, have the provider return the upstream lane-output JSON, then submit it with `badger authoring-record <name> --lane <lane> --file <file> --expected-revision <revision>`. Run `badger assemble <name>` only after all six lanes are complete.
8. Upgrade-existing migration records a source tree hash and explicit `retained`, `replaced`, or `wrapped` decision for every source file. The original source tree remains under `source/`; generated summaries never silently replace source bodies.
9. Run `badger eval <name> --project <dir>` and show `badger review <name> --project <dir> --json`; publish only after the user names a reviewer and confirms approval.
10. Run `badger approve <name> --reviewer <id> --confirm`, then `badger publish <name> --confirm`.
11. Start with `badger distribute <name> --destination <dir>` to preview files. The standalone tool does not install into Agent platform directories.

## Authoring contract

Badger restores the upstream-compatible six-lane package-construction
contract and adds durable, hash-bound records around it. The lanes are:

| Lane             | Dependency wave       | Output boundary                                                                                                 |
| ---------------- | --------------------- | --------------------------------------------------------------------------------------------------------------- |
| `script`         | Wave 1                | Claims for the three WorkflowRuntime adapters and three Badger-named plan/check/hook roles; no authored leaves. |
| `reference`      | Wave 1                | Resolved Skills, normalized `WorkflowProtocol`, composition evidence, and lane metadata; no authored leaves.    |
| `pause-points`   | Wave 1                | `reference/decision-points.md` and `reference/recovery.md`.                                                     |
| `workflow-entry` | Wave 2 after `script` | The entry `SKILL.md` Decision Core.                                                                             |
| `skill-core`     | Wave 2 after `script` | One substantive Guidance section for every active internal Node Skill.                                          |
| `skill-review`   | Barrier               | `reference/skill-review.md` and the authoring review verdict.                                                   |

Wave 1 runs `script`, `reference`, and `pause-points` independently. Wave 2
runs `workflow-entry` and `skill-core` after the script contract is accepted.
`skill-review` waits for every preceding lane. The detailed claims, role-brief
paths, review settings, deterministic backbone, and content-leaf allowlist are
in `reference/authoring-protocol.json` and
`reference/authoring-subagents.md`.

Each lane uses provider-neutral file handoff. A provider receives only its
role brief, bounded common inputs, dependency artifacts, and input identities;
it returns a bounded report with status, claims, artifacts, and findings. It
cannot write Creator or authoring state, execute candidate Skills, publish,
distribute, access credentials, or invent routes. `BLOCKED` and `NEEDS_CONTEXT`
stop dependent lanes while preserving their evidence.

Assembly keeps the deterministic Auto zone separate from the Authored zone.
The Auto zone owns protocol and source references, manifests, package
inventory, generated runtime and Badger control-plane scripts, guardrails,
checks, and evaluation declarations. The Authored zone is limited to the
declared Decision Core, Node Guidance, decision-point, recovery, and review
leaves. Missing or placeholder content keeps assembly blocked. See
`reference/bundle-authoring.md` and
`reference/package-inventory.example.json` for the package-facing contract and
a safe inventory example.

## Review and readiness

`badger review <name> --json` reports separate authoring, runtime, and publication sections. Authoring review is the `skill-review` lane barrier: quick mode records one voter and one round; full mode records three independent voters, all four lenses, a two-round dry threshold, and no more than four rounds. Provider findings require bound voter evidence and are confirmed by majority in full mode. Deterministic self-consistency checks and WorkflowProtocol cross-validation always remain separate evidence over authored decisions, routes, required calls, schemas, guardrails, recovery ownership, artifact selection, commands, paths, claims, generated artifacts, and package identity. Cross-validation never selects routes or mutates WorkflowRuntime state.

Critical or Important findings, unresolved concerns, missing or stale review hashes, and unbound provider evidence block authoring readiness. A passing authoring review never substitutes for deterministic evaluation or WorkflowRuntime certification. `badger approve` records only distinct human publication approval after every earlier readiness section passes and requires `--confirm`.

## Contract rules

- `reference/workflow-protocol.json` is the single runtime contract for Node order, state, Output Schemas, and recovery edges.
- Every custom Node declares a responsibility and implementation Skill. Required calls augment an implementation; they never replace it.
- Human choices are explicit `decision` Nodes with stable choice ids and declared transition targets; generated guidance cannot create hidden decision exits.
- Decision Nodes wait through Engine `ask_user` actions. Hosts forward typed responses with reviewer attestation through WorkflowRuntime; adapters do not authenticate, route, or write receipts.
- Decision Nodes may declare optional or required artifact/evidence scope entries. WorkflowRuntime captures accepted version ids, hashes, and producer identities; adapters render and forward those references without exposing contents or storing attachments.
- Verification guards may require a bounded automated-check, static-inspection, or manual-evidence receipt. WorkflowRuntime owns receipt issue time, content identity, scope freshness, and storage; generated adapters forward proposals or exact receipt references without running verifier commands or storing raw output.
- A `repair-policy` durability profile makes failed outcomes finite and evidence-bound. WorkflowRuntime owns canonical failure signatures, semantic-progress detection, warning/manual-stop thresholds, persisted repair decisions, one-time override checks, and the non-overridable hard stop; generated adapters only forward failed outcomes or declared decisions.
- Every WorkflowRuntime continuation includes a versioned, bounded `findings` catalog. Use finding codes, severity, required actions, registered operation argument arrays, and `requiresUserDecision`; legacy `blockers` are derived compatibility text only.
- A `verified-checkpoints` durability profile publishes content-addressed checkpoint manifests only after committed mutations. Recovery prefers a verified authoritative Run head; it reports invalid candidates and restores an older checkpoint only when trajectory evidence proves there was no later committed transition.
- A `content-snapshots` durability profile captures one explicitly declared, bounded physical-tree scope at Run start. Snapshot references contain only safe paths, sizes, hashes, policy, provider, and bounded omission evidence; incomplete or unstable captures never satisfy a complete scope, and hosts must reject protected roots before enumeration.
- `continue` means executable machine work is available, `await-user` means a persisted decision is pending, `blocked` means an unresolved repair or stop condition prevents advancement, and `done` means the Run is terminal. Adapters must render these values without reclassification.
- Control Nodes cannot be overridden. Producer overrides must declare every Output Schema they satisfy.
- Unresolved or ambiguous Skill candidates, stale hashes, failed eval, missing review, and missing confirmation block the next mutating step.
- Confirmed generation creates a resumable authoring session under `.badger/authoring/<name>`; a scaffold is not authored, assembled, evaluated, or publishable until current lane records are assembled.
- Assembly uses a staged deterministic scaffold and one protected swap; it preserves source-owned files, inserts authored material only at declared leaves, and records the final relative package inventory.
- The generated control plane contains `workflow-state`, `workflow-guard`, and `workflow-handoff` adapters over WorkflowRuntime plus Badger-named `badger-plan`, `badger-check`, and `badger-hook-guard` roles. Their mapping and claim ownership are recorded in `reference/authoring-lanes.json`.
- Lane outputs preserve `DONE`, `DONE_WITH_CONCERNS`, `BLOCKED`, and `NEEDS_CONTEXT`. Blocking statuses require a bounded explanation and stop dependents; concerns remain visible and block final authoring readiness until resolved.
- Authoring status reports completed lanes, next executable lanes, dependency waves, claims, artifacts, findings, input hashes, revision, and fresh-process recovery paths. Use expected revisions for concurrent submissions.
- Providers receive only file handoffs and bounded capability metadata. They cannot write Creator or authoring state, execute candidate Skills, publish, distribute, or access credentials. The manual file-provider fixture uses the same submission path without credentials.
- `badger eval` includes a current-hash synthetic Phase 3 decision-and-cycle certification; passing it does not authorize biological execution, package installation, Native-derived durability, or Primer Designer migration.
- Generated packages and published copies are local filesystem artifacts. Review the preview before copying them elsewhere.
