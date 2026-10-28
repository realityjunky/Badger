# `@realityjunky/badger-server`

The collaborative service's HTTP server. It uses reviewed SQL migrations on
Postgres or PGlite, and the kernel supplies source inspection and identity.
Build from the repository root so the kernel is built before the server.

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
and timestamp. Files and declarations cannot be edited or deleted through
the API. Identical content with different declarations is a conflict; change
the source to record the corrected effects and upload a new version.

Files live in the configured blob directory, addressed by SHA-256. The
database records each immutable tree as its ordered inventory of paths,
sizes, and blob hashes. A failed upload creates no version or upload audit
event. A blob written before a database failure may remain unreferenced; blob
garbage collection is not part of this change.

### Limits and paths

| Setting                        | Default  | Meaning                                                        |
| ------------------------------ | -------- | -------------------------------------------------------------- |
| `BADGER_UPLOAD_MAX_BYTES`      | 20971520 | Maximum combined file bytes, and maximum compressed zip bytes. |
| `BADGER_UPLOAD_MAX_FILE_BYTES` | 5242880  | Maximum bytes in one expanded file.                            |
| `BADGER_UPLOAD_MAX_FILES`      | 1000     | Maximum uploaded files, or zip entries including directories.  |

The JSON envelope has an additional bounded allowance for base64 and paths.
Zip entry sizes are checked before expansion, actual streamed bytes are
capped, and each expanded file's checksum is checked. Encrypted archives,
links, special files, duplicates, and file/directory collisions are refused.
Limits apply before kernel ignore rules, including to ignored files.

Paths use NFC Unicode and forward slashes; repeated separators and `.`
segments are normalized. Absolute paths, `..`, control characters, drive
prefixes, Windows reserved names, trailing dots/spaces, paths over 1024 bytes,
and collisions ignoring case are refused. A single enclosing folder is
removed if `SKILL.md` is not already at the upload root. `SKILL.md` must use
that exact case. Empty directories are not part of a version.

### HTTP API

Every route is under the configured base path followed by `/api/v1`.
Cookie-authenticated writes require an allowed `Origin`. Read responses and
errors are JSON. Upload limit errors return 413; invalid paths and declarations
return 400; changed confirmations or conflicting immutable metadata return 409. Unauthorized reads do not reveal the Skill's existence.

| Method and path                                 | Behavior                                                                                                    |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `GET /skills`                                   | Visible entries, per-group create/upload capabilities, and upload limits.                                   |
| `POST /skills`                                  | Create `{groupId, name}`; the name must match the uploaded `SKILL.md`.                                      |
| `GET /skills/:id`                               | Read one visible entry.                                                                                     |
| `POST /skills/:id/upload-preview`               | Inspect a folder or zip without recording a version or storing blobs.                                       |
| `POST /skills/:id/versions`                     | Confirm and create a version (201), or return its identical predecessor (200).                              |
| `GET /skills/:id/versions`                      | List versions with their inventories and script effects.                                                    |
| `GET /skills/:id/versions/:hash`                | Read an immutable version.                                                                                  |
| `GET /skills/:id/versions/:hash/files?path=...` | Preview a UTF-8 text file up to 256 KiB; binary and larger files retain size/hash metadata.                 |
| `GET /skills/:id/diff?from=...&to=...`          | Compare any two versions of that entry, with added, removed, and modified files and changed script effects. |

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
in `scripts` refer to the normalized Skill root. Supported effects are `none`,
`local-writes`, `network`, `scheduler-submission`, and `installs`. `none` stands
alone; omitted scripts remain `undeclared`. Extra or nonexistent script paths
are refused. Send the content to `upload-preview` first, then add
`"confirmed": true` and `"expectedHash": "HASH_FROM_PREVIEW"` when posting
to `versions`. The expected hash is checked when supplied; the dashboard
always supplies it.

### Upload permissions

Upload rights come from workflow roles, not library-specific roles. A
workflow role is a role binding with `scopeType: "workflow"`, made through
`POST /bindings` like any other binding (ADR 0012). An Engineer or Field
expert on a workflow creates Skill entries and uploads versions in that
workflow's exact Group. Every other workflow role reads that Group's library.
Group bindings keep their inherited reads, and Group leads create entries.
Administrators create entries and upload everywhere; Auditors only read.
Removing a binding withdraws the right at the person's next request.

## Validation

Service tests import `src/testing/index.ts` and use the real HTTP seam with
named people, fresh migrations, temporary storage, fixed time, and fixed IDs.
Set `BADGER_TEST_DATABASE_URL` to a Postgres 17 instance to run the same tests
against Postgres. See the repository README for the root delivery commands.
