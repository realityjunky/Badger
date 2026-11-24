# Skill versions retain history while lifecycle actions stay explicit

Status: accepted. A Skill version has immutable content and append-only
derivation receipts. Its optional unique `major.minor.patch` label uses an
optimistic revision and does not change the content identity. A retained
version may be selected by hash, label, or date, downloaded as an inventory
ZIP, and used as an explicit edit base. Browser edits name individual changed
files, while local edits can send a complete folder or ZIP with the base hash.
The previewed hash remains the confirmation boundary.

An unused version can be deleted after the service rechecks references while
holding the version row lock. A referenced version can be retired. Retirement
removes it from new pin choices while preserving its files, links, and
review history. A retained version remains available as an edit base and
as the subject of a Questionnaire round. Content-addressed blobs are queued through
the existing cleanup worker and removed only after the database commit and a
second reference check under the blob-store lock.

Reference checks cover current and historical pins, source and questionnaire
evidence, working dossiers, reviewed script effects, questions and imports,
edit bases, successors, retained package inputs, and published dossier
identities. New integrations extend the reviewed reference predicate through
later migrations without changing existing lifecycle code.
