# Bind Source Study to Immutable Evidence and Record Revisions

Status: accepted. Source study (#45) stores source-derived facts and interfaces
as independently identified, revisioned records within a Workflow version.
The records share persistence for revisions and retirement, and retain their
distinct kinds and content. An interface records its producer and consumer
Skill versions, artifact, columns, naming, validation, and evidence. Retiring
a record preserves its content and every earlier revision. Revision history
is append-only, and every accepted write is audited in the same transaction.

Evidence identifies a pinned Skill version, an inventory path, an inclusive
line range, and the file's SHA-256. The server validates these against the
immutable inventory and content-addressed blob; clients cannot invent file
hashes or cite paths outside that inventory. Cited lines must be UTF-8 text.
Each citation spans at most 1,000 lines and 256 KiB, including when the source
file itself exceeds the library's whole-file preview limit. A historical
record revision keeps its evidence readable after a pin changes or the record
is retired, under the Workflow version's read permissions.

Marking one pinned Skill version studied reuses the gate protocol from ADR 0016. A signed-in Engineer or Administrator previews the pin and its related
fact and interface revisions, then commits the confirmation hash with a client
request ID. Personal access tokens may read these records but may neither
write accepted study records nor sign off. Agent drafting jobs remain the
separate acceptance path described in ADR 0005.

The Sources gate must be confirmed first. An active record citing an unpinned
version blocks study completion until it is updated or retired. A completion
records the actor, time, pin hash, record hashes, and revision. The last pinned
version's completion opens Questionnaire. Changes to study records invalidate
the completions of the Skills they formerly or currently reference and reopen
Source study; later stages that had progressed become invalidated. A pin-set
change conservatively invalidates all study completions, alongside Sources.
All these writes and gate confirmations share the Workflow version lock, so a
preview cannot silently accept changed records. Retries recover the original
confirmation response even after invalidation.

## Considered Options

- Store interfaces inside facts. Rejected: interfaces have their own revision,
  retirement, evidence, and later questionnaire targets.
- Keep only the latest fact with audit metadata. Rejected: a reader must be
  able to recover the statement and citations of every revision.
- Reuse the library's whole-file preview for citations. Rejected: it cannot
  open cited lines in larger script files or bind the record revision.
