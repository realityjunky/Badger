# Comet-any Extraction Map

## Upstream provenance

- Upstream checkout: `comet-any-private/comet`
- Upstream remote: `git@github.com:rpamis/comet.git`
- Audited upstream commit: `99fd749` (`0.4.0-beta.19`)
- Source scenario: `assets/skills/comet-any/SKILL.md`, `domains/workflow-contract/`, `domains/bundle/`, `domains/factory/`, and the Creator CLI facade.

## Standalone seam

| Standalone module | Upstream responsibility retained |
| --- | --- |
| `src/skill/find.ts` | Real local Skill roots, frontmatter description, reference/script inventory, content hash, missing/ambiguous status |
| `src/workflow/contract.ts` | Workflow-kernel Node vocabulary, binding enforcement, Output Schema validation, canonical edges, run-state contract, route eval metadata |
| `src/factory/proposal.ts` | Plan loading, intent classification, candidate resolution, blockers, and plan hash |
| `src/factory/generate.ts` | Deterministic entry/Node package generation and protocol/evidence artifacts |
| `src/factory/state.ts` | Confirmed Creator state and atomic state persistence |
| `src/eval/run.ts` | Current-package hash and route-conformance evidence |
| `src/publish/lifecycle.ts` | Readiness, reviewer approval, hash-bound publication, and distribution preview |
| `src/cli.ts` | Thin Creator-facing command interface |

## Deliberate exclusions

The upstream Creator closure also reaches `domains/comet-classic`, `domains/comet-native`, `domains/comet-entry`, `domains/engine`, `domains/skill/platform-install`, and host platform registries through the general Comet Bundle distribution path. Those modules are not copied or imported here. The standalone seam uses local package publication and preview-only distribution instead.

The upstream `comet-five-phase-overlay` and `comet-native` built-in contracts are excluded. Only `workflow-kernel` is accepted by the standalone plan loader. The source checkout remains available for comparison and is protected from edits by the parent repository instructions.

## Differential baseline

`primer_designer_harness/differential/primer-designer-workflow.json` is the pinned three-Skill fixture for comparing candidate resolution, source/reference evidence, source hashes, normalized workflow protocol, generated artifact inventory, and initial readiness. `primer_designer_harness/differential/extraction-manifest.json` records the reusable workflow-kernel closure and the deliberate Classic, Native, installer, Engine, and host-platform exclusions.

The differential runner uses disposable projects and home directories. It never builds or writes the upstream checkout, reads `primer_designer_harness/raw_data/`, executes biological resources, submits schedulers, or installs host-platform files.

## Follow-up candidates

These are intentionally separate future batches:

1. Add a production-quality platform adapter interface with filesystem and in-memory adapters.
2. Add richer authored content lanes and human review artifacts.
3. Add external eval runners behind an injected adapter.
4. Add package signing and publication registry integration.
