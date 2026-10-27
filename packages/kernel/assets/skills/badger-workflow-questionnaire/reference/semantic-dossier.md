# Semantic Dossier Version 1

Use this contract for every questionnaire exchange and handoff. It records
semantic meaning and evidence, not generated scripts or a duplicate runtime
protocol. The exported `SemanticDossier` type and `validateSemanticDossier`
validator define the machine-readable shape.

## Envelope

- `schemaVersion: 1`, `kind: "semantic-dossier"`, and `confirmed: true` only
  after the workflow owner confirms the current meaning.
- `workflow`: `name`, `goal` (the FactoryPlan goal), `intent` (`new-skill` or
  `upgrade-existing`), and `defaultLocale: "en"`.
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

Keep these five arrays distinguishable. IDs are unique across categories.

1. `confirmedUserFacts`: `{ id, statement }` explicitly confirmed by the owner.
2. `sourceDerivedFacts`: `{ id, statement, sourceId, evidencePath }` traced to
   an inspected declared source file. Record manual-derived reasoning as an
   agent inference until the owner confirms its workflow application.
3. `agentInferences`: `{ id, statement, confirmed }`. Keep their origin visible
   after confirmation. An unconfirmed inference prevents completion.
4. `unresolvedAssumptions`: `{ id, statement, field }`. Include contradictions
   here, identifying the affected field. Every entry prevents completion.
5. `remainingQuestions`: `{ id, field, question }`. Every entry prevents
   completion; ask only these targeted questions in the next exchange.

## Required semantic topics

Every topic needs a nonempty summary and ledger references. If inapplicable,
explain why explicitly and obtain confirmation; an omitted or empty topic is
an unresolved field. For Node-specific behavior, name the Node IDs.

| Topic | Required meaning |
| --- | --- |
| `inputs` | Workflow and per-Node inputs and their origin |
| `prerequisites` | Conditions that must hold before each Node |
| `bindings` | Supplied implementation owner for each Node |
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
coverage, and FactoryPlan/source consistency; it cannot adjudicate arbitrary
prose contradictions that the Agent has not recorded.

`createQuestionnaireHandoff({ projectRoot, dossier, factoryPlan,
existingContext?, stopped? })` returns `incomplete`, `complete`, or `stopped`.
Only explicit `stopped: true` produces a stopped handoff, even with gaps.
Partial dossier content is retained verbatim for resumption. The API writes
nothing. Completion attaches the validated dossier to the candidate FactoryPlan
and requires separate FactoryPlan confirmation before proposal construction.

`dossierHash` is SHA-256 of the dossier JSON after recursively sorting object
keys; arrays retain order. Project location, handoff status, and resume context
are outside this identity. Confirmed FactoryPlans canonicalize their embedded
dossier before hashing. Authoring retains both dossier content and
`semanticDossierHash`; changed meaning makes existing authoring evidence stale.
Existing plans without a dossier remain supported. Newly completed
questionnaires always produce one.
