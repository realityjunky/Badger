# Changelog

## What's Changed [Unreleased]

### Added

- **Run registry and public read models**: WorkflowRuntime lists a project's
  standalone Runs, including their location, status, current Node, pending
  action, and outcome history. `listWorkflowRuns`, `inspectWorkflowRun`, and
  `projectWorkflowState` are public exports with matching runtime methods.
  Discovery ignores projections and stray directories. Mutation locks use
  hostname-independent host identities so recovery can still attribute a
  lock after a host rename, while refusing unknown owners (#32).

- **Artifacts by receipt**: An Output Schema can declare named external roots,
  each with only a description, and an artifact can opt into
  `verification: "receipt"`. The host binds each root to a directory when a Run
  starts, through the `externalRoots` start option or the script adapter's
  `--external-root <name>=<directory>`, so a package names no host path.
  WorkflowRuntime then verifies the artifact in place, outside the Run root or
  above the 2 MiB read cap, by streaming SHA-256, and records its path, bound
  root, size, hash, modification time, and producing Attempt in the accepted
  Completion evidence. With
  `requireCurrentAttempt`, an output older than the current Attempt is refused
  as `artifact-stale-attempt`. Other artifacts keep the Run-root boundary and
  read cap, and runtime certification covers receipts (#31).

- **MCP mode in generated packages**: Generated entry and Node Skills carry a
  Runtime Access section that prefers the Badger MCP Run tools (`start`,
  `next`, `submit`, `status`, and `recover`) when a host offers them, sends MCP
  gate answers to a signed-in person through the dashboard, and keeps the
  bundled script adapter, unchanged, for hosts without MCP (#34).

- **Semantic dossier version 2**: The questionnaire dossier now carries the
  `interfaces` topic for data contracts between Nodes, a resolution with scope
  and reason for every deferred question, provenance for every confirmed fact
  (confirming person, answer revisions, and acknowledgement), and one goal
  shared with the FactoryPlan. Deferred questions no longer block the handoff;
  unresolved questions still do. Version 1 is retired, and the validator
  refuses it with a migration finding. The handoff remains a pure read model
  shared by `badger questionnaire-handoff` and library callers.

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
- **Source check**: `badger source-check` (alias `candidates`) reports each
  declared source's identity hash, an inventory of every file with its hash,
  configuration included, each script's declared side effects, the files it
  ignored, and any blockers. The identity hash and the inventory leave out a
  fixed list of operating-system, editor, and cache files, so a new
  `.DS_Store` stales neither a proposal nor a package. A source manifest or a
  plan's `skillSources` declares one or more side effects per script, with
  `none` standing alone; an undeclared script is reported as undeclared. A
  source outside the project must resolve inside a root the host registers
  with `--source-root`, `BADGER_SOURCE_ROOTS`, or the kernel's `sourceRoots`
  option; a manifest's `roots` and a plan's `sourceRoots` are refused.

### Changed

- **Proposal-bound initialization and generation**: `init` requires the
  approved proposal's hash, `--proposal <proposalHash>` as `propose` printed
  it, and refuses a plan or Skill source set that no longer produces it. It
  replaces an existing Creator state only when the caller quotes that state's
  hash with `--replace-state <hash>`; the hash covers the state file exactly as
  stored, so a refused `init` reports it even for a file that no longer
  parses, and a value that is not a hash is refused as such. `generate`
  requires `--confirm`, refuses drift from the approved proposal, and refuses a
  state whose recorded proposal no longer matches its hash; the kernel API is
  `generateFromApprovedProposal`. `migrate` refuses a plan edited since
  initialization. `initializeState` takes `proposalHash` and
  `replaceStateHash` in place of `plan` and `proposal`, and
  `verifyApprovedProposal` returns the rebuilt proposal with the plan it read.
- **Canonical plan and proposal hashes**: Plan and proposal hashes are computed
  over canonical JSON, so reordering keys or reformatting a plan leaves them
  unchanged. Creator states recorded before this change keep matching an
  unchanged plan through the hash form they recorded, so `guide` and
  in-progress authoring continue. They carry no proposal hash, so `generate`
  refuses them until the proposal is approved again with `propose` and
  `init --replace-state`.
- **Command output**: The commands print human-readable output by default;
  pass `--json` for machine-readable output.
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
- **Upgrade-source inspection**: `inspectUpgradeSource` takes the project root
  and the registered source roots, resolves a relative source against the
  project, and refuses a source outside them; its evidence records the
  source's real path.

### Removed

- **Comparison tooling**: Removed the `differential`, `authoring-differential`,
  and `engine-differential` commands, their exports, fixtures, and tests.

## What's Changed [0.1.2] - 2026-09-03

### Changed

- **Differential fixtures**: Added an explicit fixture Skill root so the Badger core can validate domain harnesses stored in separate repositories.

## What's Changed [0.1.1] - 2026-09-03

### Changed

- **Package identity**: Rebranded the standalone workflow Creator and Engine as Badger, including its CLI, Skill asset, persistence namespaces, generated package layout, and runtime environment variables.
