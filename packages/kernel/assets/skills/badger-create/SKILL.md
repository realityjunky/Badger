---
name: badger-create
description: Create or upgrade a workflow Skill through standalone Badger using explicitly supplied Skill sources and a confirmed multi-exchange FactoryPlan.
disable-model-invocation: true
---

# Badger Creator

This is the package-facing `/badger-create` Skill. It is an Agent-first
authoring coordinator for the standalone Badger factory. The Agent turns a
user's goal, explicitly supplied Skill evidence, and a confirmed FactoryPlan
into a deterministic `workflow-kernel` package. The executable remains the
`badger` CLI.

Badger-create owns semantic discovery, source interpretation, question
selection, plan presentation, and the handoff to read-only or write-gated
CLI commands. It does not execute source Skills, their scripts, biological
tools, external providers, or generated workflow actions.

## First-use and resume

Always begin with the read-only context command:

```bash
badger guide --project <dir> --json
```

Use `--plan <file>` when a FactoryPlan already exists as a file but has not
yet initialized Creator state. The guide reports `firstUse`, `factoryPlans`,
and `resumable` Creator state without mutating the project.

- When `firstUse` is `true` and `questionnaire.mode` is
  `automatic-first-use`, immediately start
  `/badger-workflow-questionnaire`. This is the automatic first-use path for
  a project with no existing FactoryPlan or resumable Creator flow.
- When `factoryPlans` or `resumable` contains an existing context,
  `questionnaire.mode` is `manual-refinement`; preserve it.
  Do not silently start over, replace a plan, or discard an authoring session.
  The user may explicitly invoke `/badger-workflow-questionnaire` to refine or
  repair that context; identify the existing plan and state in the handoff.
- A questionnaire refinement is discovery, not Creator initialization. Keep
  FactoryPlan confirmation, proposal review, and `badger init --confirm` as
  separate gates.

## Closed-world source workflow

Every Skill used by the workflow must be supplied as exactly one declaration in
the FactoryPlan `skillSources` array. A declaration is a Skill name and a
project-relative location, or an absolute location inside the project or a
registered source root. Never infer a Skill from a default, ambient,
home-directory, or platform directory.

1. Establish the project root and the `new-skill` or `upgrade-existing` intent.
2. Ask for each source Skill's name and location. Run the source check with
   `badger source-check --skill <name=location> --json` (`candidates` is kept
   as an alias), repeating `--skill` for every source or using an explicit
   source manifest. An absolute location outside the project needs a root
   the host registers with `--source-root` or `BADGER_SOURCE_ROOTS`. A plan or
   manifest cannot register roots, so use only the roots the user names, and
   pass the same roots to every later command.
3. Review each source's canonical path, frontmatter description, full file
   inventory with hashes, ignored files, script side effects, and identity
   hash. Read the workflow manual and every explicitly supplied Skill file
   before asking semantic questions.
4. Start or continue `/badger-workflow-questionnaire` according to the
   first-use and resume result. Let it conduct as many exchanges as needed.
5. Author a complete FactoryPlan with explicit sources, workflow semantics,
   and upgrade-source identity where applicable.

The source check is read-only. Its identity hash and inventory cover every
file, configuration included, except a fixed list of operating-system
metadata, editor state, and interpreter cache files, which it lists by path
under `ignored`. A script's side effects come from the source manifest or the
plan's `skillSources` (`none`, `local-writes`, `network`,
`scheduler-submission`, `installs`, or a list of them); an undeclared script
is reported as undeclared. It never executes scripts, writes Creator
state, writes the questionnaire handoff, copies a source package, publishes,
distributes, or accesses credentials.

## Multi-exchange authoring

The questionnaire is progressive. It asks only after the workflow manual and
all supplied Skill evidence have been read, then prioritizes unresolved or
contradictory fields. After every exchange, show a concise ledger with these
separate categories:

- **Confirmed user facts** — facts and decisions stated or confirmed by the
  workflow owner.
- **Source-derived facts** — facts read from the workflow manual or supplied
  Skill files, references, scripts, and hashes.
- **Agent inferences** — proposed design choices made to connect the facts;
  label each one and ask the user to confirm it.
- **Unresolved assumptions** — unknowns that must not be presented as facts.
- **Remaining questions** — the next questions needed for a valid plan.

Continue exchanges until the completeness checklist passes or the user
explicitly stops with unresolved gaps. Do not call `badger propose` while a
required field is unresolved, contradictory, or bound to an unavailable
source. A user-requested stop produces a stopped handoff and keeps the
remaining questions visible; it does not authorize proposal construction.

## FactoryPlan handoff

After the checklist passes, show the complete plan before proposal
construction. The plan must contain `schemaVersion`, `goal`,
`skillCreatorIntent`, `defaultLocale`, `skillSources`, and `workflow`. The
workflow must make its name, goal, Nodes, bindings, Output Schemas, routes,
cycles, capabilities, finalization, and recovery behavior explicit. An
`upgrade-existing` plan also contains `sourceRoot`, which is itself one of the
explicit source declarations.

The questionnaire returns a read-only handoff in this shape:

```json
{
  "kind": "badger-questionnaire-handoff",
  "status": "complete",
  "schemaVersion": 1,
  "dossier": "<semantic dossier containing the five-part fact ledger>",
  "dossierHash": "<deterministic SHA-256 identity>",
  "factoryPlan": {},
  "nextAction": "factory-plan-confirmation",
  "nextReadOnlyCommand": null
}
```

Clearly label the handoff's fact categories and the Agent's inferences. The
Agent may write the complete FactoryPlan after discovery is complete, but must
show it and obtain explicit plan confirmation before invoking `badger propose`.
Proposal confirmation is separate from the later Creator initialization
confirmation.

Preserve the questionnaire's validated `factoryPlan.semanticDossier` when
writing the plan. Incomplete or stopped handoffs require questionnaire
refinement. Proposal construction verifies the dossier's explicit source
identities against the current source check; source drift requires reinspection and
owner confirmation. Authoring plans retain the dossier and its content hash.
Each lane's common input points to `/semanticDossier` in that persisted plan;
semantic repairs invalidate previous authoring evidence through the existing
input hash and revision checks.

## Authoring boundary

The Agent or LLM owns the semantic work: understand the goal, read supplied
evidence, ask and summarize questions, distinguish facts from inferences,
choose Node responsibilities, and author the FactoryPlan. The CLI and backend
own the deterministic work: parse the plan, resolve only explicit source
locations, validate frontmatter and workflow contracts, canonicalize paths,
hash content, normalize the Workflow Protocol, report blockers and warnings,
and generate the read-only proposal. The CLI does not ask questions or invoke
an LLM, and it does not write Creator state until a confirmed command requests
it.

The relationships in the plan are semantic rather than source metadata:

- An implementation binding identifies the supplied Skill that owns a Node.
- A Required Skill Call requires another supplied Skill inside that Node
  without replacing its implementation.
- An augmentation assists a Node without replacing its implementation.
- An Output Schema declares the artifacts and evidence produced by a Node.
- A guardrail controls advancement using declared validation or evidence.
- A decision Node exposes stable user choices and declared transition targets.
- A handoff returns bounded evidence to another Node, reviewer, or user.
- Routing transitions connect success, failure, pause, and conditional outcomes.
- A cycle declares bounded repeat behavior and continuation semantics.

## Confirmation and lifecycle

1. Inspect context with `badger guide`; run the source check with
   `badger source-check`.
2. Complete `/badger-workflow-questionnaire` and show its confirmed handoff.
3. Write and show the complete FactoryPlan. After explicit plan confirmation,
   run `badger propose <plan.json> --project <dir> --json`.
4. Show the proposal's goal, intent, normalized Nodes, implementations,
   Required Skill Calls, augmentations, Output Schemas, candidates, blockers,
   warnings, source identities, and hashes.
5. Wait for separate explicit proposal confirmation before running
   `badger init <plan.json> --confirm --project <dir>`.
6. Run `badger generate <name> --project <dir>` to create the deterministic,
   authoring-pending scaffold. A legacy scaffold without an authoring session
   remains readable but is not authoring-complete or publishable; use
   `badger migrate <name> --confirm` to preserve its source evidence and
   resume the required lanes.
7. Run `badger authoring-status <name> --project <dir> --json`, dispatch each
   executable lane with `badger authoring-dispatch`, and submit its bounded
   provider-neutral result with `badger authoring-record --confirm`. Use expected
   revisions for concurrent submissions. Assemble only after all six lanes
   complete, using `badger assemble <name> --confirm --project <dir>`.
8. For an upgrade, preserve the original source tree and record explicit
   `retained`, `replaced`, or `wrapped` decisions. Generated summaries never
   silently replace source-owned files.
9. Run `badger eval <name> --project <dir>` and inspect
   `badger review <name> --project <dir> --json`. Resolve all authoring,
   runtime, and publication blockers.
10. Obtain a named human reviewer and run
    `badger approve <name> --reviewer <id> --confirm`, then publish with
    `badger publish <name> --confirm`. Use `badger distribute` only for a
    local preview of files.

The standalone package excludes platform installers, host adapters, automatic
distribution, credentials, and domain execution. Generated control-plane adapters remain thin
projections over Badger WorkflowRuntime; they are not a second execution
authority.

## Authoring contract

Badger preserves the six-lane package-construction contract:

| Lane             | Dependency wave       | Output boundary                                                                         |
| ---------------- | --------------------- | --------------------------------------------------------------------------------------- |
| `script`         | Wave 1                | Claims for WorkflowRuntime and Badger-named plan, check, and hook roles.                |
| `reference`      | Wave 1                | Resolved Skills, normalized Workflow Protocol, composition evidence, and lane metadata. |
| `pause-points`   | Wave 1                | `reference/decision-points.md` and `reference/recovery.md`.                             |
| `workflow-entry` | Wave 2 after `script` | Entry `SKILL.md` Decision Core.                                                         |
| `skill-core`     | Wave 2 after `script` | One substantive Guidance section per active internal Node Skill.                        |
| `skill-review`   | Barrier               | `reference/skill-review.md` and the authoring review verdict.                           |

Providers receive only bounded file handoffs and capability metadata. They
cannot write Creator or authoring state, execute candidate Skills, publish,
distribute, access credentials, or invent routes. `BLOCKED` and
`NEEDS_CONTEXT` stop dependent lanes; `DONE_WITH_CONCERNS` remains visible and
blocks final authoring readiness until resolved.

Deterministic assembly keeps the Auto zone separate from authored leaves,
preserves source-owned upgrade files, records package inventory ownership, and
generates the WorkflowRuntime adapters plus the Badger-named
`badger-plan`, `badger-check`, and `badger-hook-guard` roles. Changes to source,
protocol, authored material, or the assembled tree invalidate dependent
hash-bound evidence.
