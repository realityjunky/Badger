# `@realityjunky/badger-server`

The collaborative service's HTTP server. It uses reviewed SQL migrations on
Postgres or PGlite, and the kernel supplies source inspection and identity.
Build from the repository root so the kernel is built before the server.

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
| `GET Q/rounds/:id/publish-preview` | Review the ordered questions, recipients, and confirmation hash.                                                                                          |
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

An `engineer` token may draft rounds and unpublished questions, and an
`expert` token may save and submit its assigned answers. Such answers require
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
Replacing or removing a Skill pin flags only confirmed questions whose cited
file hashes changed or disappeared. An unrelated file change preserves the
facts. Re-confirmation requires questions to cite currently pinned evidence
and answers submitted for their current question revision. Old facts and
acknowledgements remain visible as inactive history.

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

All three token profiles may comment within their person's current workflow
roles. Only an `expert` token may raise a concern, and it still requires a
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

## Expert MCP access

The local stdio MCP in [`packages/mcp`](../mcp/README.md) calls this API with
a personal access token. `GET /api/v1/me/mcp` reports current expert tool
capabilities using the same questionnaire and Skill permission decisions as
the dashboard. `GET /api/v1/me/questions` returns current assigned questions,
own answers, and comments, optionally filtered by both `workflowId` and
`versionId`. It gathers assignments within the service so many visible versions
do not consume a token request per version. Reads and writes still check the
token's validity, scopes, and current roles. Sign-offs remain session-only.

## Skill uploads

The Skills dashboard accepts a Skill folder or zip, previews its inventory,
lets the person declare each script's side effects, and requires confirmation
before storing an immutable version. Never upload real data. Instructions,
scripts, configuration, and synthetic examples are appropriate sources.
Uploaded files never execute on the server.

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
`revision`; `DELETE .../pins/:skillId` quotes it too. A stale or missing
revision returns 409 with the current pin. Every change invalidates the
later stages that had progressed, cancels a queued check of the previous pin
set, and queues a new source-check job. `GET` on the version, or on its
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
