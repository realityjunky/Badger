# Semantic Dossier Version 2

Use this contract for every questionnaire exchange and handoff. It records
semantic meaning and evidence, not generated scripts or a duplicate runtime
protocol. The exported `SemanticDossier` type and `validateSemanticDossier`
validator define the machine-readable shape.

Version 1 is retired. The validator refuses it with a migration finding, and
no new handoff may carry it.

## Envelope

- `schemaVersion: 2`, `kind: "semantic-dossier"`, and `confirmed: true` only
  after the workflow owner confirms the current meaning.
- `workflow`: `name`, `goal`, `intent` (`new-skill` or `upgrade-existing`),
  and `defaultLocale: "en"`. The goal is the one goal shared with the
  FactoryPlan: `workflow.goal` must equal both the plan's `goal` and its
  `workflow.goal`, and the validator refuses a mismatch.
- `sources`: every explicit Skill declaration, with unique `id`, `name`,
  `location` as declared, inspected `canonicalPath`, `contentHash`, and
  nonempty `roles`. Use concise role descriptions, never copied Skill bodies.
- `nodes`: every active Node in normalized order, with unique `id`, unique
  nonnegative `order`, and a `responsibility` topic.
- `topics`: every topic listed below. A topic is
  `{ "summary": "<meaning>", "factIds": ["<ledger-id>"] }`.
- For upgrades, `upgradeSource` identifies a declared `sourceId` and describes
  `recovery`. The FactoryPlan still requires its separate `sourceRoot`.

## Fact ledger

Keep these five arrays distinguishable. IDs are unique across categories,
including deferred questions.

1. `confirmedUserFacts`: `{ id, statement, provenance }` explicitly confirmed
   by the owner. Provenance records the confirming person (`confirmedBy`), the
   answer revisions the fact restates (`answerRevisions`, each
   `{ "answerId": "<id>", "revision": <positive integer> }`), and the
   answering Field expert's acknowledgement (`acknowledgedBy`).
2. `sourceDerivedFacts`: `{ id, statement, sourceId, evidencePath }` traced to
   an inspected declared source file. Record manual-derived reasoning as an
   agent inference until the owner confirms its workflow application. Its
   provenance is the declared source and evidence path; answer provenance
   belongs to facts restated from an answer.
3. `agentInferences`: `{ id, statement, confirmed, provenance? }`. Keep their
   origin visible after confirmation. A confirmed inference carries the same
   provenance as a confirmed user fact; an unconfirmed inference prevents
   completion.
4. `unresolvedAssumptions`: `{ id, statement, field }`. Include contradictions
   here, identifying the affected field. Every entry prevents completion.
5. `remainingQuestions`: `{ id, field, question }`. Every entry prevents
   completion; ask only these targeted questions in the next exchange.

## Deferred questions

`deferredQuestions` records each question the Engineer deferred as internal to
one Skill or out of scope: `{ id, field, question, resolution }`. The
resolution is `{ "outcome": "deferred", "scope": "skill" | "out-of-scope",
"skill": "<declared Skill name>", "reason": "<why>" }`, and it is required.
A skill-scoped deferral names the declared Skill whose backlog holds it; an
out-of-scope deferral omits `skill`.

A deferred question never blocks readiness; it appears with its resolution. A
question still in `remainingQuestions` still blocks. Call this recorded outcome
its resolution, as `GLOSSARY.md` and ADR 0006 do; `disposition` names a field of
the WorkflowRuntime continuation. A topic cites the five ledger categories, not
a deferred question: its resolution is evidence of why the topic is settled,
not a fact about the workflow.

## Migration from version 1

A persisted plan that embeds a version 1 dossier is refused. `readPlan` and
`buildProposal` run the same validator, so a caller migrates by rebuilding the
dossier as version 2 — adding `interfaces`, `deferredQuestions`, and fact
provenance — and reconfirming it with the workflow owner. Plans without a
dossier remain supported. A plan that carries a dossier must also give its
`goal` and `workflow.goal` the dossier's one goal.

## Required semantic topics

Every topic needs a nonempty summary and ledger references. If inapplicable,
explain why explicitly and obtain confirmation; an omitted or empty topic is
an unresolved field. For Node-specific behavior, name the Node IDs.

| Topic | Required meaning |
| --- | --- |
| `inputs` | Workflow and per-Node inputs and their origin |
| `prerequisites` | Conditions that must hold before each Node |
| `bindings` | Supplied implementation owner for each Node |
| `interfaces` | Data contracts between Nodes: the shape, columns, file naming, and evidence one Node's output must provide for the next Node's input |
| `requiredSkillCalls` | Required supplied Skill calls and completion evidence |
| `augmentations` | Supporting Skills and how they assist the owner |
| `outputSchemas` | Per-Node artifacts, evidence, schema identities, validation |
| `completionEvidence` | Observable completion criteria for every Node |
| `decisions` | Genuine decisions, stable choice IDs, inputs and reviewers |
| `guardrails` | Advancement constraints, validation and repair requirements |
| `routes` | Success, failure, pause, conditional, handoff and completion routes |
| `boundedCycles` | Entries, repeat transitions, bounds and exits |
| `capabilities` | Required capabilities and their constraints |
| `finalization` | Final outputs and completion responsibilities |
| `executableDisclosures` | Inspected scripts, hooks and requested execution capabilities |
| `recoveryPolicy` | Stops, repair ownership, retries and resume entry |

## Completion and identity

The main session resolves semantic contradictions before setting `confirmed`.
The validator checks explicit gaps, ledger references, identities, topic
coverage, deferral resolutions, fact provenance, and FactoryPlan/source
consistency; it cannot adjudicate arbitrary prose contradictions that the
Agent has not recorded.

The questionnaire handoff is a pure read model. `createQuestionnaireHandoff({
projectRoot, dossier, factoryPlan, existingContext?, stopped? })` returns
`incomplete`, `complete`, or `stopped` and writes nothing; the CLI
(`badger questionnaire-handoff`) and library callers use the same function.
Only explicit `stopped: true` produces a stopped handoff, even with gaps.
Partial dossier content is retained verbatim for resumption. Completion
attaches the validated dossier to the candidate FactoryPlan and requires
separate FactoryPlan confirmation before proposal construction.

`dossierHash` is SHA-256 of the dossier JSON after recursively sorting object
keys; arrays retain order. Project location, handoff status, and resume context
are outside this identity. Confirmed FactoryPlans canonicalize their embedded
dossier before hashing. Authoring retains both dossier content and
`semanticDossierHash`; changed meaning makes existing authoring evidence stale.
Existing plans without a dossier remain supported. Newly completed
questionnaires always produce a version 2 dossier.
