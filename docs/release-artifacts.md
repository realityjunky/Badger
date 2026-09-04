# Badger Release Artifact Ledger

This document is the release-facing index for the standalone Badger package.
It keeps the formal Skill, generated package, compatibility fixture, workflow
manual, and verification gate aligned with the implementation.

## Status boundary

| Surface                                              | Status                | Evidence                                                                                                                        |
| ---------------------------------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Badger Creator and WorkflowRuntime                   | Delivered             | `src/authoring/`, `src/factory/`, `src/eval/`, `src/publish/`, and `src/workflow-runtime/`.                                     |
| Six-lane authoring contract                          | Restored              | `assets/skills/badger/reference/authoring-protocol.json`, role briefs, and `src/differential/authoring/`.                       |
| Badger hardening                                     | Delivered extension   | Durable lane records, fresh-process recovery, revision fencing, bounded handoffs, cross-validation, and current-hash readiness. |
| Platform, dashboard, and external-provider adapters  | Future / out of scope | No installer, dashboard policy, provider authentication, or competing authoring/runtime state machine is shipped here.          |
| Biological execution and protected raw-data fixtures | Out of scope          | Release checks use disposable synthetic projects only.                                                                          |

The upstream comparison baseline is Comet `0.4.0-beta.19` at revision
`99fd7495f8b9217efbaae3a46d885f6fa7f4102a`. The differential report classifies
Badger naming, namespace, storage, recovery, concurrency, and hash behavior as
expected extensions rather than silently calling those differences upstream
parity.

## Formal Skill package

The installed package-facing Skill is `assets/skills/badger/SKILL.md`. Its
references are intentionally English and form one contract:

- `reference/authoring-protocol.json` — lane DAG, claims, review settings,
  deterministic backbone, and authored leaves;
- `reference/authoring-subagents.md` — role briefs, file handoff, statuses, and
  provider capabilities;
- `reference/bundle-authoring.md` — proposal, authoring, assembly, migration,
  and package boundaries;
- `reference/authored-zone-example.md` — substantive Decision Core and Node
  Guidance quality bar;
- `reference/eval-provider.md` — authoring review, deterministic evaluation,
  WorkflowRuntime certification, and publication approval evidence;
- `reference/package-inventory.example.json` — safe assembled-package example.

The package references do not contain provider credentials, conversation
transcripts, `.badger` session records, source roots, raw source bodies, or
protected raw-data-derived content.

## Generated package inventory

An assembled package has one relative-path inventory at
`reference/package-inventory.json`. Each entry has an ownership class:

| Owner      | Meaning                                                                             | Examples                                                                                       |
| ---------- | ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `auto`     | Deterministic projection controlled by the normalized protocol or Badger assembler. | Protocol, manifests, generated scripts, guardrails, checks, evaluation, and package inventory. |
| `authored` | Content accepted from a validated lane at a declared content leaf.                  | Entry Decision Core, Node Guidance, decision points, recovery, and skill review.               |
| `source`   | Existing material preserved by `upgrade-existing`.                                  | Files under `source/` and the migration source-evidence record.                                |

The checked-in `reference/package-inventory.example.json` shows a one-node
assembled package. It includes every deterministic backbone path and all six
role briefs, while keeping the example free of byte hashes, provider metadata,
session state, and internal review reports. Generated `GeneratedPackage.inventory`
records carry byte counts and hashes for programmatic readiness checks; those
details are not copied into the user-facing example.

The required Authored zone is exactly:

- `SKILL.md`;
- one internal Node `SKILL.md` for every active Node;
- `reference/decision-points.md`;
- `reference/recovery.md`;
- `reference/skill-review.md`.

Assembly blocks when a leaf is missing, duplicated, placeholder content remains,
or an Auto-zone file has drifted. A generated package must contain no
unexpected executable file outside the declared inventory and source-owned
upgrade tree.

## Compatibility fixture

`test/fixtures/authoring/authoring-compatibility.json` records the pinned
upstream revision, known upstream contract inconsistencies, Badger extensions,
the package-facing reference set, and the explicit excluded scopes. The
authoring differential tests use a synthetic six-lane fixture and snapshot all
declared official and Badger authoring sources before and after the run.

The fixture compares these shared dimensions:

- lane DAG and dependency waves;
- lane claims and output envelope;
- quick/full review depth and four review lenses;
- Authored-zone content leaves;
- deterministic backbone and generated artifact inventory;
- authoring, runtime, and publication readiness;
- source integrity and fresh-process lifecycle completion.

The report keeps expected Badger extensions separate from semantic mismatches
and missing functionality. It never certifies Classic, Native, Entry, platform,
dashboard, biological-execution, credential, or protected-raw-data behavior.

## Workflow manual

`docs/badger-workflow-manual.html` is a bilingual educational view of the same
boundary. Its English and Chinese views must both:

- label delivered foundation and integrated authoring as current evidence;
- label platform and dashboard adapters as future or excluded;
- preserve the four-plane authority model and separate AuthoringProtocol from
  WorkflowProtocol;
- render every architecture diagram through the inline Mermaid source;
- resolve every repository-local link from the `docs/` directory; and
- keep the pinned upstream source links and protected raw-data reminder.

The manual is explanatory, not a source of runtime policy. When it conflicts
with the generated package or current TypeScript, the implementation and the
artifact checks are authoritative.

## Release gate

Run the gate from a clean disposable checkout or worktree:

```bash
npm ci
npm run build
npm test
npm run format:check
npm pack --dry-run
```

The authoring-specific checks are:

```bash
npm test -- test/authoring-plan.test.ts test/authoring-lifecycle.test.ts test/authoring-differential.test.ts test/release-artifacts.test.ts
```

The differential commands documented in `docs/differential-harness.md` remain
offline evidence commands. They use a pinned disposable upstream copy and a
synthetic fixture; they do not build in or mutate the protected upstream
checkout.

If a release changes the protocol, generator, generated control-plane names,
authored leaves, or documentation references, update the protocol fixture,
inventory example, release ledger, workflow manual, and focused artifact test
in the same change.
