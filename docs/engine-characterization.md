# Official Engine Characterization

The Engine characterization harness records a read-only behavioral baseline for
the pinned official Comet Engine before a private Engine implementation exists.
It is evidence infrastructure, not an Engine extraction.

## Safety boundary

- The official checkout is verified against the SHA-1 in
  `test/fixtures/engine/manifest.json` before any scenario starts.
- The official checkout and synthetic fixture Skills are snapshotted before and
  after the run. A changed source snapshot fails the characterization.
- Every scenario uses a temporary project, home directory, and Run directory
  under the operating system temporary directory.
- Fixture paths are restricted to `test/fixtures/engine/skills/` and reject
  `primer_designer_harness/raw_data/` before filesystem reads.
- The harness does not execute Skill scripts, biological tools, scheduler jobs,
  database queries, or platform installers.

The official CLI must be built from the pinned checkout or from a disposable
build copy at the same revision. The harness never builds inside the protected
upstream checkout.

## Run

From `comet-any-private/`:

```bash
npm run build
node bin/comet-any.js engine-differential \
  test/fixtures/engine/engine-characterization.json \
  --repo . \
  --official-root /path/to/pinned/comet \
  --private \
  --output /tmp/official-engine-baseline.json \
  --confirm-output \
  --json
```

## Scenario matrix

The fixture currently covers:

1. deterministic single-step completion with artifacts and completion evals;
2. deterministic multi-step progression and ordering;
3. failed outcomes, retry state, and subsequent recovery;
4. pending-action recovery without resubmitting an outcome;
5. confirmation-required guardrail rejection and confirmed continuation;
6. unsafe Run-state references that escape the Run root;
7. change-bound manual Runs;
8. corrupt current-step rejection during outcome recording.

Each scenario records the command observations and the durable Run files:
Run state, pending action, outcomes, artifacts, trajectory, checkpoint, evals,
and classified errors.

## Comparison contract

`normalizeEngineObservation` replaces only known temporary coordinates in the
scenario coordinate record, command arguments, and classified error messages.
Trajectory timestamps are represented as `<timestamp>` while event sequence,
event type, action identity, state, artifacts, and evidence remain unchanged.
Run ids, action ids, hashes, relative storage references, ordering, and safety
errors are never normalized away.

`compareEngineObservations` and `compareEngineObservationSets` classify results
as:

- `official-baseline` when only the official side is available;
- `exact-match` when normalized observations are equal;
- `expected-packaging-difference` when every difference is a known package or
  command-coordinate difference;
- `semantic-mismatch` when any state, identity, ordering, evidence, artifact,
  eval, trajectory, or error classification differs.

Without `--private`, the command records the official-only baseline. With
`--private`, it runs the same scenarios through the extracted private Engine
command adapter and reports exact matches, expected packaging differences, and
semantic mismatches in one report. Manual Run UUIDs and their derived action
identities are preserved as evidence and classified as expected packaging
nondeterminism. The private command adapter's error envelope is also recorded
and classified as packaging when the underlying error is identical; state,
ordering, hashes, artifacts, evals, and safety errors remain strict comparison
fields.
