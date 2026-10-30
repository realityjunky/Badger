# Keep independent review evidence and published bytes separate from current Authoring

Status: accepted. The service overlays a passing evaluation and immutable package
review onto a clone of the committed Creator state. The kernel owns review and
publication checks, with nonpersisting lifecycle calls for service transactions.
Changing the current Creator namespace to record sign-off would put filesystem
writes outside database rollback and invalidate unrelated Authoring work.

A Reviewer must have accepted no Authoring lane for the entire Workflow version,
including prior package generations. An Administrator can override that service
separation rule only with a reason bound into the preview, preserved with the
review and recorded in Activity. Personal tokens never approve or publish.
Existing gate confirmations retain optimistic concurrency, current invalidation,
and the original replay response; package review evidence is append-only.

The owner publishes through the kernel into a disposable destination, then stores
the actual assembled files, their inventory and canonical package hash together in
an append-only Postgres record. This trades larger database records for atomic
publication and backups without mutable filesystem pointers. Regeneration
invalidates current approval gates but never withdraws published packages. A
review retains its exact passing evaluation report when another evaluation of
the same bytes finishes. Missing or changed bound evidence fails kernel checks.

Authorized package retrieval verifies the stored bytes and inventory with public
kernel snapshot functions. Host installation and Run start consume that seam;
they do not read the current authoring files or duplicate the hash algorithm.
