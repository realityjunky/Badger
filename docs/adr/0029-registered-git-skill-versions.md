# Git Imports Use the Same Immutable Skill Identity as Uploads

Status: accepted. A Field expert or Engineer may register an HTTPS Git repository
for a Skill in a Group where they may upload. Registration never fetches content.
The deployment separately enables exact origins with `BADGER_GIT_ALLOWED_ORIGINS`;
a registration cannot widen that policy. HTTP is permitted only for explicitly
enabled loopback origins. URLs cannot include credentials, queries, or fragments.
The first implementation supports repositories readable without credentials over
Git smart HTTP, with a full SHA-1 or SHA-256 commit identity rather than a moving
branch, tag, or abbreviated hash.

Fetching goes through a private transport that forwards only smart-HTTP discovery
and upload-pack operations to the registered repository. Redirects and dumb-HTTP
alternates are refused. Git runs with isolated configuration, disabled hooks,
no credential helpers, a private bare repository, and a scrubbed environment.
There is no checkout, filter, archive transformation, submodule traversal, or
execution of fetched content. Reading the committed blobs preserves attributes
such as `export-ignore` and `export-subst` as ordinary content. Links, gitlinks,
invalid paths, and unsafe names are refused. Fetch duration and received bytes,
repository storage, file count, and expanded bytes are bounded. Because Git
inflates objects before the expanded-size check, Git's individual allocations
are limited to the total upload byte limit plus 16 MiB, its delta-base cache
is capped at the upload byte limit, and fetches retain pack storage. Temporary
repositories are removed after success and failure; remote diagnostics are never
returned or logged.

The files then enter the existing upload inspection and persistence path (ADR
0013): the kernel supplies identity and inventory, every script requires a
side-effect declaration, and creation quotes the preview's `expectedHash` with
explicit confirmation. Git metadata never enters the source hash. Identical
content and declarations return the same Skill version regardless of ingress.
Conflicting declarations remain a conflict.

Migration `0024` preserves existing immutable versions and their initial
`origin`. Append-only Git import receipts record each distinct repository and
commit for a version, including an existing version originally uploaded. The
API exposes them as `gitOrigins`. This retains provenance without updating a
version's files, declarations, original actor, or creation time. Retrying an
import creates neither another receipt nor another audit event. Repository
registrations and receipts cannot be rewritten or deleted.

## Considered Options

- Clone and check out source files. Rejected: checkout can apply filters and
  changes bytes according to host configuration; object reads preserve the tree.
- Fetch a caller-supplied URL at import time. Rejected: imports must name a
  repository already registered for that Skill and allowed by the deployment.
- Include repository and commit in the version hash. Rejected: the same Skill
  tree must have the same identity as a direct upload.
- Replace an existing upload's origin after importing it from Git. Rejected:
  immutable records preserve their original provenance; new receipts append it.
