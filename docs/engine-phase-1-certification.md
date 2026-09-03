# Engine Phase 1 Certification

## Baseline

- Upstream reference Engine: `0.4.0-beta.19`
- Revision: `99fd7495f8b9217efbaae3a46d885f6fa7f4102a`
- Source manifest: `test/fixtures/engine/manifest.json`
- Scenario fixture: `test/fixtures/engine/engine-characterization.json`

The official checkout is evidence only. It must remain read-only, and the
private package contains no runtime import from that checkout.

## Supported interface

The `@rpamis/badger/engine` subpath exposes the core Engine
interface, while the package root adds Skill-runtime and differential
certification operations for:

- Skill loading, validation, hashing, and immutable snapshots;
- Run state, actions, outcomes, deterministic resolver injection, loop
  decisions, adaptive guardrails, and runtime evals;
- manual change-bound Runs and standalone Run ids;
- durable pending actions, artifacts, trajectories, checkpoints, and upgrades;
- official/private differential observations and certification evidence.

Storage, path-protection, race-safe-read, and atomic-write implementations
remain internal modules.

## Parity matrix

| Capability | Scenario evidence |
| --- | --- |
| deterministic single-step and multi-step Runs | `deterministic-single-step`, `deterministic-multi-step` |
| failed outcomes and retry state | `failed-outcome-retry` |
| pending-action recovery | `waiting-action-recovery` |
| adaptive guardrails | `adaptive-guardrail-rejection` plus pure adaptive candidate tests |
| confirmation guardrails | `confirmation-guardrail-rejection` |
| manual and standalone Run adapters | `manual-run-persistence`, `deterministic-multi-step` |
| artifacts and runtime evals | `deterministic-single-step` |
| ordered trajectory evidence | `deterministic-single-step`, `failed-outcome-retry` |
| checkpoint persistence and recovery | `checkpoint-recovery` |
| unsafe Run paths and Run ids | `unsafe-run-state`, `unsafe-run-id` |
| source drift and snapshot identity | `source-drift` |
| compatible and incompatible upgrades | `compatible-upgrade`, `incompatible-upgrade` |
| unknown resolver/current-step rejection | `corrupt-current-step` plus resolver tests |

The report also compares state, pending action, outcome, artifact, trajectory,
checkpoint, Skill snapshot, eval, and classified-error observations. Only
temporary coordinates and documented manual UUID identity differences may be
classified as expected packaging differences.

## Certification gate

Run the following from the package root with a disposable build of the
pinned official checkout:

```bash
npm ci
npm test
npm run build
npm run format:check
npm pack --dry-run
node bin/badger.js engine-differential \
  test/fixtures/engine/engine-characterization.json \
  --repo . \
  --official-root /path/to/pinned/reference-checkout \
  --private \
  --output /tmp/engine-phase-1-report.json \
  --confirm-output \
  --json
```

The final command is successful only when the report has complete matrix
coverage, unchanged protected sources, and zero semantic mismatches. A blocked
certification is evidence that Phase 1 is not complete; it must not be
normalized into success.

The pinned revision was run from a disposable official checkout on 2026-08-29.
The resulting report verified the revision, kept both official and fixture
sources unchanged, reported no missing matrix capabilities, and returned
`certification.status: certified` with zero semantic mismatches. Expected
packaging differences were limited to temporary command envelopes and
process-generated manual Run identities.

## Explicit boundary

This certification does not design or implement WorkflowRuntime, first-class
decisions, conditional edges, cycles, Native durability hardening, or Primer
Designer migration. Phase 2 cannot begin without a separate proposal and
explicit approval.
