# Creator Lifecycle Reference

The standalone Creator keeps state under the project’s `.badger/` directory:

```text
.badger/
├── states/<name>.json
├── drafts/<name>/
├── migrations/<name>/
├── eval/<name>.json
└── published/<name>/
```

The state machine is hash-bound:

```text
draft → generated → evaluated → review-approved → published
```

Initialization accepts only the approved proposal hash that `badger propose`
printed. It rebuilds the proposal from the current plan and Skill sources and
refuses to initialize when either no longer produces that hash. It also
refuses to replace an existing `.badger/states/<name>.json` unless the caller
quotes the current state's hash. Generation requires explicit confirmation and
refuses a plan or Skill source set that drifted from the approved proposal.
Plan and proposal hashes are computed over canonical JSON, so key order and
formatting do not change them. A state recorded before that change still
matches an unchanged plan, but carries no proposal hash: approve its proposal
again with `badger propose` and `badger init --replace-state` before
generating.

Deterministic drafts created before authoring are classified
`legacy-scaffold-only`. They remain readable compatibility artifacts, but they
are not authoring-complete or publishable. `badger migrate <name> --confirm`
creates a sibling upgrade package, preserves the original package under
`source/`, derives a fresh `AuthoringPlan`, and records retained, replaced, or
wrapped source decisions. All current authoring lanes must be re-recorded
before assembly.

- Generation clears and rebuilds the draft package.
- Evaluation hashes the generated package and records checks against that hash.
- Approval requires passing current-hash evaluation and a reviewer identity.
- Publication copies only an approved current-hash package.
- Distribution is preview-only and reports destination files without writing them.

`badger review` exposes structured authoring, runtime, and publication readiness. Authoring review is hash-bound to the authoring input, authored material, and assembled package. Quick review uses one voter and one round; full review uses three independent voters, four recorded lenses, a two-round dry threshold, and at most four rounds. Deterministic self-consistency evidence is retained separately from provider findings.

Publication approval is a distinct human decision. A passing authoring review cannot replace package evaluation, WorkflowRuntime certification, or explicit publication confirmation. Missing, stale, mismatched, unresolved, or fabricated review evidence blocks the relevant readiness section.

The lifecycle is intentionally filesystem-only. Platform-specific Skill installation and external Agent runners are adapters that belong outside this standalone package.

The public `authoringSessionGateway()` exposes the persisted session identity, revision-aware decisions, readiness, recovery, lock state, and write gates. Record and assembly writes require explicit confirmation through that gateway; the CLI equivalent is `badger assemble <name> --confirm`.
