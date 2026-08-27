# Creator Lifecycle Reference

The standalone Creator keeps state under the project’s `.comet-any/` directory:

```text
.comet-any/
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

The lifecycle is intentionally filesystem-only. Platform-specific Skill installation and external Agent runners are adapters that belong outside this standalone package.
