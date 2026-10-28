# `@realityjunky/badger-server`

The collaborative service's HTTP server. It uses reviewed SQL migrations on
Postgres or PGlite, and the kernel supplies source inspection and identity.
Build from the repository root so the kernel is built before the server.

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
files, script effects, and blockers; no uploaded file is executed. A passed
check marks Sources done and a blocked one keeps it blocked. A failed check
leaves Sources active, and its job records the error without storage paths.

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
