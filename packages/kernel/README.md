# Standalone Badger

This package contains the Badger Creator and Engine seams. It provides a focused, filesystem-based factory for creating and upgrading Skill packages, plus a private Engine foundation for loading, snapshotting, and running Badger-compatible Skills.

Badger's scope also includes a collaborative service around this kernel, so that an organization's field experts, engineers, and reviewers can build and run workflows together. The service is planned in [#24](https://github.com/realityjunky/Badger/issues/24); [Delivery status](#delivery-status) records what is built.

In the Badger repository, this is the kernel package of the npm workspace, in
`packages/kernel/`. Paths below, such as `assets/`, are relative to it; `docs/`
and `GLOSSARY.md` are at the repository root.

## Scope

The kernel package includes:

- a shared workflow-kernel foundation behind the standalone Creator adapters;
- explicit local Skill source inspection with stable hashes and ambiguity reporting;
- deterministic Workflow Contract normalization and validation;
- approved-proposal-bound plan/state lifecycle in the standalone `.badger` namespace;
- version 2 semantic questionnaire dossiers with traceable fact ledgers,
  interfaces between Nodes, deferral resolutions, fact provenance, resumable
  gaps, and deterministic authoring input identities;
- generated authoring-pending scaffolds with resumable six-lane authoring
  sessions and protocol/evidence references;
- bundled source Skills with package-relative locations, complete identity
  files, and the fixed source identity ignore rules;
- hash-bound quick/full authoring review with deterministic self-consistency findings and composite authoring/runtime/publication readiness;
- WorkflowProtocol-bound cross-validation of authored decisions, routes, Skill Calls, Output Schemas, guardrails, recovery, and artifact selection;
- protected deterministic assembly with separate Auto-zone, Authored-zone, and
  source inventory ownership;
- generated Badger plan, check, hook-guard, and WorkflowRuntime control-plane
  scripts;
- generated entry and Node instructions that prefer Badger MCP Run tools when
  available and retain the script adapter for hosts without MCP;
- current-hash evaluation, WorkflowRuntime certification, integrity-checked review approval, publication, and non-mutating distribution preview;
- private Skill runtime loading, validation, content identity, and immutable snapshots;
- deterministic and adaptive Engine loop behavior with manual and standalone Run façades;
- protected Run state, pending-action, trajectory, artifact, context, and checkpoint storage;
- exclusive, diagnosable per-Run mutation locks with explicit stale-owner recovery;
- a public WorkflowRuntime for deterministic workflow start, resume, revisioned outcome submission, and recovery;
- bounded declared Cycle execution with stable identities and append-only repeated-visit evidence;
- immutable Attempt-, Cycle-, and Run-lifetime artifact versions with protected content hashes and explicit carry-forward;
- bounded Decision Receipt scope references tied to accepted artifact and evidence versions;
- bounded, content-addressed physical-tree and Git-aware snapshots for explicitly declared project scopes;
- immutable, content-addressed Verification Receipts for automated checks, static inspections, and manual evidence, with bounded redacted summaries and freshness enforcement;
- evidence-bound repair episodes with finite budgets, stagnation decisions, bounded overrides, and restart-safe history;
- bounded transactional finalization for protected local writes, removes, and moves with preview, confirmation, recovery, and final receipts;
- versioned structured findings with bounded redaction, deterministic ordering, continuation dispositions, and derived legacy blockers.

The collaborative service adds a server, a web dashboard, the Badger MCP, and a host installer beside the kernel. Its server role's walking skeleton is in `packages/server/` and the web dashboard's shell in `packages/web/`; the expert and engineer MCP profiles are delivered in `packages/mcp/` (#54, #55), and Operator installation and the local host installer are delivered in `packages/hosts/` (#64); Runtime Run tools follow separately. They call into the kernel and never reimplement it, so WorkflowRuntime stays the only runtime authority. Everything shipped is generic: each deployment keeps its own launcher entries, reverse-proxy routes, and deploy scripts outside the repository. The kernel still excludes ambient resume routing.

Authoring in the service (#61) uses this kernel's bounded handoffs, dispatch
readiness, output validation, record persistence, and confirmed assembly. The
service keeps accepted outputs immutable and replays them through the kernel in
a new namespace before committing a session pointer; it never computes another
lane dependency graph. See ADR 0031 for the transaction boundary.

## Delivery status

Delivered behavior and planned work are kept apart:

| Surface                                     | Status                                                                                                                                                                                             | Contract                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Badger Creator and WorkflowRuntime          | Delivered                                                                                                                                                                                          | Local workflow-kernel package creation, six-lane authoring, deterministic assembly, durable Run execution, current-hash evaluation, publication approval, and distribution preview.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Collaborative service                       | Walking skeleton (#36), platform sign-in (#38), dashboard shell (#37), groups and roles (#40), workflows and versions (#41), Skill versions (#42), OpenID Connect and trusted-header sign-in (#69) | The server role in `packages/server/`: reviewed SQL migrations, the identity port with local single-user mode, platform session introspection, OpenID Connect sign-in with Badger's own sessions, and trusted proxy headers, nested groups and role bindings by email with server-side capability checks, audited writes with recorded overrides, the filtered activity log, personal preferences, and the health endpoint. Workflows, version frames, eight-stage tracks, and workflow role controls extend the server and dashboard (#41), and so do immutable Skill versions uploaded as folders or zips (#42), or imported from registered Git repositories at a commit (#70). The web dashboard's shell, Admin pages, and Activity page live in `packages/web/`. The expert and engineer MCP profiles are delivered in `packages/mcp/` (#54, #55), including leased drafting jobs and person-reviewed questionnaire suggestions; Operator installation and the local host installer are delivered in `packages/hosts/` (#64); Runtime Run tools follow separately. |
| Deployment glue                             | Outside this repository                                                                                                                                                                            | Each deployment's launcher entries, reverse-proxy routes, and deploy scripts live with that deployment.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Automatic distribution and domain execution | Out of scope                                                                                                                                                                                       | Distribution always needs explicit confirmation, Badger never executes domain scripts itself, and fixtures derived from protected raw data are never used.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |

The release-facing artifact map and verification commands are in
`docs/release-artifacts.md`. It is the authoritative checklist for keeping
the formal Skill references, generated package inventory, compatibility
fixture, workflow manual, and release gate aligned. Architecture decisions,
including the service's scope, identity boundary, storage, and sign-off
rules, are recorded in `docs/adr/`; the domain language is in `GLOSSARY.md`.

The collaborative service also delivers the Skills library (#42): immutable
folder and zip uploads, source checks through this kernel, full inventories,
script side-effect declarations, bounded file previews, and version diffs.
An Engineer or Field expert on a workflow uploads to that workflow's Group.
The server and the Badger MCP refuse an upload with a `.git` path segment,
suggesting `git archive` output instead (#80). Imports from registered Git
repositories at a full commit hash (#70) take the same path, so the same tree
gets the same version as an upload. See `packages/server/README.md` from the
repository root for its API and limits, and
`docs/adr/0029-registered-git-skill-versions.md`.

Operator Run tools and durable mirroring (#65), dashboard gate answers (#66),
and Run integrity and recovery (#67) are delivered in the service, MCP, and
dashboard. The service flags unattested decisions, event gaps, and mismatched
published execution identities. Recovery stays in the local WorkflowRuntime;
its audited outcome is shown on the Run. See `packages/server/README.md`,
`packages/mcp/README.md`, and ADRs 0035–0037 for these observer boundaries.

Questionnaire rounds and free-text answers (#46) are delivered in the server
and dashboard: revisioned questions, priority-ordered publication previews,
private autosaved answers, per-question or atomic round submission, automatic
inbox completion, and per-person live updates with polling recovery. The
service retains the kernel's dossier topic vocabulary. Answer resolutions (#48) add formal
facts linked to exact answer revisions, expert acknowledgements and disputes,
published child questions, reasoned deferrals with Skill backlogs, withdrawal,
and re-confirmation after answer or cited evidence changes. Sign-offs stay in
the dashboard.

Structured answers (#51) let a question ask for a single or multiple choice,
yes or no, a number in a fixed unit, a table, or a file, validated on the
server against the question revision's type. Any answer may carry
size-limited attachments in the blob store, and resolutions bind the
structured values and attachment hashes, so facts keep the receipts of the
answers they restate. See `docs/adr/0024-structured-answer-provenance.md`.

Ledger and readiness (#49) derive the five-part ledger from durable records
through `createQuestionnaireHandoff({ records })`. The kernel lists blockers
for scope and every dossier topic, including interfaces, and compares ledger
items with immutable round-publication baselines. Inferences and assumptions
remain drafts until their linked question's facts are acknowledged, and the
dashboard asks before retiring one (#76). This record-readiness result does not
compose, validate, or approve a dossier; the existing dossier/FactoryPlan
handoff retains those validation requirements. The records form checks
required fields, types, topics, identities, and references before computing
any ledger items (#77). Invalid records throw an error naming the record kind,
its ID, and the problem, and the record types name only the values the handoff
accepts. Historical facts may retain older resolution and answer revisions
after the current heads advance. A ledger item keeps only an origin's
`workflowVersionId`, `recordId`, and `revision`. The service reads a ledger's
records, and a round's baseline, under the version lock that every
questionnaire writer takes, so each read sees one consistent state; a Postgres
deadlock or serialization failure answers 503 with `Retry-After`, never 500
(#75).

Dossier versions (#50) add `composeSemanticDossier`: the kernel projects the
acknowledged facts, source-derived facts, confirmed inferences, and deferred
resolutions into a Semantic dossier with Engineer-authored topic summaries
and Node responsibilities. Its canonical snapshot includes the ledger's
record identities and revisions. The service stores valid snapshots once,
and the Workflow owner approves the exact hash through a human gate. Record
changes supersede approval and notify the Engineer and Workflow owner.

Dossier source identity is the normalized, Project-relative `location` plus
`contentHash`. The kernel resolves that location against the current Project
root when matching inspected sources, so moving the storage workspace preserves
an approved proposal, while changed Skill bytes still make it stale. New
dossiers omit absolute `canonicalPath` values. Legacy dossiers remain readable
in the service's history without their storage paths; their canonical text is
withheld (`canonicalJson: null`, `requiresRecomposition: true`). Their original
bytes, hashes, and confirmations remain stored, but they require recomposition
and fresh dossier, plan, and proposal approvals before further authoring.

Plan versions (#58) add `deriveFactoryPlan`, `composeFactoryPlan`, and
`factoryPlanDraftSchema`. The skeleton fixes the approved dossier's frame,
ordered Node identities, and pinned sources; edited plans retain the exact
dossier and source script declarations. Canonical Plan snapshots bind the
Dossier version hash. The service offers live validation, Agent drafting
suggestions, immutable saves, and Workflow owner approval through the existing
human gate protocol. Dossier changes invalidate dependent plan approvals.

Proposal approval and initialization (#59) show this kernel's proposal for
the approved Plan version, with its blockers and source identities, and bind
the Workflow owner's gate confirmation to the proposal, plan, dossier, and
pins. Initialization runs as a durable worker job: it restores the last
committed Creator state bytes in a private namespace, calls this kernel's
initialization, and commits the new state's exact bytes and hash with the
job's outcome. Replacing a state quotes its hash, and plan or dossier changes
invalidate the proposal and cancel unfinished jobs. See
`docs/adr/0027-transactional-proposal-initialization.md`.

Package scaffold generation (#60) runs this kernel's confirmed generator as a
service job bound to the current initialized state and approved proposal. A
job-private Creator namespace keeps rollback and retries isolated without moving
the dossier's canonical sources. The service commits the package inventory,
Authoring plan, and exact Creator bytes with the job outcome; its dashboard shows
file owners, hashes, bundled source Skills, and MCP instructions. Regeneration
starts a new Authoring session and supersedes later work. See
`docs/adr/0030-transactional-package-generation.md`.

Skill and workflow version changes (#52) compare cited file hashes when a pin
changes: changed or removed evidence reopens questions, including deferrals,
and marks source-derived facts stale, while unrelated files keep their
confirmations. A new workflow version copies its predecessor's pins, source
study, questionnaire records, facts, and resolutions with provenance that the
kernel's ledger carries into dossier snapshots; approvals are never copied.
See `docs/adr/0028-workflow-version-inheritance.md`.

Question threads and expert concerns (#47) are also delivered: immutable
comment edits, concerns linked from the
Engineer's inbox, and reviewed outcomes that create a draft question, accept
a Fact source, or decline with a reason.

Personal access tokens (#53) are also delivered: personal settings create,
list, and revoke scoped Agent and CLI credentials, showing the secret once.
The server stores hashes, enforces expiration and current roles, records
each use, and limits requests per token. Tokens never perform actions
reserved for people, and token writes record the Agent host (#79). See
`packages/server/README.md` for the API and scope rules.

OpenID Connect and trusted-header sign-in (#69) have four follow-ups: after
OpenID Connect sign-in a person returns to the page they asked for, kept only
if it is on Badger's own origin under the base path and stored with the
server-side transaction (#81); `BADGER_OIDC_MAX_PENDING_SIGN_INS`, 10,000 by
default, caps pending sign-ins, and a start beyond it evicts the oldest and is
never refused (#82); each pending sign-in has its own flow cookie, at most
three per browser, so two tabs can sign in at once, in either order (#83); and
a trusted-header display name sent once may contain commas, while the subject
and email still refuse them (#84). See `docs/identity-adapters.md`.

Skill pins and source checks (#43) are delivered too: an Engineer pins
immutable Skill versions to a workflow version, and the worker role, the same
image started with `packages/server/dist/src/worker.js`, runs this kernel's
source check on the pinned content as a durable Postgres job. The Sources
stage shows each source's inventory, script effects, and blockers; after a
passed check the Engineer previews and confirms the source set at its gate
(#44). Confirmation records its actor, time, and exact hashes. Changing pins
invalidates it and notifies the Engineer and Workflow owner through the
in-app inbox, shown on My work and the top-bar badge. Gate commits replay the
original result for the same client request ID. See
`docs/adr/0015-pinned-skill-versions-and-source-check-jobs.md` and
`docs/adr/0016-gate-confirmations-and-inbox.md`.

Source study records (#45) are delivered in the service and dashboard:
revisioned source-derived facts and independent interfaces, evidence links
to immutable file lines, and human study-completion gates per pinned Skill
version. The server validates evidence hashes, retains retired records and
their revisions, audits writes, and invalidates changed studies. Completing
all pins opens Questionnaire. See
`docs/adr/0019-source-study-records-and-completion.md`.

Source drafting jobs (#56) add `source-study`, `restate-answer`,
`translate-question`, and `import-open-questions` to the drafting jobs that
the engineer profile claims (#55). Accepted results go through the existing
authorities: source-study records pass the evidence checks above,
restatements still need the expert's acknowledgement, translations attach to
the question revision they translate, and imported open questions become
draft questions linked to their Skill version.

WeCom group robot notifications (#57) add the first channel beside the in-app
inbox: encrypted, masked robot settings per workflow or Group, one post per
committed action and chat that mentions the people who need to act and
carries only metadata and a link, paced and retried delivery by the worker
role that never blocks a gate, a delivery log, and audited Remind at most
once per item per hour, with Copy reminder text the dashboard writes where no
robot is set or a post would reach nobody. Posting is tested against a stub
robot; a post to a real team chat has not been verified. See
`docs/adr/0026-transactional-notification-delivery.md`.

The dashboard declares its type-only dependency on this kernel (#78), and
server tests cover OpenID Connect provider timeouts and IPv4-mapped proxy peers
(#85); neither changes behavior.

Generated packages carry their source Skills in `sources/<Skill identity hash>/`.
The roots in `reference/resolved-skills.json` and the packaged
`reference/authoring-plan.json` resolve from the package root. Configuration,
references, scripts, and binary assets are included; operating-system, editor,
and interpreter noise is excluded using the source check's identity rules.
Identical inputs generated in different directories yield the same package
hash. After assembly, a copied package and its Creator records can pass
evaluation and runtime certification without the original source directories;
the bundled identities are checked when those originals are absent. An
available original still detects source drift, and publication approval keeps
its original-source checks. See `docs/adr/0014-bundle-source-skills.md`.

## Run persistence

Generated entry and Node Skills include a Runtime Access section for both
host modes. When Badger MCP Run tools are available, the Agent uses `status`,
`start`, `next`, `submit`, and `recover` from the operator profile. It follows
the returned continuation and local Node Skill path. Decision, manual-stop,
and finalization gates return a dashboard link for a signed-in person; the
MCP delivers the person's answer and the service's attestation on `next` or
`status`, bound to the exact pending action and Run revision. Changed
finalization effects require fresh confirmation. Hosts without
MCP use the bundled script commands, with local decisions submitted only
after the person confirms. An MCP failure follows the Run's findings and
recovery path. Evaluation certifies the shared runtime and scripts; live MCP
transport and service integration belong to the Badger MCP delivery.

Run files are stored through protected, bounded, atomic adapters. Missing Run
state returns `null`; missing trajectory, pending-action, and checkpoint files
return `[]`, `null`, and `null`, respectively; missing artifacts return `{}`;
missing context returns `null`. Existing files are validated before recovery,
and unsafe references, path escapes, link traversal, oversized content, and
failed writes are rejected without replacing the last valid state.

Authoring leaves are substantive content boundaries, not free-form package edits. Entry Decision Core and Node Guidance must explain their semantic decisions, evidence, completion reasoning, red flags, and recovery behavior; decision-point leaves must distinguish genuine user decisions, automatic handling, stop conditions, and manual handoffs. Placeholder or underspecified content, undeclared route or choice references, contradictory transitions, direct Run-state instructions, alternate recovery authorities, and implicit latest-artifact selection keep assembly blocked. Cross-validation evidence is recorded separately inside the hash-bound authoring review; it does not select routes or mutate WorkflowRuntime state.

## Standalone Run locations

Use `startStandaloneRun`, `resumeStandaloneRun`, `evaluateStandaloneRun`, and
`upgradeStandaloneRun` with a project root and a validated Run id. The adapter
maps each Run to `<projectRoot>/.badger/runs/<run-id>` and keeps the manual
Engine storage layout inside that location. It validates the id before
resolving or creating any Run path, and verifies that recovered state belongs
to the requested id. Execution, retry, snapshot, artifact, trajectory, eval,
and terminal behavior remains shared with the manual adapter.

## Development

Run these from the repository root:

```bash
npm install
npm run build
npm test
npm run format:check
```

`npm test -w packages/kernel -- test/<file>.test.ts` runs one test file.

The user-facing entrypoint is `/badger-create` in an Agent. The Agent supplies each source Skill by
name and location; Badger inspects only those declarations. The CLI is `badger` after `npm run build`;
from the repository root, run it as `node packages/kernel/bin/badger.js`:

```bash
# The source check is read-only and closed-world. `candidates` remains an alias.
node packages/kernel/bin/badger.js source-check --skill primer-design=./skills/primer-design --json
# A source outside the project needs a root the host registers; plans and manifests cannot.
BADGER_SOURCE_ROOTS=/srv/skills node packages/kernel/bin/badger.js source-check --skill primer-design=/srv/skills/primer-design --json
node packages/kernel/bin/badger.js guide --project . --json
node packages/kernel/bin/badger.js questionnaire-handoff dossier.json --plan plan.json --project . --json
node packages/kernel/bin/badger.js authoring-plan prepared-workflow --project . --depth quick --json
node packages/kernel/bin/badger.js generate prepared-workflow --confirm --project . --depth full --json
node packages/kernel/bin/badger.js authoring-status prepared-workflow --project . --json
node packages/kernel/bin/badger.js authoring-dispatch prepared-workflow --lane script --output /tmp/script.json --project . --json
node packages/kernel/bin/badger.js assemble prepared-workflow --confirm --project . --json
node packages/kernel/bin/badger.js migrate prepared-workflow --confirm --project . --json
```

`badger review <name> --json` reports distinct authoring, runtime, and publication readiness. The `skill-review` lane records quick or full authoring evidence; full review requires three independent voter records and all four review lenses. Deterministic self-consistency and WorkflowProtocol cross-validation findings never replace provider findings or WorkflowRuntime certification. `badger approve` records only human publication approval after authoring, evaluation, and WorkflowRuntime evidence are current.

Library callers that coordinate authoring across processes should use `authoringSessionGateway()`. Its persisted session identity, revision-aware lane decisions, readiness, recovery, lock inspection, and `writeGate()` results are the authoritative surface; recording requires `confirmed: true`, and assembly requires `--confirm` at the CLI or `confirmed: true` through the gateway.

`authoring-plan` is read-only. It accepts a confirmed workflow name after
initialization, derives the six-lane AuthoringPlan from the persisted normalized
proposal, and reports separate
`protocolHash` (AuthoringProtocol) and `workflowProtocolHash` (executable
WorkflowProtocol) identities. It does not create Creator state, authoring
records, or package files.

See `assets/skills/badger-create/SKILL.md` for the user-facing confirmation protocol and `docs/release-artifacts.md` for release status.

`generate` creates a deterministic scaffold and an authoring session under
`.badger/authoring/<name>`. The scaffold remains visibly pending until all
current lane records are submitted with `authoring-record` and the package is
assembled. Use `authoring-dispatch` to create a bounded file handoff for a
lane; the handoff exposes role-brief, input, output, dependency, and hash paths
but no Creator-state, execution, publication, distribution, or credential
authority. Submit the returned JSON with `authoring-record`; pass the status
revision with `--expected-revision` when coordinating concurrent lanes.
Authoring input, authored material, scaffold, and assembled package hashes are
stored separately; source changes retain old records as explicit stale evidence
instead of silently treating them as current. Status output includes completed
lanes, executable dependency waves, claims, artifacts, findings, and fresh-
process recovery paths. A deterministic manual file-provider fixture is
available through the exported `runManualAuthoringFixture` API for tests and
local certification without provider credentials.

Legacy deterministic drafts without an authoring session are classified
`legacy-scaffold-only`. They remain readable compatibility artifacts but are
not authoring-complete or publishable. `badger migrate <name> --confirm`
preserves the draft as source evidence, writes a sibling authoring package,
records retained, replaced, and wrapped source decisions, and requires all six
current lanes before assembly.

Assembly rebuilds a staged scaffold, validates every current lane artifact, and
swaps it into place only after the complete package passes the deterministic
inventory and control-plane checks. The generated
`reference/package-inventory.json` records relative paths and ownership
(`auto`, `authored`, or `source`); the typed `GeneratedPackage.inventory`
additionally carries byte counts and hashes.

The public package façade plus the `@realityjunky/badger/engine` and
`@realityjunky/badger/workflow-runtime` subpaths export the runtime
operations needed by callers. The WorkflowRuntime subpath exposes the
constructor, its four mutation operations, and read-only Run discovery and
inspection. Compiler, location resolution, Run-file storage, projection
writes, and protected filesystem implementation modules remain internal.

`createWorkflowRuntime()` implements `WorkflowRunRegistry`: call
`runtime.listRuns(projectRoot)` (or `listWorkflowRuns(projectRoot)`) to list
standalone Runs under that project's `.badger/runs/`, sorted by Run id. Each
`WorkflowRunRegistryEntry` includes its `location`, absolute `runRoot`, and
the `WorkflowStateProjection` fields: status, current Node, pending action,
outcome history, and execution identity. Discovery reads authoritative Run
records, ignores empty directories, invalid Run ids, linked entries, and
rebuildable projections, and creates no files. A Run awaiting recovery (a
pending transition, checkpoint recovery, or finalization transaction) is
listed and projected as `blocked`, with the same `recovery-required` finding
as `inspect`. Invalid records in an actual
Run are reported as errors rather than silently hiding it.

For a standalone or manual Run target, `runtime.inspect(target)` (or
`inspectWorkflowRun(target)`) returns the current continuation, including
recovery findings. `runtime.projectState(target)` (or
`projectWorkflowState(target)`) returns its state and history. Both return
`null` when no Run exists. Manual Runs are inspected by their explicit
location; the project registry discovers standalone Runs only.

Outcome history contains the latest 256 summaries. `historySummary` reports
`total`, `returned`, and `omitted` counts, so a long Run never silently loses
history from its read model. `runtime.readReport(target, afterSequence?)`
preserves every original committed event and its sequence independently of
that bounded summary.

Mutation locks record a hostname-independent, hashed host identity as well
as the hostname used for display. A hostname change preserves attribution;
an active owner is still protected, and only explicit recovery may take over
a proven-stale lock. An unknown host identity never permits takeover. See
`docs/adr/0018-run-lock-host-identity.md` from the repository root for the
platform identity sources and compatibility rules.

CI runs the Run storage suites on Linux. The macOS and Windows jobs stay off
until runners for those platforms exist (#86). From the repository root, run
`npm run build -w packages/kernel` followed by
`npm run test:runs -w packages/kernel` for the same storage, lock,
checkpoint, recovery, crash-boundary, and child-process contention suites.
Standalone Run ids use ASCII letters, digits, dots, underscores, and hyphens,
start with a letter or digit, and have at most 255 characters. Windows device
names (including names with extensions) and trailing dots are refused on
every platform before storage is created.

## Authoring references

The installed Badger Skill keeps the package-construction contract close to its
entrypoint:

- `assets/skills/badger-create/reference/authoring-protocol.json` defines the
  machine-readable lane DAG and deterministic backbone.
- `assets/skills/badger-create/reference/authoring-subagents.md` defines bounded file
  handoffs and the six role briefs.
- `assets/skills/badger-create/reference/bundle-authoring.md` describes scaffold,
  assembly, content leaves, and upgrade-existing behavior.
- `assets/skills/badger-create/reference/authored-zone-example.md` shows the required
  level of substantive Decision Core and Node Guidance content.
- `assets/skills/badger-create/reference/eval-provider.md` separates authoring review,
  deterministic evaluation, WorkflowRuntime certification, and publication
  approval.
- `assets/skills/badger-create/reference/package-inventory.example.json` shows the
  safe relative-path and ownership view of an assembled package.

## WorkflowRuntime

`createWorkflowRuntime()` accepts a normalized `WorkflowProtocol` and exposes
`start`, `resume`, `submit`, and `recover` operations. A Run location is either
`{ kind: "manual", runRoot }` or
`{ kind: "standalone", projectRoot, runId }`; the older `runRoot` start and
target forms remain supported for manual compatibility. Both locations use
the same compiled route, completion validation, identity checks, continuation
projection, retry behavior, and recovery semantics.

The runtime compiles active Nodes into deterministic Engine actions, excludes
disabled Nodes, and uses an explicit checkpoint for an empty route. A
successful machine submission checks the current Node's required Output Schema
artifacts and evidence, required Skill calls, enforced augmentations, and
guardrail evidence before advancing. Advisory augmentations remain
non-blocking. Missing prerequisites return a bounded `blocked` continuation
with the same pending action so corrected evidence can be submitted without
re-executing the Node; failed submissions use the Engine retry policy.

An Output Schema may declare up to 32 `externalRoots`. Each is a name and a
`description` of the directory it stands for, never a path. An artifact opts
into streaming verification with `verification: "receipt"`; its optional `root`
names one of that schema's external roots, and every declared root must be used.
Omitting `root` uses the Run root. Paths remain relative to the selected root
and may use `*` wildcards. For example:

```json
{
  "id": "analysis.v1",
  "description": "Analysis outputs.",
  "externalRoots": {
    "results": { "description": "The shared folder for analysis results." }
  },
  "artifacts": [
    {
      "id": "sequences",
      "kind": "file",
      "required": true,
      "paths": ["sample-*.fasta"],
      "validations": ["artifact-exists"],
      "verification": "receipt",
      "root": "results",
      "requireCurrentAttempt": true
    }
  ],
  "evidence": []
}
```

The host binds each declared root to a directory when the Run starts, with
`runtime.start({ protocol, location, externalRoots: { results:
"/data/workflow-results" } })`, or in a generated package with
`node scripts/workflow-state.mjs init --external-root results=/data/workflow-results`.
A Run does not start while a declared root is unbound, or when a binding names
an undeclared root or a directory that is relative, missing, a file, or itself
a link. Run state stores the binding, fixed for the Run, so the same package
runs on any host with a directory of its choosing. Output Schemas that share a
root name share its directory, so they must give it the same description.

Hosts learn what to ask before any Run exists: `runtime.startRequirements(protocol)`
is read-only and returns `{ externalRoots }`, sorted by name, each with its
`description` and the receipt `artifacts` that use it (`nodeId`, `artifactId`,
`paths`, and `requireCurrentAttempt`). The script adapter's `status` returns it
as `startRequirements` until `init` runs. A start refused over its binding
creates no Run and carries an `external-root-binding-required` finding with
`requiredAction: "execute"` on `workflow.start` and `requiresUserDecision: true`;
an unbound-root refusal names every unbound root with its description. The
finding's message is redacted and bounded like every finding, so hosts that
relay a refusal should also relay the error message. Each continuation and state
projection lists the current Node's `receiptOutputs`: `artifactId`, `paths`,
`root: { name, path }` (a `null` name means the Run root), and
`requireCurrentAttempt`. `recover` in a fresh process returns the same list.

Receipt verification streams file bytes through SHA-256 without the 2 MiB
content limit. Accepted Completion evidence contains `artifactReceipts`, with
each artifact's absolute `path`, `size` in bytes, `sha256`, `mtimeMs`, and producer
Run/Node/Cycle/Attempt/action/revision. A receipt under an external root also
records `root: { name, path }`, the root and its bound directory; loading a Run
whose receipts disagree with its binding is refused. The public continuation exposes this
evidence in its visit outcomes. Receipts are generated by WorkflowRuntime;
caller-supplied `evidence.artifactReceipts` cannot establish provenance.
There are at most 256 receipts per Completion, across all patterns and schemas.
Directory receipts hash a sorted manifest of at most 256 entries, including the
directory itself, and sum their file sizes. Links, junctions, traversal, and
special filesystem objects are refused.

Receipt declarations enable revisioned Attempts. With `requireCurrentAttempt`,
each file must have a modification time at or after the first persisted action
of the current Attempt. Empty directories use their own modification time.
Retries retain that boundary; a later Attempt establishes a new one. An older
output returns `artifact-stale-attempt` without advancing the Run. This detects
outputs left by skipped work; it does not attest which process wrote a file.
Because the check compares modification times, a fresh output copied with its
old time kept (`cp -p`, `rsync -a`, or an extracted archive), or written to a
network file system whose clock lags the host's, is refused as stale too.
Versioned receipt artifacts retain the original producer when carried forward;
current-Attempt requirements forbid carrying a previous Attempt's receipt.
Checkpoints verify receipt content without loading the artifact into their
content budget. Artifacts without receipt verification retain the Run-root
boundary and existing 2 MiB read limit.

Explicit decision Nodes compile to persisted `ask_user` actions. Their
continuation uses `await-user` and includes the stable decision question,
choices, bounded required-input schema, rationale policy, reviewer requirement
summary, revision, execution identity, and Attempt identity. A typed decision
response must match the current revision, action, Node, Cycle, Attempt,
protocol/package/snapshot identity, choice, reviewer attestation, input schema,
and rationale policy. Accepted responses route only
through declared choice transitions and create one runtime-timestamped,
identity-bound Decision Receipt. Invalid, stale, replayed, and cross-kind
submissions do not mutate the Run. A decision may declare optional or required
artifact and evidence scope entries. The pending action exposes only accepted
version ids, hashes, and producer identities; responses must echo required
references and may omit optional ones. Physical artifact drift and changed
append-only evidence reject the response before mutation. Scope data is
reference-only and does not add attachment storage or generalized snapshots.

`recover` reconstructs the continuation from the persisted identity, Skill
snapshot, Run state, and pending action. It does not use conversation context
or generated source files, and rejects Run-id, protocol, package, snapshot, or
pending-action drift before returning a continuation.

Workflows may opt into the `content-snapshots` durability capability with a
hash-bound physical-tree or Git snapshot policy. The policy declares a
provider, optional physical-tree fallback, include and exclude patterns, plus
file-count, file-size, total-size, manifest-size, traversal, duration, and
omission-detail limits. Git capture enumerates tracked, dirty, staged,
deleted, and selected untracked paths, then hashes the current working-tree
bytes; commit, index, and status identities are supplemental evidence only.
Captured entries contain only safe relative paths, sizes, and SHA-256 content
hashes; raw file contents are never placed in a manifest. Symlinks,
non-regular files, nested repository boundaries, selection races, provider
errors, and overflow produce bounded incomplete evidence. Git and physical-tree
captures of the same complete bytes have the same provider-independent content
identity, while an actual fallback is explicit in that identity. Snapshot
references are stored through the same protected lock and transition journal
as the Run mutation and recover identically in manual and standalone
locations. Repository-owned protected roots must be supplied by the host and
are rejected before provider enumeration if the declared scope would select
them.

Profiles that enable `repair-policy` declare a finite failure budget, warning and
manual-stop thresholds, allowed retry/stop/contract-change choices, and an
optional one-time override bound. Failed machine outcomes are reduced to a
canonical signature containing protocol and execution identity, Attempt context,
finding and receipt coverage, scope, snapshot, and artifact identities; prose,
timestamps, and retry action ids do not reset an episode. The second equivalent
failure warns, the manual-stop threshold creates a persisted repair `ask_user`
action, and the hard maximum blocks without an override. Repair history is
bounded and checked against the append-only trajectory during recovery. An
accepted retry decision continues the same Attempt, while contract change stops
the captured Run without rewriting its protocol identity.
The normalized policy registers the bounded idempotent `workflow.resume`
operation; automatic retry action materialization dispatches through that
operation inside the same locked transition journal.

Each continuation also carries the versioned `findings` catalog and its
`findingSummary`. Findings are bounded, deterministically ordered, redacted,
and expose registered runtime operations as argument arrays. `blockers` remains
only a compatibility projection for blocked continuations; callers should use
finding codes, required actions, and `requiresUserDecision` instead of parsing
messages.

Submissions are bound to the pending action with `actionId` and may identify
the expected Workflow Node with `nodeId`. Phase 4 submissions additionally
carry the observed `runId`, logical `revision`, and complete `execution`
identity. The runtime checks those values before validation and again at the
protected compare-and-swap boundary; a conflicting submission returns the
current continuation with a structured `revision-conflict` finding and does
not change committed Run records. Each accepted Phase 4 transition leaves a
protected transition-addressed revision claim, so replaying the same transition
cannot advance the Run twice. Output Schema evidence is supplied
under `evidence`, while required Skill-call, augmentation, and guardrail proof
may use the corresponding check identifiers in `evidence.completedChecks`.
Phase 4 mutations are first staged behind a protected write-ahead journal at
`.badger/transition-journal.json`. The journal records the operation, execution
identity, revision/action boundary, and exact previous and intended material for
each affected Run record. `resume` and `submit` return a `recovery-required`
finding while that journal is pending; only explicit `recover` classifies each
record as previous, intended, or unknown, rolls forward known mixtures, and
appends one bounded `recovery_reconciled` event. Unknown material remains
untouched and blocks recovery.
Profiles that enable `mutation-locks` additionally serialize every mutating
`start`, `resume`, `submit`, and `recover` operation through
`.badger/run-lock.json`. Lock owners carry bounded operation, process, host, and
creation-time metadata. Active, foreign, malformed, oversized, or replaced
locks return structured findings and are never stolen; only `recover` may
quarantine a lock whose local owner process is proven absent. Release checks
the owner token and file identity, and takeover evidence is appended to
`.badger/run-lock-recovery.jsonl` before journal recovery continues.

Profiles that enable `verified-checkpoints` additionally publish a bounded
content-addressed manifest and checkpoint record after each committed logical
mutation. The manifest binds the Run revision, execution identity, pending
action, Node, Cycle, Attempt, state identity, trajectory offset and prefix
hash, and referenced artifact version hashes and sizes. Recovery prefers a
fully verified authoritative Run head; it selects or restores an older
checkpoint only when the transition journal is settled and the live trajectory
proves that no later transition committed. Invalid checkpoint candidates and
ambiguous history remain structured findings. Checkpoint restoration uses a
protected recovery journal, appends one `recovery_reconciled` event, and keeps
retention bounded without evicting an active recovery anchor.

Checkpoint manifests and records contain identities and references, not copied
artifact contents. Generated adapters continue to delegate checkpoint
selection and restoration to the bundled WorkflowRuntime.

The returned continuation reports the current Workflow Node, pending Engine
action, current Cycle and Attempt, full Cycle and visit ledgers, stable
Node-to-step mapping, artifact version and selection ledgers, current valid
artifact selections, and protocol/package/snapshot identity.
Opted-in branch protocols declare routing fields and allowed scalar values. The
runtime supports exact equality, conjunction, one fallback edge, revisioned
outcomes, deterministic visit ordinals, and append-only Attempt evidence.
Ambiguous routes, undeclared values, undeclared graph cycles, and unreachable
required Nodes are rejected before Run state is created. Declared Cycles require
an entry Node, explicit repeat transitions, and a finite `maxInstances` budget.
First entry and accepted repeat transitions allocate stable Cycle identities
before the target Node is entered; exhausting the budget returns a non-mutating
blocker. Re-entered Nodes receive new Attempts, while Engine retries remain
within the existing Attempt.

Workflows opt into artifact provenance with the `versioned-artifacts`
capability. Output artifacts use Attempt lifetime by default and may declare
`cycle` or `run` lifetime. A successful producer action hashes one declared,
protected, bounded physical path and appends an immutable version containing
the logical artifact id, lifetime scope, producer Run/Node/Cycle/Attempt/action,
accepted revision, and runtime timestamp. Every required versioned output must
identify either one physical update under `artifacts` or one exact accepted
version under `artifactVersions`; ambient files are never captured implicitly.
Attempt-lifetime update paths include the current Attempt id as a path segment,
so repeated visits use physically isolated coordinates. The runtime never
selects an implicit latest version;
undeclared updates, incompatible scopes, unknown versions, and physical content
drift block before committed Run state changes.

Revisioned Runs start at logical revision `0`. Each accepted machine outcome or
decision response advances it once; route blockers, invalid submissions, and
stale submissions do not advance it.

Generated workflow packages include `scripts/workflow-runtime.mjs`, a bundled
WorkflowRuntime implementation, and thin `workflow-state.mjs`,
`workflow-guard.mjs`, and `workflow-handoff.mjs` adapters. State commands use
the runtime's persisted action and current Node, never route from a completed-
Node list, and maintain the legacy state document only as a rebuildable
projection. Guard verification, entry checks, completion validation, and
explicit apply all use the runtime's protocol and pending-action identity;
handoff only reads protocol metadata and the current continuation. `status`,
`next`, guard entry, dry guard exit, and handoff are read-only. Rebuild a
deleted or stale projection with `status --rebuild --confirm legacy-state`.
Use `BADGER_RUN_ROOT` or `--run-root` for manual Runs; use
`--project <dir> --run-id <id>` for standalone Runs.
Lock coordination remains private to the bundled runtime; generated adapters
cannot acquire, release, diagnose, or recover locks independently.
Generated state and guard adapters may forward `status: "failed"` outcomes and
repair decision payloads; they do not evaluate budgets, signatures, overrides,
or stop conditions.

`eval` runs the Phase 2 certification over the generated package and separate
synthetic Phase 3 and Phase 4 lifecycle certifications. A durability-declaring
package receives the Phase 4 stop/go matrix over one generated synthetic
package. The report binds the evaluated package hash to the normalized
protocol, compiled package, immutable Engine snapshot, resolver-plan,
capability, Node/action, route, Cycle, Attempt, artifact, decision, snapshot,
receipt, checkpoint, repair, transaction, final-receipt, projection,
fresh-process, concurrency, and source-integrity evidence. Evaluated-package
and synthetic-fixture tree hashes remain distinct. Review readiness fails closed
on missing, stale, mismatched, truncated, or incomplete Phase 4 evidence.
The fixtures use only disposable synthetic files and do not authorize domain
execution or package installation.

See `docs/workflow-runtime-certification.md` for the certification contract.

The collaborative service may call `approveReview({..., persistState:false})`
and `publishState(state, true, {persistState:false, destination})` over cloned
Creator state. All kernel readiness checks still apply. An explicit publication
destination must be inside the Project and must not already exist; standalone
callers retain the normal persisted lifecycle and default publication location.
`createPackageSnapshot(root, inventory)` captures regular package files as
portable base64 bytes, inventory and canonical package hash;
`verifyPackageSnapshot(snapshot)` verifies them with the same directory hash
algorithm. These public seams support immutable service publications and host/Run
consumers without reproducing package identity rules in adapters.

The public WorkflowRuntime observer seam `readReport(target, afterSequence?)`
returns a stable committed `projection`, unchanged `continuation`, original
ordered trajectory `events`, and `lastSequence`; it returns null before start.
Observers use it to repair reporting queues after a crash. Pending transitions
remain explicit recovery requirements. `continuation.completion` contains the
current Node's kernel-owned Completion requirements and full Output Schemas;
`projection.artifactReceipts` contains issued receipts with external root and
producing Attempt identity. A bounded retry of a protected journal read handles
atomic replacements by an active writer, without retrying submitted mutations or
relaxing file safety validation.
