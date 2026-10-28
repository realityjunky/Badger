# Badger Authoring Reference

## Agent and backend boundary

The Agent owns the multi-exchange conversation with the workflow owner. It reads the explicitly
supplied Skill evidence, distinguishes user facts from source facts and Agent design choices, and
authors a complete `FactoryPlan` with `skillSources`. The CLI/backend owns JSON parsing, source-path
resolution, frontmatter and package validation, canonical metadata, content hashing, workflow
normalization, blocker reporting, and hash-bound proposal output. The Agent must show the complete
plan and obtain confirmation before invoking a state-writing Creator command.

Candidate inspection is closed-world and read-only: no project or home Skill root is scanned, no
source script is executed, and no Creator state or package is written.

## FactoryPlan shape

The initial plan includes `schemaVersion`, `goal`, `skillCreatorIntent`, `defaultLocale`,
`skillSources`, and `workflow`. Each `skillSources` entry is `{ "name": "...", "location": "..." }`.
`upgrade-existing` additionally includes `sourceRoot`, and that source must also be explicitly
declared. Legacy source-selection fields such as `preferredSkills` and `skillRoots` are rejected and are not part of
the contract.

## Relationship semantics

- An implementation binding identifies the Skill that owns a Node.
- A Required Skill Call requires another supplied Skill inside a Node without replacing the Node.
- An augmentation assists a Node without replacing its implementation.
- An Output Schema declares artifacts and evidence produced by a Node.
- A guardrail controls advancement using declared validation or evidence.
- A decision Node exposes stable user choices and transition targets.
- A handoff returns bounded evidence to another Node, reviewer, or user.
- Routing transitions connect success, failure, pause, and conditional outcomes.
- A cycle declares bounded repeat behavior and continuation semantics.

This reference describes the package-construction plane inside standalone
Badger. It turns a confirmed workflow goal and real source Skill evidence into
an authored, reviewed, deterministic `workflow-kernel` package. It does not
execute the generated workflow.

## Two protocols, two authorities

`AuthoringProtocol` describes how package content is produced: lane identities,
dependency waves, claims, review depth, deterministic artifacts, and authored
content leaves. `WorkflowProtocol` describes what the generated package does:
Nodes, bindings, transitions, decisions, Output Schemas, guardrails, and
runtime recovery.

Authoring records may change package-construction evidence. Only the bundled
WorkflowRuntime may select executable routes, validate Run submissions, write
Run state, create Decision Receipts, allocate Cycle or Attempt identities, and
reconcile runtime recovery. Generated scripts are thin projections over that
authority.

## Six-lane plan

The canonical contract is in
`reference/authoring-protocol.json`. Its lanes are:

| Lane             | Required claims                                                                                                                                      | Content produced                                                                      |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `script`         | `script:workflow-state`, `script:workflow-guard`, `script:workflow-handoff`, `script:badger-plan`, `script:badger-check`, `script:badger-hook-guard` | No worker-owned content; the assembler produces the Badger-named control-plane files. |
| `reference`      | `reference:workflow-protocol`, `reference:resolved-skills`, `reference:composition-report`, `reference:authoring-lanes`                              | No worker-owned content.                                                              |
| `pause-points`   | `pause:decision-points`, `pause:recovery`                                                                                                            | `reference/decision-points.md`, `reference/recovery.md`.                              |
| `workflow-entry` | `workflow-entry`                                                                                                                                     | The entry `SKILL.md` Decision Core.                                                   |
| `skill-core`     | One derived `skill-core:node-skill:<id>` claim per active internal Node.                                                                             | One Guidance section in each active Node Skill.                                       |
| `skill-review`   | `review:skill-review`                                                                                                                                | `reference/skill-review.md`.                                                          |

The first three lanes form wave one. `workflow-entry` and `skill-core` form wave
two after the script contract. `skill-review` is a barrier after all preceding
lanes.

## File handoff

`authoring-dispatch` creates a bounded handoff containing the role brief,
common input, dependency records, output path, and input identities. The
provider returns the handoff envelope to `authoring-record`. The main process
validates status, claims, artifact paths, content bounds, dependencies, and
hashes before persisting the record with an expected revision.

Workers cannot write `.badger` state, execute source Skills, publish or
distribute a package, or access credentials. The manual file-provider fixture
uses the same handoff and record path without requiring a model or external
service.

## Assembly boundary

Assembly starts from a fresh deterministic scaffold and performs one protected
swap after all current lane records are valid. The Auto zone is generator-owned
and includes:

- `reference/workflow-protocol.json`, `reference/resolved-skills.json`,
  `reference/authoring-plan.json`, `reference/authoring-lanes.json`,
  `reference/composition-report.md`, `reference/eval-manifest.json`, and
  `reference/package-inventory.json`;
- `scripts/workflow-runtime.mjs`, `scripts/workflow-state.mjs`,
  `scripts/workflow-guard.mjs`, `scripts/workflow-handoff.mjs`,
  `scripts/badger-plan.mjs`, `scripts/badger-check.mjs`, and
  `scripts/badger-hook-guard.mjs`;
- `badger/skill.yaml`, `badger/guardrails.yaml`, `badger/checks.yaml`, and
  `badger/eval.yaml`.

The Authored zone is limited to the declared content leaves:

- the entry `SKILL.md` Decision Core;
- one internal Node Skill Guidance section per active Node;
- `reference/decision-points.md`;
- `reference/recovery.md`;
- `reference/skill-review.md`.

The `reference/package-inventory.example.json` file in this Skill is an
illustrative assembled inventory. It contains safe relative paths and ownership
only; it is not a copy of a session record or an audit report. A generated
upgrade package may also contain `source/` and
`reference/source-evidence.json`, which preserve the selected source package
and its explicit retained/replaced/wrapped decisions.

## Lifecycle

Use the following boundary sequence:

1. Run the Badger Skill in an Agent; confirm the workflow goal and explicit `skillSources` with the
   bundled `badger-workflow-questionnaire`, then inspect those sources with `guide` and the source
   check (`source-check`, with `candidates` kept as an alias).
2. Preview and validate a normalized proposal with `propose`.
3. Require explicit confirmation before `init` writes Creator state.
4. Generate a visibly pending scaffold and its `.badger/authoring/<name>`
   session.
5. Read the plan, dispatch lanes, and persist each validated record.
6. Assemble only when all six current lanes and all authored leaves are ready.
7. Run `eval` and `review`; these produce separate evidence classes.
8. Record human approval with `approve --confirm`, then publish with
   `publish --confirm`.
9. Use `distribute` only as a local file-list preview.

Changing source, protocol, authored material, or the assembled tree invalidates
the dependent evidence. A package that still contains `AUTHORING PENDING`, a
stale record, an unresolved concern, or a missing claim remains blocked.

## Boundary of this package

Badger includes local filesystem authoring, deterministic package assembly,
WorkflowRuntime execution, and publication preview. Host platform installers,
platform or dashboard interfaces, provider authentication, domain execution,
and fixtures derived from protected raw data remain outside this package. Future
platform adapters may consume the stable local readiness and publication
contracts, but they must not add a competing authoring or runtime authority.
