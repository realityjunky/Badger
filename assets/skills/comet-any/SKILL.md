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
7. Run `comet-any generate <name> --project <dir>`, then `comet-any authoring-plan <name> --project <dir> --json`.
8. Author the generated scaffold and record each lane with `comet-any authoring-record <name> --lane <lane> --file <record.json>` in DAG order.
9. Treat `BLOCKED`, `NEEDS_CONTEXT`, missing records, scaffold markers, stale hashes, and invalid control-plane files as hard stops. Re-record affected lanes after Bundle edits.
10. Run `comet-any eval <name> --project <dir>`, then show `comet-any review <name> --project <dir> --json`; publish only after the user names a reviewer and confirms approval.
11. Run `comet-any approve <name> --reviewer <id> --confirm`, then `comet-any publish <name> --confirm`.
12. Start with `comet-any distribute <name> --destination <dir>` to preview the complete Bundle file list. The standalone tool does not install into Agent platform directories.

## Contract rules

- `reference/workflow-protocol.json` is the single runtime contract for Node order, state, Output Schemas, and recovery edges.
- Every custom Node declares a responsibility and implementation Skill. Required calls augment an implementation; they never replace it.
- Control Nodes cannot be overridden. Producer overrides must declare every Output Schema they satisfy.
- The authoring plan is the canonical six-lane DAG: `script`, `reference`, `pause-points`, `workflow-entry`, `skill-core`, and `skill-review`.
- The authoring plan is stored at `.comet-any/authoring/<name>/plan.json`, outside the generated Bundle hash; lane records are stored beside it.
- Authoring records are stored outside the hashed Bundle, but every record binds to the current Bundle and protocol hashes. `BLOCKED` and `NEEDS_CONTEXT` records halt downstream lanes.
- Unresolved or ambiguous Skill candidates, scaffold content, stale hashes, failed eval, invalid control-plane files, missing authoring records, missing review, and missing confirmation block the next mutating step.
- Generated packages and published copies are local filesystem artifacts. Review the preview before copying them elsewhere.
