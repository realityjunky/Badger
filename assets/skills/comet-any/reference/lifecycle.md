# Creator Lifecycle Reference

The standalone Creator keeps state under the project’s `.comet-any/` directory:

```text
.comet-any/
├── states/<name>.json
├── drafts/<name>/
├── eval/<name>.json
├── authoring/<name>/plan.json
├── authoring/<name>/<lane>.json
└── published/<name>/
```

The state machine is hash-bound:

```text
draft → generated → evaluated → review-approved → published
```

- Generation clears and rebuilds the draft package.
- Generation writes the authoring plan outside the Bundle with the ordered `script`, `reference`, `pause-points`, `workflow-entry`, `skill-core`, and `skill-review` lanes.
- Authoring records validate lane identity, dependencies, claims, artifact hashes, statuses, and review output. Records are stored outside the Bundle so recording evidence does not change the Bundle hash.
- Evaluation hashes the generated package and records checks against that hash.
- Scaffold markers, `BLOCKED`, and `NEEDS_CONTEXT` records prevent readiness. Every completed record must match the current Bundle and protocol hashes.
- Approval requires complete authoring records, passing current-hash evaluation, and a reviewer identity.
- Publication copies only an approved current-hash package.
- Distribution is preview-only, reports every Bundle file, hash, and executable disclosure, and never writes destination or host-platform files.

An authoring record JSON file contains the lane status, one evidence entry for each planned claim, one presence/hash entry for each planned artifact, and (for `skill-review`) an approved review object:

```json
{
  "status": "COMPLETE",
  "claims": [{"id": "script-contract", "status": "SUPPORTED", "evidence": ["report.md"]}],
  "artifacts": [{"id": "scripts", "path": "scripts", "present": true}],
  "review": {
    "decision": "approved",
    "reviewer": "reviewer-id",
    "summary": "No blocking findings.",
    "blockingFindings": [],
    "warnings": []
  }
}
```

`BLOCKED` and `NEEDS_CONTEXT` records must include a summary and stop dependent lanes until replaced with a current `COMPLETE` record.

The lifecycle is intentionally filesystem-only. Platform-specific Skill installation and external Agent runners are adapters that belong outside this standalone package.
