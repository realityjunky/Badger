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

| Surface                                                                     | Status        | Authority                                                                                      |
| --------------------------------------------------------------------------- | ------------- | ---------------------------------------------------------------------------------------------- |
| Creator and WorkflowRuntime                                                 | Delivered     | `src/authoring/`, `src/factory/`, `src/eval/`, `src/publish/`, `src/workflow-runtime/`         |
| Six-lane authoring                                                          | Delivered     | `assets/skills/badger-create/reference/authoring-protocol.json`, role briefs, `src/authoring/` |
| Hash-bound durability and readiness                                         | Delivered     | `src/workflow-runtime/`, `src/eval/`, `src/publish/`                                           |
| Collaborative service: server, web dashboard, Badger MCP, host installer    | Planned (#24) | ADRs 0002–0006 in `docs/adr/`; not built yet                                                   |
| Domain workflow definitions and source Skills                               | External      | Domain workflow repositories, supplied to Badger through explicit `skillSources`               |
| Deployment glue: launcher entries, reverse-proxy routes, and deploy scripts | External      | Each deployment's own repository                                                               |
| Automatic distribution, domain execution                                    | Out of scope  | Not shipped in this repository                                                                 |

## Package-facing artifacts

The installed Agent entrypoints are `assets/skills/badger-create/SKILL.md` and
`assets/skills/badger-workflow-questionnaire/SKILL.md`. The latter's source
study is beside it. `badger guide` is read-only and reports first-use,
`FactoryPlan`, and resumable Creator state; explicit confirmation remains
required before proposal, initialization, publication, or distribution.

The `badger-create` reference set is:

- `reference/authoring-protocol.json` — lane DAG, claims, review settings, deterministic backbone, and authored leaves;
- `reference/authoring-subagents.md` — bounded role handoffs and dependency waves;
- `reference/bundle-authoring.md` — scaffold, assembly, content leaves, and upgrades;
- `reference/authored-zone-example.md` — substantive Decision Core and Node Guidance;
- `reference/eval-provider.md` — authoring review, runtime evaluation, certification, and publication approval;
- `reference/package-inventory.example.json` — safe relative-path ownership example.

## Generated package

The checked-in inventory example omits session state, provider metadata,
internal reports, and byte hashes. Generated
`reference/package-inventory.json` files contain the complete hash-bound
inventory and readiness evidence.

| Owner      | Meaning                                           | Examples                                                         |
| ---------- | ------------------------------------------------- | ---------------------------------------------------------------- |
| `auto`     | Deterministic assembler output                    | Protocol, manifests, scripts, guardrails, checks, evaluation     |
| `authored` | Validated lane content at a declared leaf         | Entry and Node guidance, decision points, recovery, skill review |
| `source`   | Existing material preserved by `upgrade-existing` | `source/` files and migration evidence                           |

Assembly requires the authored `SKILL.md`, active Node guidance,
`reference/decision-points.md`, `reference/recovery.md`, and
`reference/skill-review.md`. Missing, duplicated, placeholder, stale, or
unexpected executable content blocks readiness.

## Ownership

| Responsibility                                              | Current authority                                                 |
| ----------------------------------------------------------- | ----------------------------------------------------------------- |
| Explicit Skill source inspection and stable hashes          | `src/workflow-kernel/discovery.ts`, `src/workflow-kernel/hash.ts` |
| Workflow contract normalization and validation              | `src/workflow/contract.ts`                                        |
| Plan, proposal, confirmation, and `.badger` state           | `src/workflow-kernel/foundation.ts`, `src/factory/`               |
| Six-lane authoring and deterministic assembly               | `src/authoring/`, `src/factory/generate.ts`                       |
| Evaluation, publication readiness, and distribution preview | `src/eval/`, `src/publish/`                                       |
| Skill loading, snapshots, Engine, and durable Run storage   | `src/skill-runtime/`, `src/engine/`                               |
| Public WorkflowRuntime seam                                 | `src/workflow-runtime/public.ts`                                  |

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
```

Focused authoring and artifact checks:

```bash
npm test -w packages/kernel -- test/authoring-plan.test.ts test/authoring-lifecycle.test.ts test/release-artifacts.test.ts test/workspace-layout.test.ts
```

If a release changes the protocol, generator, generated control-plane names,
authored leaves, source boundary, or documentation references, update the
packaged authoring protocol, the inventory example, this ledger, the manual,
and the focused artifact tests in the same change.
