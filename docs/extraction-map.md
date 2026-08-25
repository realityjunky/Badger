# Comet-any Extraction Map

## Upstream provenance

- Upstream checkout: `comet-any-private/comet`
- Upstream remote: `git@github.com:rpamis/comet.git`
- Audited upstream commit: `99fd749` (`0.4.0-beta.19`)
- Source scenario: `assets/skills/comet-any/SKILL.md`, `domains/workflow-contract/`, `domains/bundle/`, `domains/factory/`, and the Creator CLI facade.

## Standalone seam

| Standalone module | Upstream responsibility retained |
| --- | --- |
| `src/workflow-kernel/discovery.ts` | Real local Skill roots, frontmatter description, reference/script inventory, content hash, strict preference resolution, and missing/ambiguous status |
| `src/workflow-kernel/hash.ts` | Stable source-tree fingerprints over sorted regular files and supported symbolic links |
| `src/workflow/contract.ts` | Workflow-kernel Node vocabulary, binding enforcement, Output Schema validation, canonical edges, run-state contract, route eval metadata |
| `src/workflow-kernel/foundation.ts` | Shared plan loading, candidate resolution, proposal normalization, blockers, plan hash, confirmed state, and atomic state persistence |
| `src/skill/find.ts` | Compatibility adapter to the shared discovery seam |
| `src/factory/proposal.ts` | Standalone compatibility adapter to the shared proposal seam |
| `src/factory/generate.ts` | Deterministic official-parity `SkillBundle` generation, entry/internal Node Skills, control-plane resources, and protocol/evidence artifacts |
| `assets/runtime/*.mjs` | Byte-preserved workflow-kernel state, guard, and hook-guard runtime templates from pinned official revision `99fd749` |
| `src/factory/state.ts` | Standalone compatibility adapter to the shared state seam and `.comet-any` namespace |
| `src/authoring/lifecycle.ts` | Canonical authoring-lane DAG, hash-bound records, claim/artifact/review validation, and readiness |
| `src/eval/run.ts` | Read-only current-package inspection and persisted route/control-plane Eval evidence |
| `src/publish/lifecycle.ts` | Combined authoring/Eval readiness, reviewer approval, hash-bound publication, and distribution preview |
| `src/cli.ts` | Thin Creator-facing command interface |

## Deliberate exclusions

The upstream Creator closure also reaches `domains/comet-classic`, `domains/comet-native`, `domains/comet-entry`, `domains/engine`, `domains/skill/platform-install`, and host platform registries through the general Comet Bundle distribution path. Those modules are not copied or imported here. The standalone seam uses local package publication and preview-only distribution instead.

The upstream `comet-five-phase-overlay` and `comet-native` built-in contracts are excluded. Only `workflow-kernel` is accepted by the standalone plan loader. The source checkout remains available for comparison and is protected from edits by the parent repository instructions.

The extracted foundation accepts a project root, optional home directory, and state namespace. The standalone adapter fixes the namespace to `.comet-any`; it does not change the workflow contract or candidate-resolution semantics. Strict preference resolution is fail-closed: a missing or ambiguous source remains a proposal blocker.

Authoring plans live under `.comet-any/authoring/<name>/plan.json`, outside the hashed Bundle. Authoring records remain outside the Bundle as well, so evidence updates do not invalidate the generated artifact hash.

## Differential baseline

`primer_designer_harness/differential/primer-designer-workflow.json` is the pinned three-Skill fixture for comparing candidate resolution, source/reference evidence, source hashes, normalized workflow protocol, generated artifact inventory, and initial readiness. `primer_designer_harness/differential/extraction-manifest.json` records the reusable workflow-kernel closure and the deliberate Classic, Native, installer, Engine, and host-platform exclusions.

The differential runner uses disposable projects and home directories. It canonicalizes project-root and state-namespace paths before comparing generated inventories and readiness evidence. It never builds or writes the upstream checkout, reads `primer_designer_harness/raw_data/`, executes biological resources, submits schedulers, or installs host-platform files.

## Follow-up candidates

These are intentionally separate future batches:

1. Add a production-quality platform adapter interface with filesystem and in-memory adapters.
2. Add external eval runners behind an injected adapter.
3. Add package signing and publication registry integration.
