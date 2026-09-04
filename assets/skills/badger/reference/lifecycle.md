# Creator Lifecycle Reference

The standalone Creator keeps state under the project’s `.badger/` directory:

```text
.badger/
├── states/<name>.json
├── drafts/<name>/
├── eval/<name>.json
└── published/<name>/
```

The state machine is hash-bound:

```text
draft → generated → evaluated → review-approved → published
```

- Generation clears and rebuilds the draft package.
- Evaluation hashes the generated package and records checks against that hash.
- Approval requires passing current-hash evaluation and a reviewer identity.
- Publication copies only an approved current-hash package.
- Distribution is preview-only and reports destination files without writing them.

`badger review` exposes structured authoring, runtime, and publication readiness. Authoring review is hash-bound to the authoring input, authored material, and assembled package. Quick review uses one voter and one round; full review uses three independent voters, four recorded lenses, a two-round dry threshold, and at most four rounds. Deterministic self-consistency evidence is retained separately from provider findings.

Publication approval is a distinct human decision. A passing authoring review cannot replace package evaluation, WorkflowRuntime certification, or explicit publication confirmation. Missing, stale, mismatched, unresolved, or fabricated review evidence blocks the relevant readiness section.

The lifecycle is intentionally filesystem-only. Platform-specific Skill installation and external Agent runners are adapters that belong outside this standalone package.
