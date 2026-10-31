# Commit Package Generation with Its Creator State

Status: accepted. Package generation is a durable worker job bound to a signed-in
Engineer's generation confirmation. The preview binds the current Creator state,
approved Plan version, and kernel proposal. The worker rechecks those identities
and the proposal approval under the Workflow version lock immediately before
calling the kernel. Tokens can inspect packages but cannot confirm or generate.

Generation runs in a new Creator namespace under the same Project root. The
kernel records that namespace in Creator state and uses it for generation and
authoring persistence. The Project root stays fixed because the approved plan
and its Semantic dossier name their sources by locations that the kernel
resolves against that root ([ADR 0023](0023-immutable-dossier-versions.md)).
The worker initializes the
exact approved proposal in its private namespace, invokes confirmed generation,
and commits the generated package inventory, authoring plan, new Creator bytes,
job outcome, stage changes, and audit entry together. An aborted transaction
leaves disposable files; a retry rebuilds only its own namespace. The previous
package remains readable until the transaction commits.

Every generation keeps a package snapshot and its files' kernel-derived owners
and hashes. A regeneration begins a new authoring session, so it supersedes
later authoring, evaluation, and review work. Upstream changes withdraw active
generation confirmations and unfinished jobs, mark the old package invalid, and
notify the Engineer, Reviewer, and Workflow owner in the same transaction.
Previous package files remain available for inspection. Publication history,
when implemented, remains independent of the mutable stage track.
