# Primer Designer Differential Harness

The differential harness compares the standalone Badger Creator with the pinned upstream reference Creator using the same `workflow-kernel` workflow definition and byte-identical copies of the three reorganized Primer Designer Skills.

## Safety boundary

- The source fixture is limited to `primer_designer_harness/skills/`.
- `primer_designer_harness/raw_data/` is rejected before any source read.
- `/home/hugo/AI/repos/comet/` is read only and is checked against the revision in the extraction manifest.
- Both Creators run against disposable temporary projects and temporary home directories.
- The harness does not execute biological scripts, submit scheduler jobs, download genomes, or install host-platform files.

## Run

The official CLI must already be built from the pinned official checkout or from a disposable build copy of that checkout. The harness never builds inside the protected upstream checkout.

```bash
npm run build
node bin/badger.js differential \
  /home/hugo/AI/Badger-workflows/primer_designer_harness/differential/primer-designer-workflow.json \
  --repo . \
  --fixture-skills-root /home/hugo/AI/Badger-workflows/primer_designer_harness/skills \
  --official-root /path/to/pinned/reference-checkout \
  --json
```

The command runs official `creator candidates`, `creator propose`, confirmed temporary `creator init`, temporary `creator generate`, and read-only `publish review`. The standalone side uses the equivalent discovery, proposal, confirmed initialization, generation, and initial review-readiness seam.

## Report

The JSON report records:

- source fixture manifests before and after the run, with a byte-integrity result;
- official candidate status, source and reference inventory, and source hashes;
- both normalized workflow protocols;
- generated artifact inventories with file sizes and SHA-256 hashes;
- initial readiness blockers, warnings, and evidence for both Creators;
- an extraction manifest separating reusable workflow-kernel modules from Classic, Native, installer, Engine, and host-platform code;
- deterministic comparison flags and official-only or standalone-only artifact paths.

The official plan is the shared fixture plan with the standalone-only `schemaVersion` wrapper removed because the pinned official parser does not accept that wrapper. The workflow definition, goal, preferences, and locale remain identical.
