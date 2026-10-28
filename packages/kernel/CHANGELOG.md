# Changelog

## What's Changed [Unreleased]

### Added

- **Agent-first FactoryPlan authoring**: Renamed the package-facing creation Skill to `/badger-create`, added multi-exchange questionnaire handoffs with distinct fact ledgers, and exposed read-only first-use and Creator resume context through `badger guide`.

- **Documentation and release alignment**: Added the complete package-facing
  authoring reference set, a substantive Authored-zone example, a safe assembled
  package-inventory example, and a release artifact ledger. Updated the README
  and bilingual workflow manual to distinguish delivered Badger behavior from
  planned work.

- **Collaborative service decisions**: Added architecture decision records for
  the collaborative service's scope, identity boundary, Postgres-owned state,
  drafting and sign-off rules, and questionnaire records with semantic dossier
  version 2. The glossary gains the service's people, records, notifications,
  and Run terms.

- **Legacy draft migration**: Added source-identity manifests, explicit
  retained/replaced/wrapped upgrade decisions, legacy scaffold classification,
  and a confirmed sibling migration path into authoring.

- **Authoring preview**: Added a read-only six-lane AuthoringPlan preview with
  separate authoring and workflow protocol hashes.
- **Resumable authoring scaffold**: Confirmed generation now creates an
  authoring-pending scaffold, durable lane-session state, hash-bound record
  storage, and an explicit assembly command.
- **Six-lane authoring handoff**: Added lane-output validation,
  revision-checked concurrent persistence, fresh-process recovery reporting,
  package-local role briefs, and a credential-free manual file-provider
  fixture.
- **Protected assembly**: Added staged deterministic scaffold replacement,
  Auto-zone/Authored-zone validation, a relative package inventory, and the
  Badger-named plan, check, and hook-guard control-plane roles.

- **Substantive authored leaves**: Added quality-bar validation and a multi-Node manual fixture for semantic Decision Core, Node Guidance, pause-point, recovery, and review content.
- **Authoring review readiness**: Added hash-bound quick/full review evidence, independent deterministic self-consistency checks, and structured authoring/runtime/publication readiness.
- **WorkflowRuntime cross-validation**: Added protocol-bound authored guidance checks for decisions, routes, required calls, schemas, guardrails, recovery ownership, artifact selection, and route-independent Run-state regression coverage.
- **Current-hash publication gate**: Publication approvals now persist an integrity-checked readiness snapshot and revalidate package, source, authoring, evaluation, certification, and approval evidence before publication or preview distribution.

### Changed

- **Scope**: Badger's scope now includes the collaborative service around the
  kernel: a server, a web dashboard, the Badger MCP, and a host installer.
  Everything shipped stays generic; each deployment keeps its launcher
  entries, reverse-proxy routes, and deploy scripts outside the repository.
- **Repository layout**: The repository is now an npm workspace. The kernel
  package moved to `packages/kernel/` with the same published name, `badger`
  CLI, and exports. Build, test, and format checks run from the repository
  root, and new workspace packages go in `packages/<name>/`.
- **Package name**: Renamed the package to `@realityjunky/badger`.
- **Script-lane claims**: The plan, check, and hook-guard claims are now
  `script:badger-plan`, `script:badger-check`, and `script:badger-hook-guard`.
- **AuthoringPlan validation**: Plans are always validated in full; the
  `compatibility` block and the lenient validation mode are gone.
- **Portable Creator records**: Creator state, authoring sessions, and
  evaluation and publication records store project-relative paths, and the
  generated package records its in-project sources the same way. The
  authoring plan and source evidence hashes no longer include source roots,
  so a project can move mid-authoring or after release without regeneration;
  authoring sessions created before this change must be regenerated.
  `generatePackage` now requires `projectRoot`.

### Removed

- **Comparison tooling**: Removed the `differential`, `authoring-differential`,
  and `engine-differential` commands, their exports, fixtures, and tests.

## What's Changed [0.1.2] - 2026-09-03

### Changed

- **Differential fixtures**: Added an explicit fixture Skill root so the Badger core can validate domain harnesses stored in separate repositories.

## What's Changed [0.1.1] - 2026-09-03

### Changed

- **Package identity**: Rebranded the standalone workflow Creator and Engine as Badger, including its CLI, Skill asset, persistence namespaces, generated package layout, and runtime environment variables.
