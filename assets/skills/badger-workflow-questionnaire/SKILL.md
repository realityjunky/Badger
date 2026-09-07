---
name: badger-workflow-questionnaire
description: Elicit the confirmed workflow information needed to author a complete Badger FactoryPlan from explicitly supplied Skills.
disable-model-invocation: true
---

# Badger Workflow Questionnaire

This Skill is the discovery companion for Badger Creator. It helps an Agent turn an informal
workflow idea and explicitly supplied Skill evidence into a complete, user-confirmed
`FactoryPlan`. It does not discover ambient Skills, write project configuration, or execute source
Skills.

## Outcome

The handoff contains:

- the project root and `new-skill` or `upgrade-existing` intent;
- explicit Skill source declarations with each Skill name and location;
- source facts read from `SKILL.md`, references, scripts, and hashes;
- a workflow brief covering outcome, inputs, outputs, decisions, evidence, guardrails, and recovery;
- Node responsibilities, implementation bindings, Required Skill Calls, augmentations, schemas,
  routes, bounded cycles, and upgrade-source identity where applicable; and
- unresolved questions and assumptions clearly separated from confirmed user answers.

## Agent protocol

1. Establish the project root and determine whether the request creates or upgrades a workflow
   Skill. Inspect existing Creator state and FactoryPlan context without changing it.
2. Ask the user to provide each source Skill as a name and project-relative or absolute location.
   Inspect only those declarations with `badger candidates --skill <name=location> --json`.
3. Read the returned descriptions, reference inventory, script inventory, canonical roots, and
   hashes. Never execute a source Skill or infer a source from an ambient directory.
4. Ask grouped questions about the outcome, inputs, meaningful Nodes, genuine decisions, required
   artifacts and evidence, guardrails, handoffs, optional routes, failure, pause, retry, and recovery.
5. After every exchange, summarize confirmed facts, source evidence, assumptions, and remaining gaps.
6. Stop only when the FactoryPlan completeness checklist passes or the user explicitly chooses to
   stop with unresolved gaps. Do not call `badger propose` while required fields remain unresolved.
7. Show the complete FactoryPlan, including `skillSources`, and obtain confirmation before proposal
   construction. Proposal confirmation remains separate from Creator initialization confirmation.

## Completeness checklist

Before handoff, verify goal and intent; explicit source locations; source roles; workflow name and
goal; Node IDs, kinds, responsibilities, and implementation bindings; Required Skill Calls;
augmentations; inputs; Output Schemas; artifacts; evidence; guardrails; decisions; transitions and
routes; optional Nodes; bounded cycles; capabilities; finalization; locale; upgrade source identity;
executable disclosures; pause and recovery behavior; and unresolved assumptions.

## Read-only boundary

This Skill may inspect supplied source files and ask questions. It must not write configuration,
FactoryPlan, Creator state, generated package, publication record, or distribution output. It must
not execute scripts, publish, distribute, or access credentials.

## Handoff

Return a compact handoff containing the confirmed goal, intent, explicit source declarations,
candidate evidence, workflow decisions, unresolved questions, and the next read-only Badger command.
Clearly label facts supplied by the user, facts read from source files, and Agent design choices.
