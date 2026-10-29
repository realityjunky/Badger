# Bind Structured Answers and Attachment Receipts to Answer Revisions

Status: accepted. Each Question revision owns its answer type, choices, unit,
or table columns. Each Answer revision keeps a typed value and immutable file
receipts beside a server-derived text rendering. Earlier text-only revisions
retain their content and mean free text. A revised question requires a new
answer against its current schema; old answers never adopt new choices or units.

Attachments belong to the answering person and Question, while their bytes
live in the shared content-addressed blob store. An upload stays private until
used by a submitted Answer revision. Download authorization follows the
current workflow roles and submitted history, including files later removed
from the current draft. A resolution preview binds the structured values and
file hashes, and each resulting Fact carries the receipts from the Answer
revisions it restates. Correcting either values or attachments invalidates
the earlier restatement through the existing re-confirmation flow.

Mutable file references were rejected because changing or deleting a file
would silently change already acknowledged evidence. Exposing blobs by hash
was rejected because shared content addresses convey no permission to read
another person's draft. File bytes never enter the ledger or confirmation
payload: immutable receipts bind the evidence while keeping those records small.
