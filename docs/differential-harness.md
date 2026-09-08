# Differential Harnesses

Badger has two credential-free differential harnesses. Both run in disposable
projects, use synthetic inputs, verify protected source integrity, and keep
expected packaging differences separate from semantic mismatches.

## Creator and authoring

The Creator harness compares standalone Badger with the pinned upstream Creator
using the same workflow definition and three reorganized Primer Designer source
Skills. The fixture is limited to
`/home/hugo/AI/Badger-workflows/primer_designer_harness/skills`; its
`raw_data/` tree is rejected before any source read. The upstream checkout is
read-only and must match the revision recorded in
`test/fixtures/authoring/authoring-compatibility.json`.

```bash
npm run build
node bin/badger.js differential \
  /home/hugo/AI/Badger-workflows/primer_designer_harness/differential/primer-designer-workflow.json \
  --repo . \
  --fixture-skills-root /home/hugo/AI/Badger-workflows/primer_designer_harness/skills \
  --official-root /path/to/pinned/reference-checkout \
  --json
```

The authoring comparison uses the same boundary and additionally checks the
six-lane DAG, dependency waves, claims/output envelope, quick/full review
depth, authored leaves, deterministic backbone, lane lifecycle, and readiness
gates:

```bash
node bin/badger.js authoring-differential \
  /home/hugo/AI/Badger-workflows/primer_designer_harness/differential/primer-designer-workflow.json \
  --repo . \
  --fixture-skills-root /home/hugo/AI/Badger-workflows/primer_designer_harness/skills \
  --official-root /path/to/pinned/reference-checkout \
  --depth quick \
  --output /tmp/badger-authoring-differential.json \
  --json
```

Reports preserve source manifests, hashes, protocol and package inventories,
readiness evidence, and expected Badger extensions. A compatible report has no
semantic mismatches or missing functionality, complete lifecycles on both
sides, unchanged sources, and a verified upstream revision. The harness does
not claim parity for Classic, Native, Entry, platform, dashboard,
credential, biological-execution, or protected-raw-data behavior.

## Engine

The Engine harness records a read-only behavioral baseline for the pinned
upstream Engine and compares the extracted Badger Engine. The scenario fixture
is `test/fixtures/engine/engine-characterization.json`, protected by
`test/fixtures/engine/manifest.json`.

```bash
npm run build
node bin/badger.js engine-differential \
  test/fixtures/engine/engine-characterization.json \
  --repo . \
  --official-root /path/to/pinned/reference-checkout \
  --private \
  --output /tmp/engine-differential-report.json \
  --confirm-output \
  --json
```

The matrix covers deterministic single- and multi-step Runs, failed outcomes
and retries, pending-action recovery, guardrails, manual and standalone Run
adapters, artifacts and evaluations, trajectory and checkpoint recovery,
unsafe paths and IDs, source drift, Skill snapshots, compatible and
incompatible upgrades, and resolver/current-step rejection. The harness never
executes Skill scripts, biological tools, scheduler jobs, database queries, or
platform installers.

The Engine public subpath is `@rpamis/badger/engine`; filesystem protection,
atomic writes, storage layouts, and other implementation details stay private.
The pinned official checkout is evidence only, and Badger contains no runtime
import of it.

`compareEngineObservations` classifies results as `official-baseline`,
`exact-match`, `expected-packaging-difference`, or `semantic-mismatch`.
Certification requires complete matrix coverage, unchanged protected sources,
and zero semantic mismatches. Temporary coordinates and timestamps may be
normalized; state, identities, ordering, evidence, artifacts, evaluations,
and safety errors may not.

## Shared safety rules

- Build the official CLI from a disposable copy; never build in its protected checkout.
- Keep all fixture projects, homes, and Run directories under the operating system temporary directory.
- Do not execute biological or host-platform behavior as part of differential evidence.
- Treat incomplete coverage or blocked certification as failure, not parity.
