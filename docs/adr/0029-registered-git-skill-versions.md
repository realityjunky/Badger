# Git Imports Use the Same Immutable Skill Identity as Uploads

Status: accepted. A Field expert or Engineer may register an HTTPS Git repository
for a Skill in a Group where they may upload. Registration never fetches content.
The deployment separately enables exact origins with `BADGER_GIT_ALLOWED_ORIGINS`;
a registration cannot widen that policy. HTTP is permitted only for explicitly
enabled loopback origins. URLs cannot include credentials or the `?` and `#`
characters, so no query or fragment, not even an empty one, reaches the host.
The first implementation supports repositories readable without credentials over
Git smart HTTP, with a full SHA-1 or SHA-256 commit identity rather than a moving
branch, tag, or abbreviated hash. Git LFS is not supported: an import is refused
when the tree's `.gitattributes` assigns the LFS filter or a file is an LFS
pointer, because the pointers would otherwise import in place of the files. The
person uploads the Skill folder instead.

Fetching goes through a private transport that forwards only smart-HTTP discovery
and upload-pack operations to the registered repository, joining each
operation's path to the repository's URL path. Redirects and dumb-HTTP
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
returned or logged. Since one small request can make the server download and
store a whole repository, each process runs at most two fetches at once and
refuses more rather than queueing them.

Failures are classified by whether retrying can help. A missing commit, an
answer that is not smart HTTP, and refused content are 400 `invalid`: the same
request fails again. A timeout, an unreachable host, a 5xx or 429 answer, a
server without Git, and the concurrency limit are 503 `unavailable`, and a later
retry may succeed.

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

A fetch imports only advertised branches and tags and their history, then
requires a branch or tag containing the supplied commit. Fetching a hash alone
was rejected: a host may serve an unpublished object from another repository
in the same fork network. The tree must identify a commit, and both lightweight
and annotated tags count. The same time, repository, and allocation limits
bound the additional history; a large history may exceed them even when one
tree is small. A receipt records the reaching `refs/heads/...` or
`refs/tags/...` ref observed during that fetch, chosen in lexical order for
determinism. This is evidence at import time, not a promise that the remote
will keep the ref. Migration `0033` adds `published_ref`; historical receipts
retain NULL because no reachability check was made at their import.

`BADGER_GIT_PROXY` selects an HTTP or HTTPS proxy for the isolated smart-HTTP
transport and Git's `http.proxy` configuration. `BADGER_GIT_NO_PROXY` selects
hosts that bypass it. Git reaches its private loopback transport directly;
that transport applies the proxy to the registered repository while preserving
the same restrictions on operations, redirects, and received bytes. Proxy
credentials never enter diagnostics or logs. Without a dedicated proxy,
the existing deployment HTTP/HTTPS proxy settings remain in effect.

## Considered Options

- Clone and check out source files. Rejected: checkout can apply filters and
  changes bytes according to host configuration; object reads preserve the tree.
- Fetch a caller-supplied URL at import time. Rejected: imports must name a
  repository already registered for that Skill and allowed by the deployment.
- Include repository and commit in the version hash. Rejected: the same Skill
  tree must have the same identity as a direct upload.
- Replace an existing upload's origin after importing it from Git. Rejected:
  immutable records preserve their original provenance; new receipts append it.
