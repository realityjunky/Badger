# Badger Release Artifact Ledger

This is the current documentation index for standalone Badger. It records the
package boundary, release-facing artifacts, and checks that must stay aligned
with the implementation. The kernel package is the delivered workflow-kernel
core. The repository's scope also includes the collaborative service around
it, as [ADR 0002](adr/0002-collaborative-service-in-scope.md) records. Domain
workflows live in separate repositories.

The repository is an npm workspace. The kernel package, `@realityjunky/badger`,
is in `packages/kernel/`, and the kernel paths below (`src/`, `assets/`) are
relative to it. New workspace packages go in `packages/<name>/`.

## Current boundary

| Surface                                                                     | Status                                                                                                                                                                                                                                         | Authority                                                                                                                                                                                                                                                                                                                               |
| --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Creator and WorkflowRuntime                                                 | Delivered                                                                                                                                                                                                                                      | `src/authoring/`, `src/factory/`, `src/eval/`, `src/publish/`, `src/workflow-runtime/`                                                                                                                                                                                                                                                  |
| Six-lane authoring                                                          | Delivered                                                                                                                                                                                                                                      | `assets/skills/badger-create/reference/authoring-protocol.json`, role briefs, `src/authoring/`                                                                                                                                                                                                                                          |
| Hash-bound durability and readiness                                         | Delivered                                                                                                                                                                                                                                      | `src/workflow-runtime/`, `src/eval/`, `src/publish/`                                                                                                                                                                                                                                                                                    |
| Collaborative service: server walking skeleton                              | Walking skeleton (#36), platform sign-in (#38), groups and roles (#40), workflows and versions (#41), Skill versions (#42), personal access tokens (#53), Skill pins and source checks (#43), Sources gate and inbox (#44), source study (#45) | `packages/server/src/`, reviewed SQL in `packages/server/migrations/`, and the worker role in `packages/server/src/worker.ts`; the Badger MCP and host installer are still planned (#24)                                                                                                                                                |
| Collaborative service: web dashboard                                        | Shell (#37), admin and activity (#40), workflows (#41), Skills (#42), token settings (#53), Sources stage (#43), Sources gate and inbox (#44), Source study (#45)                                                                              | `packages/web/src/`: the rail, top bar, three-pane registry layout, the token source, URL routes, zh/en catalogs, the Admin pages, the Activity page, the Workflows page with its Sources stage and gate and its Source study panel, the inbox on My work and the top bar, the Skills page, token settings, and the Playwright journeys |
| Domain workflow definitions and source Skills                               | External                                                                                                                                                                                                                                       | Domain workflow repositories, supplied to Badger through explicit `skillSources`                                                                                                                                                                                                                                                        |
| Backup and restore procedure                                                | Documented (#72)                                                                                                                                                                                                                               | `docs/backup-and-restore.md` and `docs/examples/restore-smoke.mjs`; each deployment owns its schedule, scripts, and retention                                                                                                                                                                                                           |
| Deployment glue: launcher entries, reverse-proxy routes, and deploy scripts | External                                                                                                                                                                                                                                       | Each deployment's own repository                                                                                                                                                                                                                                                                                                        |
| Automatic distribution, domain execution                                    | Out of scope                                                                                                                                                                                                                                   | Not shipped in this repository                                                                                                                                                                                                                                                                                                          |

Personal access tokens (#53) are delivered in the server and personal settings:
scoped bearer authentication, hashed storage, one-time secret display,
expiration, revocation, recorded uses, and per-token rate limits. The server
refuses every action reserved for people. The API and current profile
operations are documented in `packages/server/README.md`.

Skill pins and source checks (#43) are delivered in the server, its worker
role, and the Workflows page: revisioned pins of immutable Skill versions,
durable source-check jobs leased from Postgres, kernel source checks on the
pinned content, and the Sources inventory with script effects and blockers.
[ADR 0015](adr/0015-pinned-skill-versions-and-source-check-jobs.md) records
the queue and workspace contract; a deployment runs the worker role beside
the server.

The Sources gate and inbox (#44) are delivered in the server and the
dashboard: a preview that binds the version frame, the pins, and the source
check under one confirmation hash; commits by signed-in people that replay
per client request ID; invalidation in the same transaction as a pin change;
and inbox items with unread, read, and done states and deep links, shown on My
work and the top-bar badge. [ADR 0016](adr/0016-gate-confirmations-and-inbox.md)
records the replay and invalidation contract, and migration `0009` adds the
tables.

Artifacts by receipt (#31) are delivered in WorkflowRuntime: Output Schema
artifacts under declared external roots, or above the 2 MiB read cap, are
verified in place and recorded in Completion evidence with their path, size,
SHA-256, modification time, and producing Attempt. A workflow declares each
external root by name only, and the host binds it to a directory when a Run
starts. With
`requireCurrentAttempt`, an output older than the Attempt is refused as
`artifact-stale-attempt`. Runtime certification covers receipts
(`docs/workflow-runtime-certification.md`), and
[ADR 0017](adr/0017-artifact-receipts-and-attempt-freshness.md) records the
freshness rule.

The Run registry and exported read models (#32) are delivered in the kernel's
public WorkflowRuntime seam: `listRuns` discovers standalone Runs from their
authoritative records, and `inspect` and `projectState` read continuations,
status, current Node, pending action, and history for either Run location.
Rebuildable projections and stray directories never establish a Run, and a
Run awaiting recovery is listed and projected as blocked, with the
`recovery-required` finding that `inspect` returns. Locks
remain attributable after hostname changes using a host identity scoped to
the boot and process namespace; unknown owners still block recovery.
[ADR 0018](adr/0018-run-lock-host-identity.md) records the identity sources
and legacy-record compatibility.

Source study records (#45) are delivered in the server and the dashboard:
revisioned facts and interfaces whose evidence the server checks against the
pinned Skill version's inventory and stored file, cited lines readable at every
revision, audited writes, and a study completion for each pinned version that
a signed-in person confirms. The last completion opens Questionnaire while no
active record cites a version that is no longer pinned; a record change reopens
Source study, and a pin change invalidates every completion.
[ADR 0019](adr/0019-source-study-records-and-completion.md) records the
evidence and invalidation contract, and migration `0010` adds the tables.

## Package-facing artifacts

The installed Agent entrypoints are `assets/skills/badger-create/SKILL.md` and
`assets/skills/badger-workflow-questionnaire/SKILL.md`. The latter's source
study is beside it. `badger guide` is read-only and reports first-use,
`FactoryPlan`, and resumable Creator state; explicit confirmation remains
required before proposal, initialization, generation, publication, or
distribution.

The `badger-create` reference set is:

- `reference/authoring-protocol.json` — lane DAG, claims, review settings, deterministic backbone, and authored leaves;
- `reference/authoring-subagents.md` — bounded role handoffs and dependency waves;
- `reference/bundle-authoring.md` — scaffold, assembly, content leaves, and upgrades;
- `reference/authored-zone-example.md` — substantive Decision Core and Node Guidance;
- `reference/eval-provider.md` — authoring review, runtime evaluation, certification, and publication approval;
- `reference/package-inventory.example.json` — safe relative-path ownership example.

The `badger-workflow-questionnaire` reference set is:

- `reference/semantic-dossier.md` — the version 2 dossier envelope, five-part
  fact ledger, `interfaces` topic, deferred-question resolutions, fact
  provenance, and the one goal shared with the plan;
- `reference/source-study.md` — the questionnaire's elicitation pattern and
  Badger's explicit-source adaptation.

## Generated package

The checked-in inventory example omits session state, provider metadata,
internal reports, and byte hashes. Generated
`reference/package-inventory.json` files contain the complete hash-bound
inventory and readiness evidence.

| Owner      | Meaning                                       | Examples                                                         |
| ---------- | --------------------------------------------- | ---------------------------------------------------------------- |
| `auto`     | Deterministic assembler output                | Protocol, manifests, scripts, guardrails, checks, evaluation     |
| `authored` | Validated lane content at a declared leaf     | Entry and Node guidance, decision points, recovery, skill review |
| `source`   | Bundled Skills and preserved upgrade material | `sources/<hash>/` Skills and `source/` upgrade files             |

Assembly requires the authored `SKILL.md`, active Node guidance,
`reference/decision-points.md`, `reference/recovery.md`, and
`reference/skill-review.md`. Missing, duplicated, placeholder, stale, or
unexpected executable content blocks readiness.

Entry and Node Skills carry deterministic Runtime Access guidance (#34):
prefer the Badger MCP Run tools (`start`, `next`, `submit`, `status`, and
`recover`) when available and use the script adapter on hosts without MCP.
MCP gate answers stay with signed-in people in the dashboard. The workflow-entry
and skill-core lanes preserve this section while authoring their content leaves.
Generation tests cover both modes, and evaluation verifies that assembly
preserves the guidance and that edits invalidate the assembled package hash.
Runtime certification covers the shared WorkflowRuntime and generated scripts;
live MCP transport and service behavior are checked with the MCP implementation.

## Ownership

| Responsibility                                              | Current authority                                           |
| ----------------------------------------------------------- | ----------------------------------------------------------- |
| Explicit Skill source inspection, identity, and inventory   | `src/skill/identity.ts`, `src/workflow-kernel/discovery.ts` |
| Workflow contract normalization and validation              | `src/workflow/contract.ts`                                  |
| Plan, proposal, confirmation, and `.badger` state           | `src/workflow-kernel/foundation.ts`, `src/factory/`         |
| Six-lane authoring and deterministic assembly               | `src/authoring/`, `src/factory/generate.ts`                 |
| Evaluation, publication readiness, and distribution preview | `src/eval/`, `src/publish/`                                 |
| Skill loading, snapshots, Engine, and durable Run storage   | `src/skill-runtime/`, `src/engine/`                         |
| Public WorkflowRuntime seam                                 | `src/workflow-runtime/public.ts`                            |

Deployment glue and domain execution remain outside this repository. Domain
workflow repositories own workflow definitions, source Skills, and domain
fixtures; Badger consumes only the explicit sources supplied by a caller.

## Documentation

[`badger-workflow-manual.html`](badger-workflow-manual.html) is explanatory
material, not runtime policy. Generated package checks and current TypeScript
are authoritative when prose conflicts with code. The detailed
WorkflowRuntime contract and certification evidence are in
[`workflow-runtime-certification.md`](workflow-runtime-certification.md).
[`GLOSSARY.md`](../GLOSSARY.md) defines the domain language, and
[`adr/`](adr/) records the architecture decisions behind the kernel and the
collaborative service.

## Release gate

Run at the root of a clean disposable checkout or worktree:

```bash
npm ci
npm run build
npm test
npm run format:check
npm pack --dry-run -w packages/kernel
# The dashboard's browser journeys and visual checks. Build first.
npm run test:e2e -w packages/web
```

Focused authoring and artifact checks:

```bash
npm test -w packages/kernel -- test/authoring-plan.test.ts test/authoring-lifecycle.test.ts test/release-artifacts.test.ts test/workspace-layout.test.ts
npm test -w packages/kernel -- test/package-runtime-modes.test.ts
npm test -w packages/kernel -- test/workflow-runtime-artifact-receipt.test.ts
```

If a release changes the protocol, generator, generated control-plane names,
authored leaves, source boundary, or documentation references, update the
packaged authoring protocol, the inventory example, this ledger, the manual,
and the focused artifact tests in the same change.
