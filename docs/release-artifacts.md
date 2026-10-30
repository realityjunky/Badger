# Badger Release Artifact Ledger

This is the current documentation index for standalone Badger. It records the
package boundary, release-facing artifacts, and checks that must stay aligned
with the implementation. The kernel package is the delivered workflow-kernel
core. The repository's scope also includes the collaborative service around
it, as [ADR 0002](adr/0002-collaborative-service-in-scope.md) records. Domain
workflows live in separate repositories.

The repository is an npm workspace. The kernel package, `@realityjunky/badger`,
is in `packages/kernel/`, and the kernel paths below (`src/`, `assets/`) are
relative to it. New workspace packages go in `packages/<name>/`.

## Current boundary

| Surface                                                                     | Status                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Authority                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Creator and WorkflowRuntime                                                 | Delivered                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | `src/authoring/`, `src/factory/`, `src/eval/`, `src/publish/`, `src/workflow-runtime/`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Six-lane authoring                                                          | Delivered                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | `assets/skills/badger-create/reference/authoring-protocol.json`, role briefs, `src/authoring/`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Hash-bound durability and readiness                                         | Delivered                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | `src/workflow-runtime/`, `src/eval/`, `src/publish/`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Collaborative service: server walking skeleton                              | Walking skeleton (#36), platform sign-in (#38), groups and roles (#40), workflows and versions (#41), Skill versions (#42), personal access tokens (#53), Skill pins and source checks (#43), Sources gate and inbox (#44), source study (#45), questionnaire rounds and answers (#46), answer resolutions (#48), question threads and expert concerns (#47), ledger and readiness (#49), OpenID Connect and trusted-header sign-in (#69), dossier versions (#50), drafting jobs (#55), structured answers and attachments (#51), plan versions (#58), source drafting jobs (#56), WeCom notifications and reminders (#57), proposal approval and initialization (#59), workflow version inheritance (#52), Skill versions from Git (#70), consistent ledger reads (#75), questionnaire record checks (#77), Agent hosts on token writes (#79), `.git` refusal in Skill uploads (#80), return to the requested page after sign-in (#81), bounded pending sign-ins (#82), concurrent sign-ins (#83), commas in trusted-header display names (#84), sign-in timeout and proxy-peer tests (#85) | `packages/server/src/`, reviewed SQL in `packages/server/migrations/`, and the worker role in `packages/server/src/worker.ts`, which runs source checks, initialization jobs, and notification delivery; the expert and engineer MCP profiles are delivered in `packages/mcp/` (#54, #55); Operator installation and the host installer are delivered in `packages/hosts/` (#64); Runtime Run tools follow separately                                                                                                                                                                                                                                                                                                  |
| Collaborative service: web dashboard                                        | Shell (#37), admin and activity (#40), workflows (#41), Skills (#42), token settings (#53), Sources stage (#43), Sources gate and inbox (#44), Source study (#45), Questionnaire (#46), answer resolutions (#48), threads and concerns (#47), ledger and readiness (#49), MCP setup (#54), sign out (#69), dossier versions (#50), drafting jobs and suggestions (#55), structured answers (#51), plan versions (#58), source drafting (#56), notifications and reminders (#57), proposal and initialization (#59), inherited records and evidence changes (#52), Git import (#70), retire confirmation (#76), declared kernel dependency (#78)                                                                                                                                                                                                                                                                                                                                                                                                                                              | `packages/web/src/`: the rail, top bar, three-pane registry layout, the token source, URL routes, zh/en catalogs, the Admin pages, the Activity page, the Workflows page with its Sources stage and gate and its Source study, Dossier versions, Plan versions, Proposal and initialization, and Notifications and reminders panels, the Questionnaire page with its resolutions, threads, concerns, ledger, structured answers, and drafting jobs and suggestions, the inbox on My work and the top bar, the Skills page with Git import, personal settings for tokens, MCP setup, notifications, and channel addresses, and the Playwright journeys |
| Collaborative service: local MCP                                            | Expert profile (#54), engineer profile (#55), plan drafting (#58), source drafting jobs (#56), structured answers and attachments (#51), `.git` refusal in Skill folders (#80)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | `packages/mcp/src/`: stdio entry point, service-backed tools, answer attachments in `attachments.ts`, the engineer profile's job tools and claimed-job folders in `engineer-tools.ts` and `jobs.ts`, bounded result resources, and an in-memory client suite at the service seam; dashboard setup configurations live in `packages/web/src/pages/settings/McpSetup.tsx`                                                                                                                                                                                                                                                                               |
| Domain workflow definitions and source Skills                               | External                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Domain workflow repositories, supplied to Badger through explicit `skillSources`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Backup and restore procedure                                                | Documented (#72)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | `docs/backup-and-restore.md` and `docs/examples/restore-smoke.mjs`; each deployment owns its schedule, scripts, and retention                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Deployment glue: launcher entries, reverse-proxy routes, and deploy scripts | External                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Each deployment's own repository                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Automatic distribution, domain execution                                    | Out of scope                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Not shipped in this repository                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

Host installation (#64) is delivered in `packages/hosts/`, the Operator MCP
installation tools, and the dashboard's published-version **Install locally**
action. The browser supplies a publication/hash-bound local CLI command. Local
previews enumerate writes/deletes with expected and proposed hashes; commits
require the exact digest and explicit confirmation, recheck conflicts and root
identity, preserve unrelated host configuration, and verify installed bytes with
the kernel. Claude Code, Codex and WorkBuddy support project and user scope.
Tokens come only from the host environment; no token values enter generated
configuration or plans. Temporary filesystem, CLI, real-service MCP and browser
checks do not claim manual host application validation. See
[the host adapter](../packages/hosts/README.md) and
[ADR 0034](adr/0034-preview-bound-local-host-installation.md).

Personal access tokens (#53) are delivered in the server and personal settings:
scoped bearer authentication, hashed storage, one-time secret display,
expiration, revocation, recorded uses, and per-token rate limits. The server
refuses every action reserved for people. The API and current profile
operations are documented in `packages/server/README.md`.

Skill pins and source checks (#43) are delivered in the server, its worker
role, and the Workflows page: revisioned pins of immutable Skill versions,
durable source-check jobs leased from Postgres, kernel source checks on the
pinned content, and the Sources inventory with script effects and blockers.
[ADR 0015](adr/0015-pinned-skill-versions-and-source-check-jobs.md) records
the queue and workspace contract; a deployment runs the worker role beside
the server.

The Sources gate and inbox (#44) are delivered in the server and the
dashboard: a preview that binds the version frame, the pins, and the source
check under one confirmation hash; commits by signed-in people that replay
per client request ID; invalidation in the same transaction as a pin change;
and inbox items with unread, read, and done states and deep links, shown on My
work and the top-bar badge. [ADR 0016](adr/0016-gate-confirmations-and-inbox.md)
records the replay and invalidation contract, and migration `0009` adds the
tables.

Artifacts by receipt (#31) are delivered in WorkflowRuntime: Output Schema
artifacts under declared external roots, or above the 2 MiB read cap, are
verified in place and recorded in Completion evidence with their path, size,
SHA-256, modification time, and producing Attempt. A workflow declares each
external root by name only, and the host binds it to a directory when a Run
starts. With
`requireCurrentAttempt`, an output older than the Attempt is refused as
`artifact-stale-attempt`. Runtime certification covers receipts
(`docs/workflow-runtime-certification.md`), and
[ADR 0017](adr/0017-artifact-receipts-and-attempt-freshness.md) records the
freshness rule.

The Run registry and exported read models (#32) are delivered in the kernel's
public WorkflowRuntime seam: `listRuns` discovers standalone Runs from their
authoritative records, and `inspect` and `projectState` read continuations,
status, current Node, pending action, and history for either Run location.
Rebuildable projections and stray directories never establish a Run, and a
Run awaiting recovery is listed and projected as blocked, with the
`recovery-required` finding that `inspect` returns. Locks
remain attributable after hostname changes using a host identity scoped to
the boot and process namespace; unknown owners still block recovery.
[ADR 0018](adr/0018-run-lock-host-identity.md) records the identity sources
and legacy-record compatibility.

Source study records (#45) are delivered in the server and the dashboard:
revisioned facts and interfaces whose evidence the server checks against the
pinned Skill version's inventory and stored file, cited lines readable at every
revision, audited writes, and a study completion for each pinned version that
a signed-in person confirms. The last completion opens Questionnaire while no
active record cites a version that is no longer pinned; a record change reopens
Source study, and a pin change invalidates every completion.
[ADR 0019](adr/0019-source-study-records-and-completion.md) records the
evidence and invalidation contract, and migration `0010` adds the tables.

Questionnaire rounds and free-text answers (#46) are delivered in the server
and the dashboard: revisioned questions, rounds that a signed-in person
publishes after previewing them in priority order, an optional round size
limit per workflow, private autosaved answer drafts, submission per question
or per round with every revision and its channel kept, inbox items that close
once answered, and a per-person event stream with polling as the fallback.
Migration `0011` adds the tables; ADR 0006 already records the questionnaire
as records.

Answer resolutions (#48) are delivered in the server and dashboard. Engineers
confirm formal facts in the workflow locale against exact submitted answer
revisions, publish follow-up child questions, defer with reasons, or withdraw.
Each answering person acknowledges or disputes each restatement in a
hash-bound dashboard sign-off. Disputes reopen the question and notify the
Engineer; changed answers or cited evidence require re-confirmation. Skills
show their internal-question backlog. Immutable records, foreign keys, and
append-only guards are added by migration `0012`;
[ADR 0020](adr/0020-answer-resolution-reconfirmation.md) records the
re-confirmation contract.

Question threads and expert concerns (#47) are delivered in the server and the
dashboard: comments thread under each question with every edit kept, open to
every workflow role except Observer, and a Field expert's unprompted concern
reaches every Engineer's inbox. A signed-in Engineer turns each concern into a
draft question, accepts it as a Fact source, or declines it with a reason.
Migration `0013` adds the tables.

The ledger and readiness (#49) are delivered in the kernel, the server, and the
Questionnaire page. The kernel computes the five-part ledger and each dossier
topic's readiness with its blockers from the records, and the server only
projects its records into that read model. Inferences and assumptions are
revisioned drafts that an Engineer, or an Agent with an engineer token, writes;
only a linked question's acknowledged facts confirm one, and retiring one takes
a signed-in person. Publishing a round stores an immutable ledger baseline, so
the ledger shows what changed since each round. Migration `0015` adds the
tables; [ADR 0022](adr/0022-questionnaire-ledger-and-round-baselines.md)
records the baseline and confirmation contract.

OpenID Connect and trusted-header sign-in (#69) are delivered in the server's
identity adapters and the dashboard's user menu: the authorization-code flow
with PKCE, state, and nonce, signed ID token validation, and Badger's own
Strict session cookies, stored as hashes and revoked at sign-out; and a
subject, email, and name read only from configured proxy peers. Migration
`0014` adds the transaction and session tables;
[ADR 0021](adr/0021-oidc-browser-sessions.md) records the same-origin callback
continuation, and [`identity-adapters.md`](identity-adapters.md) documents the
settings.

The Badger MCP's expert profile (#54) is delivered in `packages/mcp/`: a stdio
server that calls the API with a personal access token, offers only the tools
the person's roles and the token's scopes allow, announces a new tool list when
they change, records answers with the Agent channel and host, previews a Skill
folder upload's content hash before it creates the version, and leaves every
sign-off to the dashboard. Personal settings give setup configurations for
Claude Code, Codex, and WorkBuddy, and
[`packages/mcp/README.md`](../packages/mcp/README.md) lists the tools and
settings.

Dossier versions (#50) are delivered in the kernel, the server, and the
Workflows page: `composeSemanticDossier` projects the records into a version 2
Semantic dossier with Engineer-authored topic summaries and Node
responsibilities, composition is refused while readiness has blockers, and the
canonical snapshot with its ledger is stored once under its SHA-256. The latest
of the append-only heads names the current version: identical content returns
it unchanged, and an earlier version's content selects that version again,
which is audited and needs a new approval. The Workflow owner approves the
exact hash through the shared gate protocol, and a new head or a change to the
records it relies on supersedes the approval and notifies the Engineer and the
Workflow owner. Migration `0016` adds the tables;
[ADR 0023](adr/0023-immutable-dossier-versions.md) records why the artifact
stays immutable and approval lives in gate history.

Drafting jobs and the engineer MCP profile (#55) are delivered in the server,
the Questionnaire page, and `packages/mcp/`: hash-bound context bundles,
stored output schemas, 30-minute leases bound to the claiming person, token,
and Agent host, expiry back to the queue, cancellation only when the inputs a
job's kind reads change, and results that stay suggestions until a signed-in
Engineer accepts them as draft questions. An Agent with an `engineer` token
lists, claims, submits, and releases jobs and reads the questionnaire, ledger,
and readiness; claiming writes the context and the exact files of the pinned
Skills the job's kind reads to a private local folder, and the MCP refuses any
file whose path has a `.git` component. A claim larger than twice the upload
limit is refused with 413, and the job stays queued. Every job action is
audited with its person, token, and Agent host. Migration `0017` adds the
tables.

Structured answers and attachments (#51) are delivered in the server, the
Questionnaire page, and the expert MCP profile: single and multiple choice, yes
or no, numbers in a fixed unit, tables, and files, validated against each
question revision's type, and attachments of at most 5 MiB each, eight files,
and 20 MiB per answer in the blob store, private until a submitted answer uses
them. Resolutions bind the structured values and attachment hashes, and facts
keep the answers' receipts. Through the MCP, `save_answer` takes a structured
`value` and `attachments`, and `upload_attachment` checks a local file's type
and size against the service's limits before sending it. Migration `0018` adds
the columns and table; [ADR 0024](adr/0024-structured-answer-provenance.md)
records the provenance contract.

Plan versions (#58) are delivered in the kernel, the server, the Workflows
page, and the engineer profile's job tools: `deriveFactoryPlan` fixes the
approved dossier's frame, ordered Node identities, and pinned sources,
`composeFactoryPlan` validates edits live, saves quote the preview hash and
the base version, and a `draft-plan` job's result stays a suggestion until an
Engineer accepts it. As with dossiers, append-only heads name the current
plan version, so saving an earlier version's content selects it again. The
Workflow owner approves the exact plan and dossier hashes, and a new head or a
dossier, fact, or pin change invalidates that approval. Migration `0019` adds
the tables; [ADR 0025](adr/0025-dossier-bound-plan-versions.md) records the
binding to the dossier version.

Source-study, restatement, translation, and import jobs (#56) are delivered in
the server, the drafting panel, and the engineer profile's job tools. Accepted
results go through the existing authorities: source-study facts and interfaces
pass Source study's evidence checks, restatements become facts that link to the
current submitted answer revisions and still need the expert's acknowledgement,
translations attach to the question revision they translate, and imported
numbered open questions become draft questions linked to their Skill version,
and a numbered source question enters a workflow version at most once; a
repeat gets 409. Migration `0020` adds the kinds and the translation and import
tables.

WeCom group robot notifications, Remind, and Copy reminder (#57) are delivered
in the server, its worker role, and the dashboard: encrypted, masked robot
webhooks per workflow or as a Group default, saved only once the deployment sets
`BADGER_NOTIFICATION_KEY` and `BADGER_PUBLIC_URL`, a test post on save, one post
per committed action and chat that mentions recipients by WeCom userid or mobile
number and carries only metadata and a link, delivery paced per robot and
retried with backoff through the deployment's proxy, waiting at least 60 seconds
after a rate limit without spending a retry, personal mention preferences, and
Remind at most once per item per hour, with Copy reminder where no robot is set
or a post would reach nobody. The dashboard writes Copy reminder in the viewer's
language with an absolute link. A workflow's Delivery log, and a Group's for its
default robot, record how each person was mentioned but never a userid or mobile
number, and neither does Remind; a pending invitee is named "Invited person",
never by email address. A worker that lacks a setting records a failed attempt,
and a failed post never blocks a gate. Each committed action takes a random
identity, so a restore cannot make actions collide. Tests cover posting at a
stub robot; a post to a real team chat has not been verified. Migration `0021`
adds the tables; [ADR 0026](adr/0026-transactional-notification-delivery.md)
records why posts are grouped by the committed action, and
[`backup-and-restore.md`](backup-and-restore.md) says to back up
`BADGER_NOTIFICATION_KEY` with the deployment's secrets.

Proposal approval and initialization (#59) are delivered in the server, its
worker role, and the Workflows page: the kernel's proposal for the approved
plan with its blockers, source identities, and hash, a Workflow owner's
approval that binds the proposal, plan, dossier, and pins, and an Engineer's
initialization request that runs as a durable worker job and replaces an
existing Creator state only by quoting its hash. The worker commits the kernel
state's exact bytes and hash with the job's outcome, stage changes, and audit
entry in one transaction; plan or dossier changes invalidate the approval and
cancel unfinished jobs. When the kernel's proposal hash changes under an
active approval, as after a kernel upgrade, the owner's approval of the
current proposal supersedes the stale one. Failed and cancelled
initializations are audited, and a materialized plan file that differs from
the stored canonical JSON is rewritten from the database. Migration `0022`
adds the job kind and the state table;
[ADR 0027](adr/0027-transactional-proposal-initialization.md) records the
transaction contract.

Skill and workflow version changes (#52) are delivered in the kernel ledger,
the server, and the dashboard: pin changes compare cited file hashes, so
changed or removed evidence reopens questions, including deferrals, and marks
source-derived facts stale, while unrelated files keep their confirmations, and
each affected record shows the old and current file. A question or follow-up
may cite an earlier Skill version while the cited file is byte-identical in the
current pin, and a follow-up is checked before sign-off. A new workflow version
copies its predecessor's pins, source study, questionnaire records, answers,
facts, acknowledgements, resolutions, accepted translations, and import
provenance, each linked to its origin, and records `workflow_version.inherited`;
pending questionnaire inbox items move to it, and the earlier version's items
close. The new version queues its own source check and needs fresh gates, and
the Sources, dossier, plan, and proposal panes list every approval, marking
superseded ones. Migration `0023` adds the provenance tables;
[ADR 0028](adr/0028-workflow-version-inheritance.md) records what is inherited
and what is not.

Skill versions from registered Git repositories (#70) are delivered in the
server and the Skills page: a Field expert or Engineer registers an HTTPS
repository from an origin the deployment allows in
`BADGER_GIT_ALLOWED_ORIGINS` and imports one full commit hash over smart HTTP,
without credentials, redirects, hooks, filters, or checkout, within bounded
time and size. URLs with `?` or `#` and Git LFS content are refused. An
unreachable host, a timeout, or a missing `git` binary answers 503
`unavailable`, and each server process runs at most two fetches at once,
refusing more with 503 and `Retry-After`. The tree takes the upload path, so
the same files get the same Skill version as an upload, and append-only
receipts record each repository and commit. A receipt means the commit was
fetched from that repository by its hash; a host can serve a commit that none
of the repository's branches contains, and checking reachability is a
follow-up. Migration `0024` adds the tables;
[ADR 0029](adr/0029-registered-git-skill-versions.md) records the transport
and identity rules.

Consistent ledger reads (#75) are delivered in the server: the ledger and a
round's baseline read their records under the version lock that every
questionnaire writer takes, so each sees one consistent state. Questionnaire,
drafting-job, and Remind transactions lock the workflow row and then the
version row, both `FOR NO KEY UPDATE`, and a Postgres deadlock or
serialization failure answers 503 with `Retry-After`, never 500. A
Postgres-only test reads ledgers and publishes rounds while people confirm
facts.

Retire confirmation (#76) is delivered in the dashboard: the Ledger and
readiness view asks before retiring an inference or assumption, names its
kind, and says that a retired draft cannot be revised and leaves the ledger
and readiness. Cancelling sends nothing, and the browser journeys cover both
answers.

Questionnaire record checks (#77) are delivered in the kernel:
`createQuestionnaireHandoff({ records })` refuses a malformed record before
computing any ledger, with an error that names its kind, ID, and problem. The
record types name only the values the handoff accepts, and ledger items copy
only an origin's `workflowVersionId`, `recordId`, and `revision`.

Agent hosts on token writes (#79) are delivered in the server and the
Activity page: token writes record the Agent host, and the Activity page shows
it beside the `mcp` channel. Every token request, reads included, must
name its Agent host.

The `.git` refusal in Skill uploads (#80) is delivered in the server, the
Skills page, and the expert MCP profile: a folder or zip upload with a `.git`
path segment is refused, at preview and at creation, with a message that
suggests uploading `git archive` output instead, and the MCP refuses such a
folder before it reads a file or sends a request.

Return to the requested page after OpenID Connect sign-in (#81) is delivered
in the server: the return path is kept only if it is on Badger's own origin
under the base path, and it is stored with the server-side sign-in
transaction.

Bounded pending sign-ins (#82) are delivered in the server:
`BADGER_OIDC_MAX_PENDING_SIGN_INS`, 10,000 by default, caps pending OpenID
Connect sign-ins, and a start beyond it evicts the oldest and is never refused.

Concurrent sign-ins (#83) are delivered in the server: each pending OpenID
Connect sign-in has its own flow cookie, at most three per browser, so two
tabs can sign in at once, in either order.

Comma-bearing display names (#84) are delivered in the trusted-header adapter:
a display name sent once may contain commas, while the subject and email still
refuse them.

The dashboard declares its type-only kernel dependency (#78), and server tests
now cover OpenID Connect provider timeouts and IPv4-mapped proxy peers (#85);
neither changes behavior.

## Package-facing artifacts

The installed Agent entrypoints are `assets/skills/badger-create/SKILL.md` and
`assets/skills/badger-workflow-questionnaire/SKILL.md`. The latter's source
study is beside it. `badger guide` is read-only and reports first-use,
`FactoryPlan`, and resumable Creator state; explicit confirmation remains
required before proposal, initialization, generation, publication, or
distribution.

The `badger-create` reference set is:

- `reference/authoring-protocol.json` — lane DAG, claims, review settings, deterministic backbone, and authored leaves;
- `reference/authoring-subagents.md` — bounded role handoffs and dependency waves;
- `reference/bundle-authoring.md` — scaffold, assembly, content leaves, and upgrades;
- `reference/authored-zone-example.md` — substantive Decision Core and Node Guidance;
- `reference/eval-provider.md` — authoring review, runtime evaluation, certification, and publication approval;
- `reference/package-inventory.example.json` — safe relative-path ownership example.

The `badger-workflow-questionnaire` reference set is:

- `reference/semantic-dossier.md` — the version 2 dossier envelope, five-part
  fact ledger, `interfaces` topic, deferred-question resolutions, fact
  provenance, and the one goal shared with the plan;
- `reference/source-study.md` — the questionnaire's elicitation pattern and
  Badger's explicit-source adaptation.

## Generated package

The checked-in inventory example omits session state, provider metadata,
internal reports, and byte hashes. Generated
`reference/package-inventory.json` files contain the complete hash-bound
inventory and readiness evidence.

| Owner      | Meaning                                       | Examples                                                         |
| ---------- | --------------------------------------------- | ---------------------------------------------------------------- |
| `auto`     | Deterministic assembler output                | Protocol, manifests, scripts, guardrails, checks, evaluation     |
| `authored` | Validated lane content at a declared leaf     | Entry and Node guidance, decision points, recovery, skill review |
| `source`   | Bundled Skills and preserved upgrade material | `sources/<hash>/` Skills and `source/` upgrade files             |

Assembly requires the authored `SKILL.md`, active Node guidance,
`reference/decision-points.md`, `reference/recovery.md`, and
`reference/skill-review.md`. Missing, duplicated, placeholder, stale, or
unexpected executable content blocks readiness.

Entry and Node Skills carry deterministic Runtime Access guidance (#34):
prefer the Badger MCP Run tools (`start`, `next`, `submit`, `status`, and
`recover`) when available and use the script adapter on hosts without MCP.
MCP gate answers stay with signed-in people in the dashboard. The workflow-entry
and skill-core lanes preserve this section while authoring their content leaves.
Generation tests cover both modes, and evaluation verifies that assembly
preserves the guidance and that edits invalidate the assembled package hash.
Runtime certification covers the shared WorkflowRuntime and generated scripts;
live MCP transport and service behavior are checked with the MCP implementation.

## Ownership

| Responsibility                                              | Current authority                                           |
| ----------------------------------------------------------- | ----------------------------------------------------------- |
| Explicit Skill source inspection, identity, and inventory   | `src/skill/identity.ts`, `src/workflow-kernel/discovery.ts` |
| Workflow contract normalization and validation              | `src/workflow/contract.ts`                                  |
| Plan, proposal, confirmation, and `.badger` state           | `src/workflow-kernel/foundation.ts`, `src/factory/`         |
| Six-lane authoring and deterministic assembly               | `src/authoring/`, `src/factory/generate.ts`                 |
| Evaluation, publication readiness, and distribution preview | `src/eval/`, `src/publish/`                                 |
| Skill loading, snapshots, Engine, and durable Run storage   | `src/skill-runtime/`, `src/engine/`                         |
| Public WorkflowRuntime seam                                 | `src/workflow-runtime/public.ts`                            |

Deployment glue and domain execution remain outside this repository. Domain
workflow repositories own workflow definitions, source Skills, and domain
fixtures; Badger consumes only the explicit sources supplied by a caller.

## Documentation

[`badger-workflow-manual.html`](badger-workflow-manual.html) is explanatory
material, not runtime policy. Generated package checks and current TypeScript
are authoritative when prose conflicts with code. The detailed
WorkflowRuntime contract and certification evidence are in
[`workflow-runtime-certification.md`](workflow-runtime-certification.md).
[`GLOSSARY.md`](../GLOSSARY.md) defines the domain language, and
[`adr/`](adr/) records the architecture decisions behind the kernel and the
collaborative service.

## Release gate

Run at the root of a clean disposable checkout or worktree:

```bash
npm ci
npm run build
npm test
npm run format:check
npm pack --dry-run -w packages/kernel
# The dashboard's browser journeys and visual checks. Build first.
npm run test:e2e -w packages/web
```

Focused authoring and artifact checks:

```bash
npm test -w packages/kernel -- test/authoring-plan.test.ts test/authoring-lifecycle.test.ts test/release-artifacts.test.ts test/workspace-layout.test.ts
npm test -w packages/kernel -- test/package-runtime-modes.test.ts
npm test -w packages/kernel -- test/workflow-runtime-artifact-receipt.test.ts
```

If a release changes the protocol, generator, generated control-plane names,
authored leaves, source boundary, or documentation references, update the
packaged authoring protocol, the inventory example, this ledger, the manual,
and the focused artifact tests in the same change.
