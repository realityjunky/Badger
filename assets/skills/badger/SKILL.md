---
name: badger
description: Create a new workflow Skill or upgrade an existing Skill through the standalone Badger Creator. Not for general Skill cleanup, Classic/Native workflow management, or platform installation.
disable-model-invocation: true
---

# Badger Creator

This Skill is the user-facing coordinator for the standalone Badger factory. It turns a goal plus real Skill evidence into a deterministic `workflow-kernel` package.

## Supported intents

- **Create a new workflow Skill**: design custom Workflow Nodes, bindings, Output Schemas, guardrails, and handoffs from the goal and resolved source Skills.
- **Upgrade an existing Skill**: copy a selected source package, add the workflow control plane, and preserve the source package identity in the draft evidence.

The standalone package deliberately excludes Classic customization, Native workflow management, ambient Entry routing, host platform installers, and Engine execution adapters.

## Confirmation protocol

1. Run `badger guide --project <dir> --json` to inspect preferences and resumable Creator state.
2. Run `badger candidates --project <dir> --json` and inspect real Skill roots, descriptions, references, scripts, and hashes.
3. Write a complete plan JSON and run `badger propose <plan.json> --project <dir> --json`.
4. Show the user the goal, intent, Nodes, implementations, Required Skill Calls, Output Schemas, blockers, and warnings.
5. Wait for explicit confirmation. Do not initialize state or generate files before confirmation.
6. Run `badger init <plan.json> --confirm --project <dir>`.
7. Run `badger generate <name> --project <dir>` to create the deterministic authoring-pending scaffold.
8. Run `badger authoring-status <name> --project <dir> --json`. For each executable lane, create a bounded file handoff with `badger authoring-dispatch <name> --lane <lane> --output <file>`, have the provider return the upstream lane-output JSON, then submit it with `badger authoring-record <name> --lane <lane> --file <file> --expected-revision <revision>`. Run `badger assemble <name>` only after all six lanes are complete.
9. Run `badger eval <name> --project <dir>` and show `badger review <name> --project <dir> --json`; publish only after the user names a reviewer and confirms approval.
10. Run `badger approve <name> --reviewer <id> --confirm`, then `badger publish <name> --confirm`.
11. Start with `badger distribute <name> --destination <dir>` to preview files. The standalone tool does not install into Agent platform directories.

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
