# Badger Authoring Reference

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

| Lane             | Required claims                                                                                                                                   | Content produced                                                                      |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `script`         | `script:workflow-state`, `script:workflow-guard`, `script:workflow-handoff`, `script:comet-plan`, `script:comet-check`, `script:comet-hook-guard` | No worker-owned content; the assembler produces the Badger-named control-plane files. |
| `reference`      | `reference:workflow-protocol`, `reference:resolved-skills`, `reference:composition-report`, `reference:authoring-lanes`                           | No worker-owned content.                                                              |
| `pause-points`   | `pause:decision-points`, `pause:recovery`                                                                                                         | `reference/decision-points.md`, `reference/recovery.md`.                              |
| `workflow-entry` | `workflow-entry`                                                                                                                                  | The entry `SKILL.md` Decision Core.                                                   |
| `skill-core`     | One derived `skill-core:node-skill:<id>` claim per active internal Node.                                                                          | One Guidance section in each active Node Skill.                                       |
| `skill-review`   | `review:skill-review`                                                                                                                             | `reference/skill-review.md`.                                                          |

The first three lanes form wave one. `workflow-entry` and `skill-core` form wave
two after the script contract. `skill-review` is a barrier after all preceding
lanes. The Badger-derived `skill-core` claims and the Badger names for the
three plan/check/hook files are deliberate compatibility extensions; they do
not change the shared six-lane contract.

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

1. Inspect preferences and source Skills with `guide` and `candidates`.
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
WorkflowRuntime execution, and publication preview. Classic and Native policy,
Entry routing, host platform installers, platform or dashboard interfaces,
provider authentication, biological execution, scheduler submission, and
protected raw-data-derived fixtures remain outside this package. Future
platform adapters may consume the stable local readiness and publication
contracts, but they must not add a competing authoring or runtime authority.
