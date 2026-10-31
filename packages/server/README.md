# `@realityjunky/badger-server`

The collaborative service's HTTP server. It uses reviewed SQL migrations on
Postgres or PGlite, and the kernel supplies source inspection and identity.
Build from the repository root so the kernel is built before the server.

Service deployments support platform sessions, OpenID Connect and trusted
identity headers from configured proxy peers. See
[identity adapter configuration](../../docs/identity-adapters.md) for OIDC
registration, Strict browser sessions, proxy trust, and email binding checks.

## Read-only demo

`/demo/` beneath `BADGER_BASE_PATH` is public sample content, including its
own `/api/v1/` namespace. It shows synthetic fixtures on the seven main
dashboard pages and requires no identity. Demo requests are handled before
session, bearer-token, database, worker, and blob access. They read only the
bundled fixtures and the dashboard build. GET and HEAD are supported; every
other method returns 405 with `Allow: GET, HEAD`. Unknown fixture records
return 404 and never reach a live handler. The normal service and its
authentication requirements remain on their existing URLs.

The demo reuses the service process and dashboard build; it does not seed,
reset, migrate, or clone application records. Its display capabilities
disable writes, while the HTTP boundary also refuses direct requests.
Theme and language changes are transient browser state. Add only synthetic
content to `src/demo/fixtures.ts`; never import deployment or user records.

## Building the image behind a proxy

Build from the repository root. Both `npm ci` in the build stage and
`apt-get` (Git and CA certificates) in the runtime stage need network access.
Export the deployment's proxy variables locally, then pass both cases as
Docker's predefined build arguments:

```bash
docker build -f packages/server/Dockerfile \
  --build-arg HTTP_PROXY --build-arg HTTPS_PROXY --build-arg NO_PROXY \
  --build-arg http_proxy --build-arg https_proxy --build-arg no_proxy \
  -t badger-server .
```

Set the uppercase and lowercase variables to the same values when both are
used. Docker exempts these predefined proxy arguments from the build cache
and image history and does not leave them in the image. Do not declare them
as `ARG`/`ENV` in the Dockerfile. Image pulls use the Docker daemon's own proxy
configuration; build arguments apply to commands inside the build.

## WeCom notifications and reminders

Workflow owners connect a WeCom group robot from the workflow's **Notifications
and reminders** panel. Group leads set defaults in **Settings → Channel
addresses**; the nearest ancestor Group default applies unless a workflow has
its own robot. Saving explicitly queues a test post. The saved webhook is
masked; a replacement is optional when editing its label or chat language.
Disconnecting cancels queued and retrying posts for that channel. Each post
through a Group default records its Group: the Group's Delivery log, shown
beside its robot settings, holds the default's test posts and every
workflow post it sent. Saving and disconnecting are audited with the robot
key, an HMAC of the webhook under `BADGER_NOTIFICATION_KEY`, as the before
and after hash: a label edit keeps the hash, and a different chat changes it,
without the webhook entering the Activity log.

People set their WeCom userid or mobile in **Settings → Channel addresses**
and choose mention events in **Settings → Notifications**. A userid follows
WeCom's rule: up to 64 letters, digits, and `_-@.`, starting with a letter or
digit; `@all`, which would mention the whole chat, is refused in any letter
case. Opting out affects chat mentions only; inbox items still arrive. Text
messages support userid and mobile mentions; people with neither appear by
name. A pending invitation appears as "Invited person", so posts never carry
an email address. Posts carry only workflow names, curated waiting-event
labels, each recipient's name and item count, the mentions, and links.
Question, answer, Skill, and Run content never enters the channel payload.

Configure the server and worker with the same `BADGER_NOTIFICATION_KEY`, a
stable random 32-byte key encoded as 64 hexadecimal characters, and
`BADGER_PUBLIC_URL`, the dashboard's absolute HTTPS URL including
`BADGER_BASE_PATH`. Loopback HTTP is permitted for local use. Keep the key in
the deployment's secret store and back it up separately from the database.
Changing or losing it makes existing encrypted robots and queued Deliveries
unreadable; disconnect and reconnect channels after an intentional key change.
No robot can be saved before these settings exist, and the refusal names the
missing one. The worker role reads them too: a worker that lacks either, or
whose key cannot decrypt a robot, records each attempt at a post as a failed
one with that reason in the Delivery log, and logs it, instead of leaving the
post queued or dropping it. The post fails after its fifth attempt, so a
worker with the settings can still send it before then. In-app notifications
and Copy reminder work without them.

Queued posts recheck current workflow and assignment capabilities before
delivery. Completed items, revoked recipients, and mention opt-outs are removed;
an empty post is cancelled. Legacy inbox items retain no inferred requester,
so only Workflow owners and Administrators can remind pre-upgrade items.

The worker role runs notification delivery alongside source checks; local
single-user mode embeds both. It reads `HTTPS_PROXY` / `https_proxy`,
`HTTP_PROXY` / `http_proxy`, and `NO_PROXY` / `no_proxy`. Each webhook has one
database-backed pacing reservation shared by every worker, with at least
3.1 seconds between send attempts. A failed post gets five attempts with
exponential backoff that honors numeric `Retry-After`. A rate-limited
response (HTTP 429, or WeCom error 45008 or 45009, which carry no
`Retry-After`) pauses the robot until its one-minute window has reset, or
longer when `Retry-After` asks, and does not count toward those five; a post
still rate limited after 60 attempts fails. Final failures remain visible in
the workflow's Delivery log, and in the Group's for a Group default, and
never block a gate. Remote error text and webhook URLs are never logged. The
log shows the posted text, robot label, status, attempts, and a safe error
code, and each recipient's name and count with how the post mentioned them
(`userid`, `mobile`, or `name` only). Userids and mobile numbers stay in the
post's mention lists and never appear in the log or in Remind's response.
Messages are limited to 2,048 UTF-8 bytes; very large recipient lists retain
all structured mentions and full Delivery recipients while summarizing
overflow display names.

An item's requester, its Workflow owner, and Administrators can **Remind**
people who still need to act, at most once per logical item per hour across
all recipients. The reminder and its recipients are audited. Without a robot,
the same action provides **Copy reminder**, including names and the deep link.
Remind returns its parts (workflow name, waiting event, names and counts, and
the item's base-relative link), and the dashboard writes the text in the
viewer's language with a link from its own origin and base path, so Copy
reminder needs neither setting. When a robot is set but everyone waiting has
turned off mentions for the event, a post would reach nobody: nothing is
posted, no reminder is recorded or audited, the hour does not start, and
Remind returns Copy reminder's parts instead. Remind resolves who may act
before it locks the workflow and then the Workflow version, so the hourly
limit serializes concurrent clicks without the capability checks holding
writers.
Channel writes, preferences, and reminders require a signed-in person; personal
access tokens cannot change channel settings or send reminders. Actions that
Agents perform through their existing scopes create the same inbox/outbox
events as dashboard actions.

| Route                                              | Behavior                                                                          |
| -------------------------------------------------- | --------------------------------------------------------------------------------- |
| `GET /me/notifications`                            | Read personal WeCom identity and mention-event choices                            |
| `PUT /me/notifications`                            | Save `{revision, wecomUserId, mobile, mentionEvents}`                             |
| `GET /workflows/:id/notifications/channel`         | Owner/Administrator reads masked settings and inherited default                   |
| `PUT /workflows/:id/notifications/channel`         | Save `{revision, label, language, webhookUrl?, confirmed: true}` and queue a test |
| `DELETE /workflows/:id/notifications/channel`      | Disconnect against `{revision, confirmed: true}`                                  |
| `GET/PUT/DELETE /groups/:id/notifications/channel` | Group lead/Administrator manages the Group default                                |
| `GET /workflows/:id/notifications/waiting`         | Current waiting items, recipients, reminder capability, and next eligible time    |
| `POST /workflows/:id/notifications/remind`         | Send `{itemId, confirmed: true}`; return a queued Delivery or Copy reminder parts |
| `GET /workflows/:id/notifications/deliveries`      | Owner/Administrator reads the newest 100 Deliveries                               |
| `GET /groups/:id/notifications/deliveries`         | Group lead/Administrator reads the Group default's newest 100, test posts too     |

All routes use the `/api/v1` prefix and the deployment's base path. Stale
revisions, a completed waiting item, and the hourly limit return `409`.
See [ADR 0026](../../docs/adr/0026-transactional-notification-delivery.md).
WeCom's [group robot documentation](https://developer.work.weixin.qq.com/document/path/91770)
specifies the text-message limit, mention fields, and 20-posts-per-minute rate
limit (checked 2026-10-30).

The service tests capture actual HTTP requests at a stub robot, including
mentions, grouped counts, opt-outs, shared pacing, retries, content exclusion,
and proxy connection attempts. A real-chat acceptance check additionally needs
an approved team robot: save it through the dashboard, check its test post,
then publish a test Round assigned to a member with a configured mention ID.
Confirm the mention arrives and its Delivery is sent. Keep real webhook URLs
outside the repository, test artifacts, screenshots, and logs.

## Sources gate and inbox

The Sources gate (#44) requires a passed source check. A signed-in Engineer
or Administrator previews the source set, reviews its records, hashes, and
effects, then commits the returned confirmation hash. Tokens may read gate
history and their person's inbox, but cannot preview or commit sign-off.

All paths below follow the configured base path and `/api/v1`. Let `V` be
`/workflows/:workflowId/versions/:versionId`.

| Method and path                     | Behavior                                                                                               |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `POST V/gates/sources/preview`      | Send `{}`; receive `{preview}` containing records, bound hashes, effects, and `confirmationHash`.      |
| `POST V/gates/sources/commit`       | Send `{confirmationHash, requestId}`; receive the recorded `{confirmation}`.                           |
| `GET V/gates/sources`               | Read the latest confirmation and its history, including invalidation and supersession.                 |
| `GET /me/inbox?limit=50&cursor=...` | Read the person's items, aggregate unread and pending counts, and an opaque `nextCursor`.              |
| `PATCH /me/inbox/:id`               | Send `{revision, state: "read"}` or `"unread"`; stale revisions return the current item as a conflict. |

The client request ID is 1 to 100 letters, digits, dots, underscores, or
hyphens, unique per person across gate commits. Repeating the same request
returns its original response, including after invalidation; reusing its ID
for a different hash or target returns `conflict`. Pin changes invalidate
confirmation atomically with the pin write and notify Engineers and the
Workflow owner. A replacement confirmation links the earlier record to its
successor. Activity records point to the confirmation and its bound hash.

Passed source checks create unread inbox items for Engineers. People may
mark their own items read or unread; confirming the gate sets its items to
done automatically. Invitations receive items before first sign-in, resolved
through their role binding. Inbox reads recheck current workflow visibility.
My work shows the items and deep links; the top bar shows the unread count.
The dashboard receives per-person events, polls every ten seconds as a
fallback, and refreshes on focus and navigation.

Errors use `invalid`, `denied`, `rejected` with stable finding codes and
required actions, `conflict`, or `unavailable`. A source check that has not
passed yields `SOURCE_CHECK_NOT_PASSED`; a stale confirmation hash yields a
conflict. These routes use migration `0009`; earlier shipped SQL is unchanged.

## Dossier versions

Dossier composition and approval (#50) use migration `0016`. The kernel
composes a Semantic dossier from the ledger and validates it. The Engineer
supplies only `topics`, `nodes`, and, for an upgrade, `upgradeSource` recovery;
workflow identity, pinned source identities, facts, deferred resolutions, and
provenance come from durable records. Readiness blockers refuse composition.
Kernel validation findings are returned by preview and must be repaired before
the version can be stored.

| Method and path                | Behavior                                                                                                                                                                                                |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET V/dossier`                | Read immutable versions, `headVersionId`, `currentVersionId` (the head while its records are unchanged), gate confirmation, and the caller-visible kernel handoff.                                      |
| `POST V/dossier/preview`       | Send `{topics, nodes, upgradeSource?}`; receive `{composition}` with the snapshot, canonical JSON, hash, and kernel findings.                                                                           |
| `POST V/dossier/compose`       | Send the same semantic fields plus `confirmationHash` quoting the composition hash. Content identical to the current version returns it with 200; otherwise 201 makes a new or earlier version current. |
| `POST V/gates/dossier/preview` | A signed-in Workflow owner or Administrator sends `{}` to review the exact dossier hash and stage effects.                                                                                              |
| `POST V/gates/dossier/commit`  | Send `{confirmationHash, requestId}` to approve that preview through the shared gate protocol.                                                                                                          |
| `GET V/gates/dossier`          | Read approval history, invalidation, and replacement confirmation links.                                                                                                                                |

Canonical JSON is stored as immutable text, and its SHA-256 is the version's
hash. The current version is named by the latest of an append-only sequence of
heads, so it need not be the newest: composing an earlier version's content
again selects that version again, recorded as `dossier.reselected`, without
copying or rewriting it. Each new head supersedes approval and later stages
exactly as a new version does, and requests approval in the Workflow owner's
inbox. Gates, plan derivation, the proposal, and invalidation read the head.
The kernel document's proposed `confirmed` flag is not service approval;
only an active matching gate confirmation approves a version. Record or pin
changes supersede that approval and invalidate later stages, notifying the
Engineer and Workflow owner in the writer's transaction. Artifacts and
confirmation retry responses remain unchanged. Personal access tokens may
read dossiers and gate history but cannot compose or approve versions.

Sources use Project-relative `location` plus `contentHash`; they never contain
server storage paths. The kernel resolves the location under the current
workspace root, so restoring storage elsewhere preserves approved proposals.
Changing Skill bytes still blocks them. Legacy dossier and plan history omits
old `canonicalPath` values and reports `requiresRecomposition: true` and
`canonicalJson: null`. Its original bytes, hashes, and approval history remain
stored, but those approvals cannot authorize further authoring. Compose and
approve the portable dossier again, then save and approve its plan and proposal.

## Skill and workflow version changes

Pinning a different Skill version compares the hashes of cited files. Changed,
removed, or unpinned evidence reopens affected questions, including deferrals,
and supersedes their facts. Source-study facts expose `stale` using the same
file comparison. Unrelated file changes preserve the records' confirmations.
Question, fact, and source-study responses include `evidenceChanges` with the
path, old and current version/file hashes, and change status. The dashboard
loads the before/after file previews when the comparison is expanded.
The same comparison decides which citations a new or revised question may
carry: a citation of an earlier Skill version remains valid while its file is
byte-identical in the pinned version, so unaffected questions can be revised,
and follow-ups can keep their parent's citations, after a re-pin. Resolution
and concern previews apply the commit's question checks, so a follow-up or
converted question that the commit would refuse fails before sign-off.

`POST /workflows/:id/versions` still quotes the workflow's current `revision`.
It now copies the latest version's pins, source-study revisions, questionnaire,
answers, facts, acknowledgements, resolutions, accepted question translations,
import provenance, and linked drafts in one locked transaction.
`inheritedFromVersionId` identifies the preceding version; each inherited
record's `origin`, including a translation's and an imported question's
`source`, identifies its source Workflow version, record, and revision. Copied
translations and imports still name the drafting job that produced them. The
kernel ledger carries that provenance into dossier snapshots. Copies retain
their state, including flags, while subsequent edits remain independent. Attachment receipts stay readable without changing fact hashes
or exposing private answer drafts. Original discussion and round baselines
remain in the source version, reachable through provenance links.

Pending questionnaire work moves with the copies, because a later version is
always copied from the latest one and work recorded in an earlier version never
reaches it. For each pending item about a copied question or fact, the new
version gets the item the questionnaire would create, for the same people:
`question-assigned` for assignees who still owed an answer, `restatement-ready`
for unacknowledged restatements, and `answer-submitted` or `question-reopened`
for the workflow's Engineers. The source version's items close, and the new
items route notifications like any other questionnaire action. Gate, concern,
and drafting-job items stay with their version, since those records are not
copied. The `workflow_version.inherited` audit event names the source version,
counts the copied pins and records and the moved items, and its `after.hash`
binds the copied source records and revisions.

The new version queues its own source check and requires new gates; no dossier,
plan, or approval is copied. `GET V/dossier`, `GET V/plan`, and
`GET V/proposal` include `confirmations`, and `GET V` includes
`sourceGateConfirmations`, newest first, so earlier approvals remain visible
as superseded after invalidation or replacement.
This uses migration `0023`, and migration `0020` lets a copied translation
name its original job; shipped migrations are unchanged. See
[ADR 0028](../../docs/adr/0028-workflow-version-inheritance.md).

## Plan versions

Plan versions (#58) use migration `0019`. `GET V/plan` returns immutable
`versions`, `headVersionId`, `currentVersionId` (the head while it is bound to
the current approved dossier), the current approved `dossierHash`, a derived
`skeleton`, and plan gate `confirmation`. As with dossiers, the latest
append-only head names the current version. The skeleton is unavailable until
the current dossier is approved. It fixes the name, goal, intent, English
artifact locale, ordered Node identities, and exact pinned sources and script
declarations; implementation choices remain for the Engineer or Agent.

`POST V/plan/preview` takes `{plan, dossierHash}` and returns `{composition}`
with canonical JSON, hash, snapshot, and kernel findings, including incomplete
or invalid edits. `POST V/plan/save` takes those fields plus
`confirmationHash` and `expectedVersionId`, the head version editing began
from (null for the first plan). A valid preview is required; concurrent saves
conflict. Content identical to the current version returns it with 200.
Content identical to an earlier version selects it again with 201, recorded as
`plan.reselected`, and supersedes approval as a new version does. Both writes
require a signed-in Engineer or Administrator and only `POST`; other methods
answer 405. Tokens may only read the plan and its history.

The Workflow owner previews and commits `V/gates/plan` using the shared gate
protocol. Its bound hashes identify both the Plan version and Dossier version.
A new head, of a new or an earlier version, supersedes plan approval. Dossier
replacement, facts, or pin changes invalidate dependent plan approvals
atomically, preserving history and retry responses, and notify the Engineer
and Workflow owner. Plan approval keeps the Plan and proposal stage active for
the separate proposal gate.

A signed-in Engineer requests `{kind: "draft-plan", confirmed: true}` at
`POST V/drafting-jobs`, without a round or parent question. Existing Engineer
MCP tools claim and submit `{plan}` against the kernel-derived output schema.
The context's `planning` contains `input`, `skeleton`, and the head version as
`basePlanVersionId`. The result stays a suggestion. Human acceptance uses
`plan` instead of `questions` in the existing accept-preview/accept protocol
and saves through the same validation and optimistic-concurrency checks as a
direct save. Inbox links for suggestions and approvals open the workflow's
`#plan` panel.

## Proposal approval and initialization

Proposal approval (#59) uses migration `0022`. `GET V/proposal` returns the
kernel's proposal for the approved current plan version, including its
blockers, warnings, source identities, and `proposalHash`, together with the
immutable `planVersionHash`, proposal `confirmation`, `currentState`, and
initialization `jobs`. Without a current approved plan, `proposal` is null.
The service uses managed artifact roots; a plan with an explicit
`artifactRoot` reports a blocker before approval or initialization.

The signed-in Workflow owner or Administrator previews and commits
`V/gates/proposal` through the shared gate protocol. The confirmation binds
the kernel proposal, Plan version, Dossier version, and pin-set hashes. Plan
approval notifies the owner that the proposal is ready. A changed plan or
superseded dossier invalidates proposal approval, cancels queued or claimed
initialization jobs, and notifies the Engineer and Workflow owner in the
same transaction. The kernel can also change the proposal hash on its own, as
after an upgrade; the owner's next commit then supersedes the stale approval
the same way before recording the new one. Gate retries retain their original
response.

A signed-in Engineer or Administrator sends
`{proposalHash, confirmed: true, requestId, replaceStateHash?}` to
`POST V/proposal/initialize`; other methods answer 405. It returns
`202 {job}`, and the kernel initializes the state in the worker, never in the
HTTP request. `replaceStateHash` must equal `currentState.hash` when replacing
state; a conflict returns `currentStateHash`. Request IDs identify jobs per
requester, so identical retries return the same job while changed inputs
conflict. Personal access tokens may read these resources but cannot approve
or initialize.

The existing workflow worker claims `init` jobs alongside source checks and
rechecks the approval, plan, sources, and quoted state hash under the version
lock. Like every proposal read, it materializes the stored plan as
`plans/<hash>.json` through a temporary file and a rename, and rewrites a file
that differs from the stored canonical JSON, such as one a crash truncated.
It calls the kernel in a private namespace, then commits the exact state
bytes and hash with the outcome, stage updates, and audit entry. An expired
claimant cannot publish a state after takeover. A successful job marks Plan
and proposal done and Package active and records `workflow.initialized`.
Failure leaves the previous state current. Each failed or cancelled job is
recorded once, as `workflow_initialization.failed` or
`workflow_initialization.cancelled`, by the worker or by the writer whose
invalidation withdrew it. Source checks refresh source trees without erasing
committed Creator state. See
[ADR 0027](../../docs/adr/0027-transactional-proposal-initialization.md).

## Source study records

Source study (#45) records facts and interfaces independently under a Workflow
version. Signed-in Engineers and Administrators add, edit, and retire them;
workflow readers, including Observers and tokens, read their history and
evidence. Every write keeps a revision and an Activity entry. The API uses
migration `0010` and never changes previously shipped migrations.

Using the `V` prefix above:

| Method and path                                           | Behavior                                                                                                                       |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `GET V/source-study`                                      | Facts, interfaces, and study completion for each current pin; also included as `sourceStudy` in the version response.          |
| `GET, POST V/source-study/facts`                          | List or create source-derived facts.                                                                                           |
| `GET, POST V/source-study/interfaces`                     | List or create independent interface records.                                                                                  |
| `GET, PATCH, DELETE V/source-study/facts/:id`             | Read a record with its revisions; replace its content or retire it, quoting `revision`. The interfaces path works identically. |
| `GET V/source-study/facts/:id/evidence/:index?revision=N` | Open the exact citation's numbered lines at the record revision; interfaces work identically.                                  |
| `POST V/gates/source-study/:skillId/preview`              | Send `{}` to review a current pin and its related record revisions.                                                            |
| `POST V/gates/source-study/:skillId/commit`               | Send `{confirmationHash, requestId}` to mark the reviewed version studied.                                                     |
| `GET V/gates/source-study/:skillId`                       | Read completion history, including invalidation and supersession.                                                              |

A fact takes `{statement, evidence}`. An interface takes `{producer, consumer,
artifact, columns, naming, validation, evidence}`; producer and consumer each
identify `{skillId, hash}`, and columns is an array of names, empty for a
non-tabular artifact. Every evidence item identifies `{skillId, hash, path,
startLine, endLine, fileHash}`. Hashes must match the pinned version and its
immutable file inventory. Lines are inclusive, numbered from 1, and limited
to 1,000 lines and 256 KiB per citation. Binary and invalid UTF-8 evidence is
refused. Historical revisions retain readable evidence after pin changes.

Edits replace the complete content and quote the record's current revision.
Retirement sends only `{revision}` and preserves all history. Stale writes
return `conflict` with the current `record`. Retired records cannot be edited.
Pin changes flag evidence as stale and invalidate study completions. Editing,
adding, or retiring a record invalidates completions of the Skills it
references and any later stage that had progressed.

Study completion reuses gate replay and conflict behavior. It requires
confirmed Sources and current evidence: rejected previews report
`SOURCE_SET_NOT_CONFIRMED`, `SKILL_VERSION_NOT_PINNED`, or
`SOURCE_STUDY_EVIDENCE_STALE`. A version's completion checks the records that
cite it; the last completion, which opens Questionnaire, checks every active
record, including one that cites only versions no longer pinned.
See [ADR 0019](../../docs/adr/0019-source-study-records-and-completion.md).

## Questionnaire rounds and free-text answers

Migration `0011` adds one questionnaire per workflow version. Let `Q` be
`V/questionnaire`, using the version prefix above. Every mutation runs under
workflow and version locks, checks current roles, and records its actor and
channel in Activity. Existing shipped migrations are unchanged.

| Method and path                    | Behavior                                                                                                                                                  |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /questionnaire`               | List visible workflow versions for the questionnaire selector.                                                                                            |
| `GET /questionnaire/questions/:id` | Resolve an authorized question deep link to its workflow version.                                                                                         |
| `GET Q`                            | Read rounds, questions and histories, submitted answers, the caller's private drafts, assignee choices, pinned sources, and capabilities.                 |
| `POST Q/rounds`                    | Create a draft round with `{title}`.                                                                                                                      |
| `POST Q/rounds/:id/questions`      | Draft a free-text question with `text`, `topic`, `targets`, `rationale`, `evidence`, `assignees`, and `priority` (0–100, higher first).                   |
| `PATCH Q/questions/:id`            | Quote `revision` and replace the question content, retaining the old revision.                                                                            |
| `GET Q/rounds/:id/publish-preview` | Review the ordered questions and the confirmation hash, which also binds each question's recipients.                                                      |
| `POST Q/rounds/:id/publish`        | A signed-in Engineer sends `{confirmed: true, confirmationHash}`. Publish and notify the whole round together. A retry of the published hash is harmless. |
| `PUT Q/settings`                   | Quote `revision` (0 initially) and `roundSizeLimit`: a positive integer, or `null` for no limit. Applies across this workflow's versions.                 |
| `PUT Q/questions/:id/answer`       | Autosave `{revision, questionRevision, text}`, with revision 0 for a first draft.                                                                         |
| `POST Q/questions/:id/submit`      | Submit the saved answer with `{revision, questionRevision}`.                                                                                              |
| `POST Q/rounds/:id/submit`         | Submit all outstanding assigned answers as `{answers: [{questionId, revision, questionRevision}, ...]}` atomically.                                       |
| `GET /me/events`                   | Receive `ready`, `change`, and heartbeat server-sent events for the signed-in person.                                                                     |

Topics use the kernel's dossier vocabulary plus `scope`. Targets name a
workflow, Node, Skill, or interface. An evidence link has `skillId`,
`versionHash`, a relative `path`, and positive `startLine`/`endLine`; the
file must exist in a pinned version. Assignees are
`{kind: "person", personId}` or `{kind: "role", role: "Field expert"}` /
`"Workflow owner"`. Role selectors include pending invitations and resolve
again when publishing. Rounds have no size limit by default. The questionnaire
does not wait for the stage track: rounds may be drafted and published while
Sources and Source study are still in progress.

Only Engineers and Administrators compose questions. Draft questions are
hidden from other roles. Every assignee keeps their own answer revisions in
any language, and a draft remains private until submitted. Submitted text
stays visible while a new draft is written. Each person's assigned inbox
item closes on submission; the question becomes answered once all current
recipients have submitted for its current revision. Revising a published
question reopens it, retains earlier answers, and notifies its assignees.
Answers refuse stale question or answer revisions and refuse a question
whose Engineer resolution has locked it, except that a confirmed answer may
be corrected and immediately requires re-confirmation.

An `engineer` token may claim and submit drafting jobs and create inference
and assumption drafts, and an `expert` token may save and submit its assigned
answers. Such answers require
`X-Badger-Agent-Host`, retain the `mcp` channel and host, and never trust a
client-supplied actor or channel. Tokens cannot publish rounds or revise
published questions. People and tokens still need the corresponding current
workflow role.

The event stream sends content-free invalidations of visible versions and
the person's inbox. It checks shared database revisions every second, so
worker and other server processes are observed. Current Badger visibility
is rechecked each time, identity every 15 seconds, and connections turn over
after 30 seconds. Every reconnect sends `ready` so clients reload current
records rather than rely on event replay. Slow consumers disconnect instead
of accumulating an unbounded buffer. Dashboard polling and focus refresh
remain available when streaming fails.

## Structured answers and attachments

Migration `0018` adds typed values and immutable attachment receipts to Answer
revisions. Each Question revision accepts an `answerType`; omitting it keeps
free text. The dashboard provides matching composer and answer controls.

| `answerType`                                             | Draft payload in addition to `revision` and `questionRevision` |
| -------------------------------------------------------- | -------------------------------------------------------------- |
| `{kind: "free-text"}`                                    | `text: "Any language"`                                         |
| `{kind: "single-choice", options: ["Cold", "Frozen"]}`   | `value: "Frozen"`                                              |
| `{kind: "multiple-choice", options: ["Cold", "Frozen"]}` | `value: ["Cold", "Frozen"]`                                    |
| `{kind: "yes-no"}`                                       | `value: false`                                                 |
| `{kind: "number", unit: "°C"}`                           | `value: 0` (always in the Question's unit)                     |
| `{kind: "table", columns: ["Sample", "Storage"]}`        | `value: [["Example", "Frozen"]]`                               |
| `{kind: "file"}`                                         | `attachments: ["attachment-id"]`                               |

Use the existing answer and submit routes. Incomplete structured drafts may
use `value: null`, empty choice lists, or incomplete table rows; submission
validates completeness for the current Question revision. Choices must be
distinct and declared by the Question. Table drafts have at most 100 rows,
20 columns, 4,000 characters per cell, and 50,000 serialized characters;
submission requires nonempty cells. Text is server-derived for structured
answers so older readers still have a rendering. Answer type changes keep
their question history and require a new draft against the revised schema.

Any answer type may add `attachments: [id, ...]`. Upload with
`POST Q/questions/:id/attachments` using
`{questionRevision, name, mediaType, contentBase64}`. An assigned expert or
owner, including an `expert` token acting for that person, receives an immutable
`{attachment: {id, name, mediaType, size, hash}}`. Files are limited to 5 MiB
each, eight files and 20 MiB per answer. PDF, PNG, JPEG, UTF-8 plain text, CSV,
and JSON are allowed; the server checks content and rejects paths, malformed
base64, unsupported types, and files belonging to another answerer or Question.
The questionnaire response includes these limits for upload controls.

Each person may leave at most eight unreferenced uploads totaling 20 MiB on
one Question; an additional upload returns 413 and names both limits. Saving
an upload in any Answer revision, including a private draft, makes it referenced.
The worker expires uploads that no revision has ever referenced after
`BADGER_ANSWER_ATTACHMENT_RETENTION_SECONDS` (default 86400, one day; range
60–31536000 seconds). Server and worker should use the same setting. Each
removal records `answer.attachment-expired` in the Activity log. References in
old revisions and inherited versions are kept forever. Unreferenced content
is removed too, unless another attachment or an immutable Skill inventory
uses the same hash. A durable cleanup queue retries content removal after a
worker interruption; blob writers and cleanup share a transaction lock.
Migration `0032` permits deletion only of never-referenced uploads; updates,
deletion of referenced receipts, and truncation remain forbidden.

`GET Q/attachments/:id` downloads the file through current workflow
authorization. Until submission only its uploader can download it; workflow
readers can download attachments cited by any submitted revision. The route
always serves a download with `nosniff` and never exposes blob addresses as
download URLs. Uploaded bytes are stored through the existing blob-store port,
and the upload's `answer.attachment-uploaded` audit event records their hash.
Upload screens require examples and warn against uploading real data.

Resolution previews bind structured values, units, and attachment receipts.
Facts retain the immutable Answer revision links and the receipts belonging to
those answers, so later edits require re-confirmation while historical evidence
remains readable. See [ADR 0024](../../docs/adr/0024-structured-answer-provenance.md).

New drafting jobs advertise the optional `answerType` in their output schema.
Text-only results keep their original shape when the field is omitted. The
Engineer can edit a structured suggestion and review its choices, unit, or
columns before acceptance. Follow-up context includes submitted structured
values and attachment receipts; private drafts and file bytes stay outside it.

## Ledger and readiness

Migration `0015` adds immutable inference/assumption revisions and round
publication baselines. Using the questionnaire prefix `Q` above:

| Endpoint                                                | Behavior                                                                                                                                    |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET Q/ledger`                                          | Kernel handoff with all five ledger parts, record references, per-topic blockers, deferred resolutions, and available publication baselines |
| `GET Q/ledger?sinceRound=:id`                           | Also returns added, changed, and resolved ledger items since publication of that round                                                      |
| `GET Q/inferences` or `GET Q/assumptions`               | Draft records, including retired records                                                                                                    |
| `POST Q/inferences` or `POST Q/assumptions`             | Engineer creates a draft with `statement`, `topic`, and optional `questionId`                                                               |
| `GET Q/inferences/:id` or `GET Q/assumptions/:id`       | Current record and immutable revisions                                                                                                      |
| `PATCH Q/inferences/:id` or `PATCH Q/assumptions/:id`   | Replace draft content, quoting its current `revision`                                                                                       |
| `DELETE Q/inferences/:id` or `DELETE Q/assumptions/:id` | Retire a draft, quoting only its current `revision`                                                                                         |

All reads require the Workflow version's read permissions. Draft questions
remain visible only to composing Engineers and Administrators, including in
round comparisons and in the question links of inference and assumption
drafts. A draft question still blocks readiness for every reader;
readers without composing
rights receive a blocker with a null record reference and no private details.
Submitted answer revisions appear in question provenance and round changes;
unsent answer drafts never enter the ledger or its publication baselines.
A round from another Workflow version returns 404. A draft
round or a historical round with no publication baseline returns 409 rather
than inventing history. Publication and automatic follow-up rounds capture
their baseline atomically; retries keep the original.

A ledger read and a round's publication each run in a questionnaire router
transaction that first locks the workflow row, then the Workflow version row,
and holds both until it commits; every transaction that takes both locks,
Remind included, takes them in that order. Questionnaire writes, gate
confirmations, Source study changes, Skill pin changes, and drafting
acceptance all take the version lock, so a ledger response and a published
round's baseline each see one consistent state even though their records
require several SQL queries. The workflow lock also runs the router's locked
requests (every write, and reads of `Q`, its ledger, and its drafts) one at a
time across every version of the workflow. Both locks are
`FOR NO KEY UPDATE`, which other writers' foreign-key checks do not wait for.
Postgres keeps its normal READ COMMITTED isolation, so a competing request
waits for the locks. Should Postgres still end a request's transaction as a
deadlock victim or with a serialization failure, nothing it wrote is kept and
the request answers 503 `unavailable` with `Retry-After: 1`.

The service delegates ledger membership and readiness to the kernel's
record-based questionnaire handoff. Confirmed user facts must be active and
acknowledged by every person whose answer they restate. Blockers identify
unresolved questions, unconfirmed inferences, unresolved assumptions, pending
acknowledgements, disputes, stale source evidence, and pinned versions not yet
studied. Deferred questions retain their resolution and reason and do not block.

Agents may create and revise inference and assumption drafts with an
`engineer` token, but cannot provide a confirmation flag. Retiring a draft
removes a readiness blocker, so it needs a signed-in Engineer or
Administrator. Only a linked, same-topic question's acknowledged facts resolve
a draft. The link follows the question's revisions; the draft records the
revision it was linked at. The resolution preview lists every linked draft and
binds its revision, so the person who signs off sees exactly the drafts it
will confirm, and a draft edited after the preview needs a new one. A resolved
question accepts no new link or changed meaning, so new meaning cannot borrow
an earlier sign-off. A stale draft write returns 409 with `currentRevision`.
See ADR 0022 for the boundary between questionnaire readiness and dossier
validation and approval.

## Answer resolutions and acknowledgements

Migration `0012` adds immutable resolutions, formal facts, answer-revision
links, and expert acknowledgements. `GET Q` includes their full history.
Every sign-off requires a dashboard session, current workflow access, a
preview, then `{confirmed: true, confirmationHash, requestId}` alongside the
previewed input. Retries with the same person, request ID, hash and input
return the original response; changed inputs conflict. Tokens never preview
or commit sign-offs, even when their person holds the required role.

| Method and path                            | Behavior                                                                                                            |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| `POST Q/questions/:id/resolution-preview`  | An Engineer reviews a resolution for the current question `revision`.                                               |
| `POST Q/questions/:id/resolve`             | Commit that exact reviewed resolution.                                                                              |
| `POST Q/facts/:id/acknowledgement-preview` | The person whose answer the fact restates reviews `{decision: "acknowledged"}` or `{decision: "disputed", reason}`. |
| `POST Q/facts/:id/acknowledge`             | Commit that response. Each answering person responds to each fact separately.                                       |
| `GET /skills/:id/backlog`                  | Read current Skill-internal deferrals, filtered by both Skill-library and workflow read permissions.                |

A resolution has one of four `kind` values:

- `confirmed`: `facts: [{text, answers: [{personId, revision}]}]`. Every fact
  binds current submitted answer revisions and snapshots the version's
  locale, question evidence and cited file hashes. The Engineer writes the
  text in that locale; the service does not translate it. Every answering
  person must be covered by at least one fact. Private drafts cannot be
  confirmed, nor can older submitted revisions replace current answers.
- `followed-up`: `followUp` holds ordinary question content. The commit
  creates and publishes a new child round atomically, preserves the parent
  link and notifies its assignees.
- `deferred`: `deferredKind` is `skill-internal` (with a pinned `skillId`) or
  `out-of-scope`. Both require `reason`; Skill-internal questions appear in
  that Skill's backlog.
- `withdrawn`: records the actor and an optional reason.

An acknowledgement is reserved for the answering person, including when an
Administrator wants to act for them. A dispute requires a reason, makes all
facts in that resolution inactive, reopens the question, and notifies the
Engineers. New facts need fresh acknowledgements. History is retained.

Editing a confirmed answer, including its first new private draft, marks the
question `needs-reconfirmation`; submitting that draft keeps the flag until
an Engineer confirms again. Revising a confirmed question does the same.
Replacing or removing a Skill pin flags each published question, not only a
confirmed one, when a file it or its active facts cite changed or disappeared.
An unrelated file change preserves the facts. Re-confirmation requires
questions to cite currently pinned evidence and answers submitted for their
current question revision. Old facts and acknowledgements remain visible as
inactive history.

## Question threads and expert concerns

Migration `0013` adds comments with immutable edit revisions, immutable concerns,
and their recorded outcomes. `GET Q` includes `comments`, `concerns`, and the
server-owned `comment`, `raiseConcern`, and `resolveConcern` capabilities.

| Method and path                       | Behavior                                                                                      |
| ------------------------------------- | --------------------------------------------------------------------------------------------- |
| `POST Q/questions/:id/comments`       | Add `{text}` to the end of a question's thread.                                               |
| `PATCH Q/comments/:id`                | The author sends `{text, revision}`; every edit is retained and a stale revision returns 409. |
| `POST Q/concerns`                     | A Field expert raises `{text}`, including before any round exists.                            |
| `GET /questionnaire/concerns/:id`     | Resolve an authorized concern deep link to its workflow version.                              |
| `POST Q/concerns/:id/resolve-preview` | A signed-in Engineer reviews a decision and receives its confirmation hash.                   |
| `POST Q/concerns/:id/resolve`         | Confirm the same decision with `{confirmed: true, confirmationHash, ...decision}`.            |

A decision includes the current concern `revision` and one of:

- `{outcome: "question", roundId, question}`: create a question using the
  question content schema above, in a draft round in this workflow version.
  The concern keeps its link to the new question. Publishing still uses the
  round's separate preview and confirmation.
- `{outcome: "fact-source"}`: retain the concern as an accepted source for a
  future Fact. This does not confirm a Fact or compose a dossier.
- `{outcome: "declined", reason}`: record a nonempty reason.

The confirmation binds the concern, the whole decision, and the draft round's
revision when creating a question. A changed decision or round returns 409
without creating an outcome or question. Each concern has one immutable
outcome, with the Engineer's identity, timestamp, and decline reason in
Activity. The source text is never replaced by the resolution.

Every workflow role except Observer can comment; only the author can edit
their comment, and the current role must still allow it. Administrator
overrides apply. Read access alone (for example, an Auditor or Group member)
does not grant comment or concern writes. Additive roles still apply. Draft
question threads are visible only to Engineers and Administrators. Concern
and comment IDs are checked against the requested workflow version.

`expert` and `engineer` tokens may comment within their person's current
workflow roles; `operator` tokens, which only run workflows, may not. Only an
`expert` token may raise a concern, and it still requires a
Field expert role (or Administrator override). Tokens never preview or commit
concern resolutions. Every write records the credential and channel in
Activity; client-supplied actor or channel fields are refused.

Raising a concern creates a `concern-raised` inbox item for every Engineer,
including pending invitations, with a direct link to the concern. Each concern
counts separately as pending work. Its items close when it is resolved.
Comments and concerns advance the existing questionnaire revision, so the
per-person event stream and polling refresh open records and inboxes.

## Personal access tokens

People create and revoke their Agents' and CLI credentials at
`/settings/tokens`. All token API paths below follow the configured base path
and `/api/v1`. Management requires a signed-in person, including in local
single-user mode; another person cannot read or revoke their tokens.

| Method and path         | Behavior                                                                                                                     |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `POST /me/tokens`       | Create `{name, scopes, expiresAt?}` and return `{token, secret}` once.                                                       |
| `GET /me/tokens`        | List the person's token metadata, including prefix, scopes, expiration, revocation, last-use time and channel, and revision. |
| `DELETE /me/tokens/:id` | Revoke with `{revision}`; a stale revision returns 409 with the current token.                                               |

For example, `{"name":"My Agent","scopes":["engineer"]}` creates a token
expiring in 90 days. An optional `expiresAt` must be a future timestamp.
Choose one or more distinct scopes: `engineer`, `expert`, or `operator`.
The secret combines a visible `bdg_` prefix with 256 random secret bits.
Only its SHA-256 hash is stored, and no list, audit event, or later response
contains the secret. Losing it requires creating another token and revoking
the old one. Creation and revocation are audited.

Send the secret as `Authorization: Bearer TOKEN_SECRET`. Bearer authentication
works beside the configured people-facing identity adapter, including when
that provider is unavailable. An invalid, expired, or revoked token returns
401, even when the request also carries a valid session. Cookie writes still
require an allowed `Origin`; bearer writes can omit it. A supplied foreign
`Origin` or `Host` is always refused.

Every request made with a token, reads included, also requires
`X-Badger-Agent-Host`: a nonblank label of 1 to 200 printable ASCII
characters, as the Badger MCP sends on every request. Reads need it because
some record audit events: an Engineer's questionnaire or drafting-job read
returns an expired lease to the queue, or cancels a job whose inputs changed.
Audit events of token requests record the person's identity, token ID, Agent
host, and `mcp` channel; the Activity page shows the host beside that
channel. This applies to `token.used`, comments, concerns, Skill version
uploads, questionnaire drafts, drafting-job transitions, and every other
permitted token request. A missing or invalid host returns 400 before the
request is served; only its `token.used` event is recorded, with an empty
host. Session, local, and worker credentials always have an empty audit host,
even if the request supplies the header.

Scopes only narrow the owner's current Badger permissions; they never grant
a role. Role removal applies to the next request. The currently delivered
API permits these token operations:

| Scopes     | API operations, subject to the person's roles                                                            |
| ---------- | -------------------------------------------------------------------------------------------------------- |
| All three  | Read `/me`, `/groups`, the workflow catalog and versions, and Skill entries, versions, files, and diffs. |
| `engineer` | Start workflow versions as an Engineer; create Skill entries, preview, and upload as an Engineer.        |
| `expert`   | Create Skill entries, preview, and upload as a Field expert.                                             |
| `operator` | Read the available workflow and Skill APIs; Run operations arrive with the Run service.                  |

Administrators can perform a profile's permitted operations within its
scopes. Tokens never manage tokens, groups, role bindings, or personal
preferences. Confirming facts, acknowledging or disputing restatements,
approving dossiers, plans, proposals or packages, publishing, and answering
Run gates always require a person. Token routes are explicitly allowed;
new API operations must declare their scope before tokens can call them.

Each valid token use records `token.used`, with actor, token ID, time,
request ID, and the `mcp` channel used for both MCP and CLI requests. Token
settings also show the last-use time and channel. This includes uses refused
by authorization or rate limiting. Every token has its own limit of 60
requests in a 60-second window beginning at its first request. The database
serializes and persists the counter, so concurrent requests and service
restarts share the limit. Excess requests return 429 with `Retry-After` in
seconds; sessions and other tokens retain their own access.

## MCP access

The local stdio MCP in [`packages/mcp`](../mcp/README.md) calls this API with
a personal access token. `GET /api/v1/me/mcp` reports current expert and engineer tool
capabilities using the same questionnaire and Skill permission decisions as
the dashboard. `GET /api/v1/me/questions` returns current assigned questions,
own answers, and comments, optionally filtered by both `workflowId` and
`versionId`. It gathers assignments within the service so many visible versions
do not consume a token request per version. Reads and writes still check the
token's validity, scopes, and current roles. Sign-offs remain session-only.

## Drafting jobs

Under `/api/v1/workflows/:workflowId/versions/:versionId/drafting-jobs`, the
workflow's Engineer or an Administrator can request and review
drafting. An `engineer` token may read, claim, submit, and release jobs within
its person's current workflow roles. Every job action records its person,
credential, channel, Agent host, request ID, revision, and hashes in the
append-only Activity log. Reads that discover expiry or changed inputs
commit the transition even when the attempted write returns a conflict.

| Method and suffix               | Behavior                                                                                                                   |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `GET /`                         | List jobs, reconciling leases and input hashes.                                                                            |
| `POST /`                        | A signed-in person requests a kind with its target fields (below) and `confirmed: true`.                                   |
| `GET /:id`                      | Read one job within this workflow version.                                                                                 |
| `POST /:id/claim`               | Claim a queued job with `{revision}`; return its context, schema, lease, and the pinned Skill files its kind reads.        |
| `POST /:id/submit`              | Submit `{leaseId, contextHash, result}` against the stored schema.                                                         |
| `POST /:id/release`             | Release `{leaseId, contextHash}` from the claiming person, token, and Agent host.                                          |
| `POST /:id/accept-preview`      | Preview `{revision, ...result}` after the person edits or removes suggestions, using the result fields for that kind.      |
| `POST /:id/reject-preview`      | Preview `{revision, reason}`.                                                                                              |
| `POST /:id/accept` or `/reject` | Repeat the preview's decision with `confirmed: true`, `confirmationHash`, and a client `requestId`, as a signed-in person. |

Claim leases last 30 minutes. Job reads and an Engineer's questionnaire view
reconcile jobs: an expired lease returns its job to the queue, and a queued,
claimed, or submitted job is cancelled exactly when its inputs change. A job's
inputs are the part of the context its kind's result depends on (below); the
job stores their hash when it is requested. Other changes leave it pending: a
comment never cancels a job, and an answer cancels only the jobs that read its
question. The context bundle binds the workflow/version frame, pinned Skill
versions and file inventories, source study, questionnaire records, submitted
answers, assignees, and the kernel's ledger and readiness; `contextHash` guards
the bundle the Agent receives. Private answer drafts never enter the context.
The output schema is stored with the job; results contain at most 1 MiB.

A claim's `skills` names the pinned Skill versions its kind reads and `files`
carries their exact bytes: the job's Skill for source study and imports, every
pin for question, follow-up, and plan drafting, and none for restatement and
translation. A claim's files total at most twice `BADGER_UPLOAD_MAX_BYTES`, so
any two Skill versions within the upload limit fit; a larger claim is refused
with 413 and its job stays queued.

| Kind                    | Request target fields         | Result                                                                                                             | Inputs                                                                                                        |
| ----------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| `draft-questions`       | `roundId`                     | `{questions: [QuestionContent]}` (1–20).                                                                           | Every pin, the round's state, and each question's revision and state.                                         |
| `draft-follow-ups`      | `roundId`, `parentQuestionId` | The same question schema, retaining the published parent.                                                          | Every pin, the round's state, the parent's revision, state, and resolution, and its latest submitted answers. |
| `source-study`          | `skillId`                     | `{facts: [SourceFact], interfaces: [SkillInterface]}`; up to 100 of each, at least one record. No round is needed. | The Skill's pinned version and the revisions of the source-study records that cite it or name it an endpoint. |
| `restate-answer`        | `questionId`                  | `{facts: [{text, answers: [{personId, revision}]}]}` (1–100).                                                      | The question's revision, state, and resolution, and its latest submitted answer from each person.             |
| `translate-question`    | `questionId`, `locale`        | `{text, rationale}` in the requested BCP 47 locale.                                                                | The question's revision.                                                                                      |
| `import-open-questions` | `skillId`, `roundId`          | `{questions: [{number, source: SourceEvidence, question: QuestionContent}]}` (1–20).                               | The Skill's pinned version, the round's state, and the questions already imported from that version.          |
| `draft-plan`            | None                          | `{plan}` (see [Plan versions](#plan-versions)).                                                                    | The approved planning input and the plan version it builds on.                                                |

Targets must belong to this Workflow version. A Skill target names its current
pin; a restatement targets an answered question or one needing re-confirmation.
Other kinds' target fields are refused. `SourceEvidence` uses the Source study
shape: `{skillId, hash, path, startLine, endLine, fileHash}`. Source-study
acceptance reuses the study authority's pinned-version, file-hash, UTF-8, and
line-range validation, creates all records in one transaction, and leaves
marking a Skill studied as a separate confirmation.

Restatement acceptance uses the existing resolution authority: facts link to
the current submitted answer revisions, take the Workflow version's locale,
and still require the answering experts' acknowledgements. A draft answer in
progress blocks confirmation. Acceptance previews bind that resolution's exact
inputs as well as the job result.

Accepted translations are immutable records with the original question revision,
target locale, actor, and job. They never replace the question's canonical text;
`questions[].translations` retains earlier translations after edits. Imported
questions remain unpublished drafts. Their immutable `questions[].source`
preserves the Skill version, file hash, cited range, original number, and initial
question revision. The source citation is also included in question evidence.
Import acceptance resolves that citation against the selected pin. A numbered
question from one file of a Skill version enters a workflow version once: an
acceptance preview that would import it again returns 409 with the existing
`questionId`, and the schema refuses the duplicate too. Both kinds appear in
question history, and every accepted record is audited.

Only submitted jobs appear in the Engineer questionnaire's `suggestions`.
Other roles receive no job output. Submission notifies the requester;
acceptance, rejection, and cancellation close that inbox item. Question acceptance
validates assignees and pinned evidence through the existing questionnaire
authority, then creates draft Questions atomically. Follow-ups keep their
parent link; accepting them never publishes a round or resolves the parent.
Each decision binds the submitted result, edits, job revision, and context
hash. A change to the job's inputs cancels it, and changed edits invalidate the
preview. An identical decision retried with the same person and client request ID returns its original response, including after later inputs change; changed replay inputs or a reused ID for another job conflict. Agents cannot request, accept, reject, or sign off on behalf of people.

## Skill versions from Git

The Skills page's **Import from Git** action registers a repository, previews
one full commit hash, collects script side-effect declarations, and confirms
an immutable version. The tree goes through the same kernel inspection as an
upload; identical content has the same hash and returns the same version.
Never import real data. Fetched content never executes.

Deployments must set `BADGER_GIT_ALLOWED_ORIGINS` to a comma-separated list of
exact HTTPS origins, for example `https://github.com,https://git.example.com`.
The default is empty, disabling registration and fetching. Explicit loopback
HTTP origins are allowed for local use. An origin enables registration; imports
still require a repository registered for the target Skill. URLs must not carry
credentials, and the `?` and `#` characters are refused anywhere, so not even
an empty query or fragment reaches the host. This version supports public or
otherwise unauthenticated repositories over Git smart HTTP. Private-repository
credential management and SSH are not provided. Git LFS is not supported: an
import is refused with 400 when the tree's `.gitattributes` assigns the LFS
filter or a file is an LFS pointer, since the pointers would import in place of
the files; upload the Skill folder instead. The runtime image includes Git and
CA certificates; a host running Node directly must install Git itself.

`BADGER_GIT_TIMEOUT_MS` defaults to 30000 (100–120000). The combined received
bytes and temporary bare repository are each capped by
`BADGER_GIT_MAX_REPOSITORY_BYTES`, default 104857600 (1 KiB–1 GiB). The existing
`BADGER_UPLOAD_MAX_FILES`, `BADGER_UPLOAD_MAX_FILE_BYTES`, and
`BADGER_UPLOAD_MAX_BYTES` also cap the committed files before ignore rules.
Git uses pack storage instead of unpacking loose objects, caps its delta-base
cache at the total upload byte limit, and caps each allocation at that limit
plus 16 MiB of overhead. An object that trips the allocation guard is refused
with 413 before the application inspects the expanded tree. Because each fetch
may download and store up to `BADGER_GIT_MAX_REPOSITORY_BYTES` for a request of
a few hundred bytes, each server process runs at most two Git fetches at once.
A preview or import beyond that is refused with 503 `unavailable` and a
`Retry-After` of the Git timeout in seconds, by which a running fetch has ended.
`BADGER_GIT_PROXY` sets an HTTP or HTTPS proxy URL (optional credentials;
no path beyond `/`, query, or fragment). Invalid values fail startup with a
configuration error that never includes the URL. `BADGER_GIT_NO_PROXY` is a
comma-separated list of hosts that bypass it; an empty value bypasses none.
These dedicated settings override the deployment's general HTTP/HTTPS proxy
and `NO_PROXY` settings for Git imports. Without a dedicated proxy, the general
settings still apply. The private Git loopback hop bypasses the proxy; its
smart-HTTP transport routes the registered host through it. Proxy credentials
never enter logs or responses. Redirects, dumb HTTP, links, and submodules are refused. No checkout,
Git hooks, filters, credential helpers, or imported scripts run.

All routes below follow the configured base path and `/api/v1`. They use the
same Group visibility and Engineer/Field expert upload permissions as uploads.
Registration and imports are audited; duplicate requests retain their records.

| Method and path                 | Behavior                                                                                                     |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `GET /skills/:id/repositories`  | List registered repositories visible with this Skill.                                                        |
| `POST /skills/:id/repositories` | Register `{url}` without fetching; return `{repository}` (201 or 200 for a duplicate).                       |
| `POST /skills/:id/git-preview`  | Inspect `{repositoryId, commit, scripts?}`; return `{preview}` with the kernel hash, inventory, and effects. |
| `POST /skills/:id/versions`     | Import `{repositoryId, commit, scripts?, confirmed: true, expectedHash}`; return `{version}` (201 or 200).   |

Commits must be full lowercase 40- or 64-character hashes. Branches, tags,
abbreviations, and unregistered or other-Skill repository IDs are refused.
A missing confirmation returns 400 before fetching; a mismatched source hash
returns 409. Resource limits return 413. A commit the host cannot supply, an
answer that is not Git smart HTTP, such as a redirect or a 404, and Git LFS
content return 400 `invalid`. A timeout, an unreachable host, a 5xx or 429
answer, a server without Git, and the concurrency limit return 503
`unavailable`, which a later retry may overcome. Every failure carries a safe
message and creates no version.

Version responses include their initial `origin` (`upload` or `git`) and a
`gitOrigins` list of `{repositoryId, repository, commit, ref}` receipts. Importing
an already uploaded tree appends its Git provenance without changing its
identity, files, declarations, original actor, or timestamp. Migration `0024`
adds these records without rewriting shipped migrations or existing versions.
The importer fetches advertised branches and tags with their history and
requires a ref that reaches the supplied commit. A commit with no reaching
branch or tag is refused with 400 and an explicit message. Lightweight and
annotated tags count, as do ancestors of branch tips. Existing resource limits
also bound history, so a large repository can exceed them even for a small tree.
The receipt's `ref` names the lexically first reaching `refs/heads/...` or
`refs/tags/...` observed at import time; later changes on the remote do not
rewrite it. Migration `0033` adds the column; receipts from before the check
keep `ref: null` rather than inventing historical reachability evidence.
See [ADR 0029](../../docs/adr/0029-registered-git-skill-versions.md).

## Skill uploads

The Skills dashboard accepts a Skill folder or zip, previews its inventory,
lets the person declare each script's side effects, and requires confirmation
before storing an immutable version. Never upload real data. Instructions,
scripts, configuration, and synthetic examples are appropriate sources.
Uploaded files never execute on the server. Folder and zip previews,
confirmed uploads, and Git imports refuse any path segment that names Git
metadata: `.git` in any letter case, including the spellings that HFS+ or
Windows resolve to `.git`, with the code points HFS+ ignores or with trailing
dots and spaces. Empty zip directories and metadata entries count. The
refusal names the normalized path, after the path length checks. Upload the
Skill without its `.git` folder, for example from `git archive` output. The
`.git` folder is refused rather than added to the kernel's identity ignore
list. The Badger MCP and the dashboard's folder upload apply the same rule
before they send anything. An answer attachment is a single named file, so
this rule does not apply to it.

The kernel checks `SKILL.md` frontmatter against the Skill entry's name and
produces the version hash, inventory, and script records. OS and editor noise
uses the kernel's fixed ignore list and does not create a new version. An
identical upload returns the existing version, including its original actor
and timestamp. Every script must be declared before a version is created;
`none` is a declaration. Files and declarations cannot be edited or deleted
through the API. Identical content with different declarations is a conflict;
change the source to record the corrected effects and upload a new version.

Files live in the configured blob directory, addressed by SHA-256. A blob is
written and synced to a temporary file, linked into its address, and its
directory is synced, so a committed version never names a blob a crash could
leave torn. A file already at an address is kept only if its bytes still hash
to that address; otherwise it is replaced atomically. The database records
each immutable tree as its ordered inventory of paths, sizes, and blob
hashes. A failed upload creates no version or upload audit event. A blob
written before a database failure may remain unreferenced; blob garbage
collection is not part of this change.

### Limits and paths

| Setting                        | Default  | Meaning                                                        |
| ------------------------------ | -------- | -------------------------------------------------------------- |
| `BADGER_UPLOAD_MAX_BYTES`      | 20971520 | Maximum combined file bytes, and maximum compressed zip bytes. |
| `BADGER_UPLOAD_MAX_FILE_BYTES` | 5242880  | Maximum bytes in one expanded file.                            |
| `BADGER_UPLOAD_MAX_FILES`      | 1000     | Maximum uploaded files, or zip entries including directories.  |

The JSON body may hold the base64 of `BADGER_UPLOAD_MAX_BYTES`, plus 2,176
bytes per allowed file for its path (named in `files` and again in
`scripts`), JSON keys, and padding, plus 4 KiB. A larger body is refused with
413 while it is read. Zip entry sizes are checked before expansion, actual
streamed bytes are capped, and each expanded file's checksum is checked.
Encrypted archives, links, special files, duplicates, and file/directory
collisions are refused. Limits apply before kernel ignore rules, including to
ignored files.

Zip entry names must be UTF-8. A non-ASCII name needs the UTF-8 flag
(general-purpose bit 11) or an Info-ZIP Unicode Path extra field; any other
name would have to be guessed from a legacy code page, so the upload is
refused with a request to re-create the zip with UTF-8 names or upload the
folder. Entries under `__MACOSX/`, which macOS Archive Utility adds, are
dropped without being expanded, before the enclosing folder is chosen. They
still count toward the entry limit.

Names are kept byte-exact, with no Unicode normalization, so a version's
hash is the kernel's identity of the original tree. Folders are separated by
forward slashes; backslashes are refused. Repeated separators and `.`
segments are removed. Absolute paths, `..`, control characters, lone
surrogates, drive prefixes, Windows reserved names, trailing dots/spaces,
segments over 255 bytes, and paths over 1024 bytes are refused. Two names
that would collide on a normalization- or case-insensitive file system,
compared after NFC normalization and case folding, are refused. A single
enclosing folder is removed if `SKILL.md` is not already at the upload root.
`SKILL.md` must use that exact case. Empty directories are not part of a
version.

### HTTP API

Every route is under the configured base path followed by `/api/v1`.
Cookie-authenticated writes require an allowed `Origin`. Read responses and
errors are JSON. Upload limit errors and oversized bodies return 413; empty
uploads, invalid paths, and missing or invalid declarations return 400;
changed confirmations or conflicting immutable metadata return 409. A method a
route does not serve returns 405 with an `Allow` header. Unauthorized reads do
not reveal the Skill's existence.

| Method and path                                 | Behavior                                                                                                      |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `GET /skills`                                   | Visible entries, per-group create/upload capabilities, and upload limits.                                     |
| `POST /skills`                                  | Create `{groupId, name}`; the name must match the uploaded `SKILL.md`.                                        |
| `GET /skills/:id`                               | Read one visible entry.                                                                                       |
| `POST /skills/:id/upload-preview`               | Inspect a folder or zip without recording a version or storing blobs.                                         |
| `POST /skills/:id/versions`                     | Confirm a previewed source by its hash and create a version (201), or return its identical predecessor (200). |
| `GET /skills/:id/versions`                      | List versions with their inventories and script effects.                                                      |
| `GET /skills/:id/versions/:hash`                | Read an immutable version.                                                                                    |
| `GET /skills/:id/versions/:hash/files?path=...` | Preview a UTF-8 text file up to 256 KiB; binary and larger files retain size/hash metadata.                   |
| `GET /skills/:id/diff?from=...&to=...`          | Compare any two versions of that entry, with added, removed, and modified files and changed script effects.   |

Folder content is encoded as base64:

```json
{
  "files": [
    { "path": "SKILL.md", "content": "BASE64_FILE_BYTES" },
    { "path": "scripts/run.sh", "content": "BASE64_FILE_BYTES" }
  ],
  "scripts": { "scripts/run.sh": ["local-writes", "network"] }
}
```

For a zip, replace `files` with `archive`, containing its base64 bytes. Paths
in `scripts` refer to the Skill root, after any enclosing folder is removed.
Supported effects are `none`, `local-writes`, `network`,
`scheduler-submission`, and `installs`. `none` stands alone. A preview reports
a script without a declaration as `undeclared`; `versions` refuses the upload
with 400 until every script is declared. Extra or nonexistent script paths
are refused.

Send the content to `upload-preview` first, then post the same content to
`versions` with `"confirmed": true` and `"expectedHash": "HASH_FROM_PREVIEW"`.
Both are required, and the hash must be the preview's 64 lowercase hex
digits. If the content no longer has that hash, the service answers 409 with
the computed `hash` beside the error; preview the content again before
confirming it.

### Upload permissions

Upload rights come from workflow roles, not library-specific roles. A
workflow role is a role binding with `scopeType: "workflow"`, made through
`POST /bindings` like any other binding (ADR 0012). An Engineer or Field
expert on a workflow creates Skill entries and uploads versions in that
workflow's exact Group. Every other workflow role reads that Group's library.
Group bindings keep their inherited reads, and Group leads create entries.
Administrators create entries and upload everywhere; Auditors only read.
Removing a binding withdraws the right at the person's next request.

## Workflow Skill pins and source checks

An Engineer or Administrator pins an immutable Skill version to a workflow
version with `POST /api/v1/workflows/:workflowId/versions/:versionId/pins`:

```json
{
  "skillId": "skill-id",
  "hash": "64-lowercase-hex-digits",
  "purpose": "source"
}
```

`purpose` is `source` by default; an upgrade workflow may also have one
`upgrade-source` pin, and its Sources stage stays blocked until it has one.
The Skill version must belong to the workflow's Group. Posting a different
hash for an already pinned Skill replaces the pin and must quote its
`revision`; `DELETE .../pins/:skillId` quotes it too. A stale revision, or a
missing one on a replacement, returns 409 with the current pin; a `DELETE`
without a valid revision returns 400. Every change invalidates the later
stages that had progressed, cancels a queued check of the previous pin set,
and queues a new source-check job. `GET` on the version, or on its
`pins`, `source-check`, and `jobs` paths, returns the pins, the latest check,
and the job history, with each job's requester, timing, status, and outcome.
Personal access tokens read these paths but cannot pin.

The worker claims jobs with row locks and a lease it renews while it works,
and runs one job at a time per workflow version. A lapsed lease lets another
worker take the job over; a late result from the first worker is ignored. The
worker materializes the pinned content under
`BADGER_STORAGE_DIR/workspaces/workflow-versions/<version-id>`, writes
`source-manifest.json` with project-relative locations, and calls the kernel
source check; each tree must match its pinned hash. The source-check record
exposes status, each source's purpose, identity, complete inventory, ignored
files, script effects, and blockers; no uploaded file is executed. A blocked
check blocks Sources; a passed one leaves it active until the Engineer confirms
the source set at the Sources gate (#44). A failed check leaves Sources active,
and its job records the error without storage paths.

A service deployment runs the worker role from the same image,
`node packages/server/dist/src/worker.js` (`npm run start:worker -w
packages/server`), with the server's settings, Postgres, and storage. It
wakes on a Postgres notification for each new job and also polls every 15
seconds, which reclaims a lapsed lease. The worker role needs Postgres: local
single-user mode runs it inside the server, polling PGlite every second.

## Validation

Service tests import `src/testing/index.ts` and use the real HTTP seam with
named people, fresh migrations, temporary storage, fixed time, and fixed IDs.
Set `BADGER_TEST_DATABASE_URL` to a Postgres 17 instance to run the same tests
against Postgres. See the repository README for the root delivery commands.

## Package scaffold generation

Package generation (#60, migration `0027`) follows initialization. Here `V` is
`/api/v1/workflows/:workflowId/versions/:versionId`.

- `GET V/package` reads the latest package, its current or invalidated status,
  scaffold hash, file inventory (path, bytes, SHA-256, kernel owner), Authoring
  plan, generation jobs, and `currentStateHash`. `canGenerate` means the current
  Creator state still binds the approved plan and proposal.
- A signed-in Engineer or Administrator previews and commits
  `V/gates/generation` through the shared human gate protocol. Its confirmation
  binds the proposal, Plan version, and Creator state hashes.
- `POST V/package/generate` quotes `{confirmed: true, confirmationHash,
stateHash, requestId}` and returns `202 {job}`. The confirmation belongs to
  the requesting person. A repeated request ID returns the same job; changed
  inputs conflict. Tokens may read packages but never confirm or generate.
- The worker rechecks all approved inputs and Creator state, invokes the
  kernel's confirmed generation in a job-private namespace, and commits its
  package inventory and exact new Creator bytes with the job outcome. Source
  Skills and MCP/script runtime instructions come from the kernel generator.
- `GET V/package/file?path=...` previews an inventoried file up to 1 MiB after
  checking its recorded SHA-256. Unlisted paths are refused. An invalidated
  package remains readable for inspection.

Upstream changes cancel unfinished generation and notify Engineers, Reviewers,
and Workflow owners about superseded packages. Regeneration starts a fresh
Authoring session and invalidates progressed evaluation and review stages.
See [ADR 0030](../../docs/adr/0030-transactional-package-generation.md).

### Authoring jobs and assembly

Authoring (#61, migration `0028`) extends the Package stage. `POST
V/package/authoring-jobs` with `{ "confirmed": true }` offers the kernel's ready
lanes as `authoring-lane` drafting jobs and its review lane as `review-vote`
jobs. They use the existing `/drafting-jobs` list, claim, submit, release, and
human preview/accept/reject endpoints. Claim context includes a hash-bound
`authoring` handoff and its bounded files. Results wrap the kernel's lane output
in `{ "laneOutput": ... }`; authored content is inline, limited to 256 KiB per
output, with no host file paths. Dependency and generation changes cancel stale
jobs; other lanes in the same Wave can continue independently.

`GET V/package/authoring` returns kernel readiness, accepted record revisions,
job history, and linked follow-up questions or repair jobs. NEEDS_CONTEXT creates
a draft question in an Authoring round; BLOCKED creates a repair job with the
current lane action. Only a signed-in Engineer or Administrator accepts results.
Every acceptance preserves the person, lane, and revision for independent review.

`POST V/package/assemble-preview` takes `{}` and returns a confirmation hash for
the current state and revision. `POST V/package/assemble` takes that hash,
`confirmed: true`, and a client `requestId`. It refuses missing/stale lanes,
changed confirmation hashes, and tokens. Replays retain their first response.
Successful assembly stores its package hash and inventory, finishes Package,
and activates Evaluation. See ADR 0031 for the filesystem transaction boundary.

## Evaluations

The Evaluations page selects a Workflow version, confirms an evaluation of its
current assembled package, shows worker progress, and retains every report.
Reports group package checks, Authoring cross-validation and runtime phases,
including negative cases. The person who started the job receives an inbox item
when it finishes. Earlier reports remain readable after a package is superseded;
publication readiness uses kernel evidence validation and a passing report for
the current package hash.

Workers require Linux and util-linux's `/usr/bin/prlimit`; the service image
includes it. Certification children have a 15-second wall-time bound, an
inherited 512 MiB OS data-allocation limit, a sampled 512 MiB aggregate resident
memory bound for their process tree, and a 4 MiB output bound. A shared 180-second
deadline bounds certification across the evaluation. A limit failure terminates
the child process group and retains a failing report. Child environments are
scrubbed and temporary directories are private. Domain scripts never run.
See [the evaluation decision](../../docs/adr/0032-isolated-immutable-evaluations.md)
for the transaction and resource boundaries.

`GET /api/v1/workflows/:workflowId/versions/:versionId/evaluations` exposes jobs,
progress, report history, and kernel publication readiness. A signed-in Engineer
starts a job with POST to that path and `{confirmed:true, packageHash, requestId}`.
The Engineer MCP's read-only `evaluation_status` tool exposes the same history
and readiness. Tokens cannot start jobs or sign off for people.

## Independent package review and publication

Let `V` be `/api/v1/workflows/:workflowId/versions/:versionId`.
`GET V/review` returns current-hash composite Authoring, runtime and publication
readiness from the kernel, approval history, all published Workflow versions, and
the signed-in person's controls. A Reviewer who accepted any Authoring lane for
this Workflow version, across every generation, cannot approve it. An
Administrator may override independence only with a recorded `overrideReason`.

`POST V/review/approve-preview` accepts `{}` or the Administrator's
`{overrideReason}`. Commit with `POST V/review/approve` quoting
`{confirmed:true, confirmationHash, requestId, overrideReason?}`. Only signed-in
Reviewers and Administrators may approve. The reason is bound by the preview and
stored with immutable review and Activity evidence. `POST V/review/publish-preview`
accepts `{}`. Only the signed-in Workflow owner or Administrator commits
`POST V/review/publish` with `{confirmed:true, confirmationHash, requestId}`.
The kernel requires the exact approved package hash, current Authoring readiness
and valid passing evaluation evidence. Changed previews conflict. Repeating an
original request returns its original confirmation, even after invalidation;
this does not make an invalidated approval current again. Tokens never sign off.

`GET /api/v1/workflows/:workflowId/publications` lists permanent publications
across versions. `GET /api/v1/workflows/:workflowId/publications/:publicationId/package`
returns `{publication, snapshot}`; `?packageHash=<expected-hash>` also fences the
selection. `snapshot` contains `packageHash`, `inventory` (path, bytes, SHA-256,
owner), and `files` (portable path and base64 content). Every retrieval verifies
the exact stored bytes and inventory with the public kernel
`verifyPackageSnapshot` seam. Signed-in workflow readers can inspect publications;
tokens need `operator` scope and an Operator, test Engineer or Administrator role
on the visible workflow. Other workflows and scopes are refused.

Publications store actual package bytes in append-only Postgres records, including
bundled source Skills. They remain usable after upstream changes, same-version
regeneration, or later publications. Installation and Run start should consume
this authorized retrieval API and kernel snapshot verification, rather than
following any current authoring path. Review/publication never changes the
committed Authoring namespace; their evidence, audit, stage and gate changes
commit atomically. See ADR 0033.

Run observation is available at `GET /api/v1/me/runs`,
`GET /api/v1/workflows/:workflowId/runs`, and `GET /api/v1/runs/:id`.
Run detail returns up to 500 original events after the optional non-negative
`afterSequence` cursor. `eventsTruncated` signals another page; use the last
returned event's sequence as the next cursor. Outcome summaries retain the
latest 256 entries and expose total/returned/omitted counts in `historySummary`.
The local MCP registers an accepted Run with `POST /api/v1/runs/:id` and mirrors
ordered events and kernel read models through `POST /api/v1/runs/:id/events`.
The new reviewed `0031_runs.sql` migration keeps event sequences immutable.
Registration fixes person, host label, Agent host, publication and package hash;
replays must match that identity. Operator scope and role are both required for
production Run writes; Engineers use engineer scope for test Runs. Signed-in
workflow readers can inspect the Runs dashboard. These are observer models;
WorkflowRuntime remains the runtime authority. See the MCP package README for tool schemas, retry guarantees,
bounds and certification details.

## Dashboard Run gates

Committed mirrored decisions, repair manual stops, and finalization confirmations
open durable gates. The published package owns reviewer policy: service policies
name stable Badger person IDs and workflow authorities `workflow-owner`,
`engineer`, `field-expert`, `reviewer`, and `operator`. All required authorities
must be held; a policy with none defaults to Operators. Named people must also
hold the required authority. Inboxes and team robots link directly to the Run.

`GET /api/v1/runs/:id/gates` returns the latest 100 gates with current
`canAnswer` capabilities. A signed-in person sends `{choiceId, inputs?, rationale?}`
to `POST /api/v1/runs/:id/gates/:gateId/preview`, then sends the same answer with
`confirmed:true`, `confirmationHash`, and a client `requestId` to its `/answer`
endpoint. Answers bind the exact Run revision and pending action. The service
attaches the person's attestation, records immutable evidence and audit, and
closes inbox items atomically. Retries return the original answer.

Tokens cannot preview or answer a gate. Only the registered person and Agent
host may retrieve `GET /api/v1/runs/:id/gate-answer`; the MCP compares the local
kernel binding and submits that answer to WorkflowRuntime on `next` or `status`.
Finalization previews show the kernel's exact planned operations; changed effects
require fresh confirmation. See ADR 0036 and migration `0034_run-gates.sql`.

## Run integrity and recovery

Run list and detail responses include `integrityFindings`, `needsRecovery`, and
the latest `recovery` outcome. The service compares decisions with immutable
dashboard gate answers and flags missing or changed attestations. Gaps and
execution identities that differ from the published protocol refuse the entire
report with 409 while preserving an audited finding. Execution verification
uses the kernel; its compiled package hash differs from the publication's
directory hash. One current finding per class bounds these responses, with
earlier evidence retained in the Activity log.

Registration can include `observedPackageHash` separately from its immutable
`packageHash` binding. The MCP rehashes installed bytes on later calls. Changed
or unreadable bytes (`observedPackageHash:null`) are flagged even when the Run
has never reached the service before.

Only the registered person and Agent host may send `POST /api/v1/runs/:id/recovery`
with `{required:true, requestId}` when the local runtime cannot export a committed
report. A stable notice ID makes retries idempotent; blocked recover calls can
include `recoveries` and their runtime `revision` without claiming a committed
snapshot.
A full `/events` report may include `recoveryRequired` and up to 64 bounded
`recoveries: [{requestId, noticeId}]` from local `recover` calls. A request binds
the interruption notice it answers; without a notice its `noticeId` is null.
Requests replay exactly once
in the recovery audit. A shorter valid prefix cannot clear a gap, and a regular
status report or an older recovery ID cannot settle a newer interruption notice.
Recovery returns `settled` when no discrepancy or runtime recovery finding remains,
or `blocked` otherwise. Missing human answers remain visible after recovery.
Auditors can inspect both the Run and its audited history. See ADR 0037 and
migration `0035_run-integrity.sql`.
