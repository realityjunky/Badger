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

Source identity uses the source's `location`, as the FactoryPlan declares
it, and the Skill's `contentHash`; dossier sources contain no `canonicalPath`.
A Project-relative location must stay inside the Project, so a `..` segment is
refused, and both sides compare it in normalized form: `./skills/x` and
`skills/x` are one location. A plan may instead declare an absolute location
inside the Project or under a registered source root (ADR 0008), which the
dossier keeps exactly as declared. When matching inspected sources, the kernel
resolves the location under the current Project root to its real path, as
discovery does. The service declares every source as `skills/<name>`, so its
dossiers contain no storage paths. Moving or restoring storage, or reaching it
through a symbolic link, therefore preserves approval, while different source
bytes still block the proposal. Recording the inspected absolute path was
rejected because it exposes deployment details and binds meaning to a server's
directory layout. Requiring every location to be Project-relative was rejected
too: a plan that declares an absolute source could then carry no dossier.

Legacy artifacts containing `canonicalPath` remain immutable under their
original hashes. Their API history is a projection without those paths,
marked `requiresRecomposition: true`, with `canonicalJson: null` so the
projection cannot be mistaken for the bytes that were approved. Existing
confirmations remain historical evidence but cannot authorize further
authoring: the kernel reports that the dossier needs recomposition without
`canonicalPath` and a new human approval. Recomposition supersedes the old
approval through the existing gate history. Silently rewriting stored bytes
or transferring approval to a new hash was rejected.
