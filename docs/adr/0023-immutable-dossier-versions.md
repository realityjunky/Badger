# Keep Dossier Artifacts Immutable and Approval in Gate History

Status: accepted. A Dossier version contains the kernel-composed Semantic
dossier and the ledger snapshot, including record identities, revisions, and
provenance. The kernel serializes the snapshot as canonical JSON and hashes
those exact bytes. The service stores that text once per Workflow version
and hash, with immutable metadata; it never reconstructs the artifact from
JSONB or edits it when approval changes.

The Engineer authors topic summaries and Node responsibilities. Workflow
identity, pinned sources, facts, and provenance are projected from durable
records. Record readiness must be complete, and kernel validation must pass
before composition. The candidate uses the kernel schema's `confirmed: true`
to describe the proposed document; this field grants no service authority.
Only the Workflow owner's signed-in, hash-bound gate confirmation approves
the artifact. Readers and later stages must consult gate history.

Record writers and gate commits share the Workflow version lock. A changed
ledger invalidates approval, later stages, and pending approval notices in
the same transaction as the write, with inbox items for the Engineer and
Workflow owner. A replacement composition also supersedes approval. The
original artifact and confirmation retry response remain intact, while gate
history records invalidation and the replacement confirmation. This extends
ADRs 0006, 0016, and 0022 without giving readiness or a payload flag the power
to approve a dossier.

Which version is current is append-only history too. Each composition that
changes it appends a head naming a stored version, and the latest head is
current, so the current version need not be the newest. Composing an earlier
version's content again appends a head that selects that version again, with
the same supersession, invalidation, and notices as a replacement; it is never
copied or refused. Gates, plan derivation, the proposal, and invalidation read
the head. Treating the highest version number as current was rejected: an
Engineer could not return to an earlier meaning without a cosmetic edit.
