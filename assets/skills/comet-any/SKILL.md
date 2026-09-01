---
name: comet-any
description: Create a new workflow Skill or upgrade an existing Skill through the standalone Comet-any Creator. Not for general Skill cleanup, Classic/Native workflow management, or platform installation.
disable-model-invocation: true
---

# Comet-any Creator

This Skill is the user-facing coordinator for the standalone Comet-any factory. It turns a goal plus real Skill evidence into a deterministic `workflow-kernel` package.

## Supported intents

- **Create a new workflow Skill**: design custom Workflow Nodes, bindings, Output Schemas, guardrails, and handoffs from the goal and resolved source Skills.
- **Upgrade an existing Skill**: copy a selected source package, add the workflow control plane, and preserve the source package identity in the draft evidence.

The standalone package deliberately excludes Classic customization, Native workflow management, ambient Entry routing, host platform installers, and Engine execution adapters.

## Confirmation protocol

1. Run `comet-any guide --project <dir> --json` to inspect preferences and resumable Creator state.
2. Run `comet-any candidates --project <dir> --json` and inspect real Skill roots, descriptions, references, scripts, and hashes.
3. Write a complete plan JSON and run `comet-any propose <plan.json> --project <dir> --json`.
4. Show the user the goal, intent, Nodes, implementations, Required Skill Calls, Output Schemas, blockers, and warnings.
5. Wait for explicit confirmation. Do not initialize state or generate files before confirmation.
6. Run `comet-any init <plan.json> --confirm --project <dir>`.
7. Run `comet-any generate <name> --project <dir>`, then `comet-any eval <name> --project <dir>`.
8. Show `comet-any review <name> --project <dir> --json`; publish only after the user names a reviewer and confirms approval.
9. Run `comet-any approve <name> --reviewer <id> --confirm`, then `comet-any publish <name> --confirm`.
10. Start with `comet-any distribute <name> --destination <dir>` to preview files. The standalone tool does not install into Agent platform directories.

## Contract rules

- `reference/workflow-protocol.json` is the single runtime contract for Node order, state, Output Schemas, and recovery edges.
- Every custom Node declares a responsibility and implementation Skill. Required calls augment an implementation; they never replace it.
- Human choices are explicit `decision` Nodes with stable choice ids and declared transition targets; generated guidance cannot create hidden decision exits.
- Decision Nodes wait through Engine `ask_user` actions. Hosts forward typed responses with reviewer attestation through WorkflowRuntime; adapters do not authenticate, route, or write receipts.
- Decision Nodes may declare optional or required artifact/evidence scope entries. WorkflowRuntime captures accepted version ids, hashes, and producer identities; adapters render and forward those references without exposing contents or storing attachments.
- Every WorkflowRuntime continuation includes a versioned, bounded `findings` catalog. Use finding codes, severity, required actions, registered operation argument arrays, and `requiresUserDecision`; legacy `blockers` are derived compatibility text only.
- A `verified-checkpoints` durability profile publishes content-addressed checkpoint manifests only after committed mutations. Recovery prefers a verified authoritative Run head; it reports invalid candidates and restores an older checkpoint only when trajectory evidence proves there was no later committed transition.
- A `content-snapshots` durability profile captures one explicitly declared, bounded physical-tree scope at Run start. Snapshot references contain only safe paths, sizes, hashes, policy, provider, and bounded omission evidence; incomplete or unstable captures never satisfy a complete scope, and hosts must reject protected roots before enumeration.
- `continue` means executable machine work is available, `await-user` means a persisted decision is pending, `blocked` means an unresolved repair or stop condition prevents advancement, and `done` means the Run is terminal. Adapters must render these values without reclassification.
- Control Nodes cannot be overridden. Producer overrides must declare every Output Schema they satisfy.
- Unresolved or ambiguous Skill candidates, stale hashes, failed eval, missing review, and missing confirmation block the next mutating step.
- `comet-any eval` includes a current-hash synthetic Phase 3 decision-and-cycle certification; passing it does not authorize biological execution, package installation, Native-derived durability, or Primer Designer migration.
- Generated packages and published copies are local filesystem artifacts. Review the preview before copying them elsewhere.
