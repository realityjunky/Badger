---
name: badger-workflow-questionnaire
description: Conduct a progressive multi-exchange discovery conversation for a complete, user-confirmed Badger FactoryPlan from explicitly supplied Skills.
disable-model-invocation: true
---

# Badger Workflow Questionnaire

This is the read-only discovery companion for `/badger-create`. It turns a
workflow idea and explicitly supplied Skill evidence into a structured,
user-confirmed FactoryPlan handoff. It does not discover ambient Skills,
write a plan or project configuration, execute source Skills, or initialize
Creator state.

## Start and resume

1. Establish the project root and the `new-skill` or `upgrade-existing` intent.
2. Run `badger guide --project <dir> --json`, adding `--plan <file>` for an
   existing plan file that is not yet in Creator state.
3. If the guide reports `firstUse: true` and
   `questionnaire.mode: automatic-first-use`, start discovery immediately.
   This automatic path applies only when no FactoryPlan or resumable Creator
   flow exists for the project.
4. If the guide reports `factoryPlans` or `resumable` context,
   `questionnaire.mode` is `manual-refinement`; preserve the existing plan and
   authoring state. Never silently overwrite or restart it.
   Continue only when the user explicitly asks for questionnaire refinement or
   repair, and tie the handoff to the existing plan and state context.

## Evidence before questions

Before asking the first question, read the workflow manual supplied with the
Badger package, including `docs/badger-workflow-manual.html` when working from
the repository. Read the manual in full enough to apply its Agent/backend
boundary, FactoryPlan shape, relationship semantics, and completeness
checklist.

Ask the workflow owner to provide every source Skill as a name and a
project-relative location, or an absolute location inside the project or a
registered source root, as explicit Skill source declarations. Inspect only
those declarations with the source check:

```bash
badger source-check --project <dir> --skill <name=location> --json
```

Repeat `--skill` for every source or use an explicit source manifest. For
absolute locations outside the project, pass the roots the host registers with
`--source-root` or `BADGER_SOURCE_ROOTS`; a manifest cannot register roots.
Read each source's description, canonical path, full file inventory with
hashes, ignored files, script side effects, and identity hash. Then read each
supplied `SKILL.md` and every other inventoried file, configuration included,
as source evidence. Do not execute scripts or treat an inventory entry as
permission to run it; the side effects reported for a script (`none`,
`local-writes`, `network`, `scheduler-submission`, `installs`, or `undeclared`)
only describe it.

Do not ask semantic questions until all supplied source evidence has been
read. Source metadata may establish facts such as a Skill's purpose or
available references; it cannot establish the workflow owner's desired
outcome, decisions, safety rules, or recovery policy.

## Exchange loop

Ask grouped, high-value questions one exchange at a time. Cover:

- workflow outcome, intent, inputs, prerequisites, and completion meaning;
- meaningful Node stages, responsibilities, ordering, and optional stages;
- each supplied Skill's implementation, Required Skill Call, or augmentation
  role;
- artifacts, evidence, Output Schemas, validation, and guardrails per Node;
- data contracts between Nodes: shapes, columns, file naming, and the evidence
  one Node's output must provide for the next Node's input;
- genuine user decisions, stable choices, reviewer or recipient handoffs, and
  routing outcomes;
- failure, pause, retry, recovery, bounded cycles, and finalization behavior;
- executable disclosures, capabilities, locale, and upgrade-source identity.

After every exchange, show the same five-part ledger:

1. **Confirmed user facts** — statements or decisions explicitly confirmed by
   the workflow owner, with provenance: who confirmed it, the answer revisions
   it restates, and the answering Field expert's acknowledgement.
2. **Source-derived facts** — facts read from the manual or supplied Skill
   files, references, scripts, and hashes.
3. **Agent inferences** — design choices proposed to connect facts; each must
   be labeled and confirmed before it becomes part of the plan.
4. **Unresolved assumptions** — unknown or contradictory points that must not
   be presented as facts.
5. **Remaining questions** — the next high-value questions and the field each
   question will resolve.

A question internal to one Skill, or outside the workflow's scope, may instead
be deferred with its resolution: its scope, the Skill whose backlog holds it
when the scope is a Skill, and a reason. A deferral needs no further exchange
and never blocks handoff; an unresolved question still does. Call that recorded
outcome the question's resolution, not its disposition.

Continue the loop until the completeness checklist passes. A user may
explicitly stop with unresolved gaps; in that case preserve the gaps in a
`stopped` handoff and do not construct a proposal.

## Completeness checklist

Before handoff, verify all of the following:

- goal, intent, workflow name, workflow goal, and default locale;
- every explicit Skill source's location as the FactoryPlan declares it,
  content hash, and workflow role, using the source identity in the dossier
  reference;
- workflow inputs and prerequisites;
- Node IDs, kinds, labels, responsibilities, ordering, and optionality;
- implementation bindings, Required Skill Calls, and augmentations;
- data contracts between Nodes, including their columns, file names, and
  handoff evidence;
- Output Schemas attached to concrete Nodes, including artifacts and evidence;
- decisions, stable choice IDs, input and reviewer requirements;
- guardrails and their validation or evidence requirements;
- success, failure, pause, conditional, completion, and handoff routes;
- bounded cycle entries, repeat transitions, and maximum instances;
- capabilities, finalization, executable disclosures, and recovery behavior;
- `sourceRoot` and upgrade-source identity when upgrading an existing Skill;
- every confirmed fact carries provenance, and every deferred question carries
  its resolution with a scope, a reason, and its Skill when the scope is a
  Skill backlog;
- unresolved assumptions and remaining questions are either resolved or
  explicitly accepted as a user-requested stopped handoff.

Do not call `badger propose` if a required field is unresolved, contradictory,
or bound to a missing, invalid, unsafe, ambiguous, or undeclared source.

## Read-only handoff

Before producing any complete, incomplete, or stopped handoff, read
`reference/semantic-dossier.md` and construct its version 2 semantic dossier.
Keep the five ledger categories inside that dossier, add the `interfaces`
topic, and record each deferral with its resolution. Every semantic topic and
Node responsibility must cite ledger fact IDs; record contradictions as
unresolved assumptions and attach remaining questions to the fields they repair.
Ask only about unresolved or contradictory fields on subsequent exchanges.
The dossier describes workflow meaning; WorkflowProtocol and WorkflowRuntime
remain the authorities for execution encoding and transitions.

Return a compact handoff and clearly label every fact category. A complete
handoff has this shape:

```json
{
  "schemaVersion": 1,
  "kind": "badger-questionnaire-handoff",
  "status": "complete",
  "projectRoot": "<dir>",
  "existingContext": null,
  "dossier": "<version 2 semantic dossier with the five-part ledger>",
  "dossierHash": "<deterministic SHA-256 identity>",
  "factoryPlan": {},
  "diagnostics": [],
  "nextAction": "factory-plan-confirmation",
  "nextReadOnlyCommand": null
}
```

For a user-requested stop, use `"status": "stopped"`, keep the incomplete
plan or existing-context reference visible, and set the next action to
questionnaire refinement. This Skill does not write that handoff, the
FactoryPlan, Creator state, generated package, publication record, or
distribution output. `/badger-create` may write and show the complete plan
after this handoff; plan confirmation, read-only proposal review, and Creator
initialization confirmation remain separate gates.

Use the exported read-only `createQuestionnaireHandoff` helper to validate the
envelope and compute its identity. For already supplied files, the equivalent
command is `badger questionnaire-handoff <dossier.json> --plan <plan.json>
--project <dir> --json`; add `--stopped` only when the user requested a stop,
and `--existing-context <path>` when refining an existing plan or state.
This command prints the result without writing files or inspecting ambient
Skills. Incomplete handoffs return diagnostics and exit code 1. A stopped
handoff retains its dossier, candidate plan, context, questions, and hash.
Resume from that envelope, repair the identified fields, and reconfirm changed
meaning. Completion embeds the dossier as `factoryPlan.semanticDossier` and
returns the next action `factory-plan-confirmation`, without invoking propose.
