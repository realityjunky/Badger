# Derive Questionnaire Readiness in the Kernel and Snapshot Published Rounds

Status: accepted. The kernel's `createQuestionnaireHandoff({ records })`
computes the five-part ledger and blockers for scope and every dossier topic,
including interfaces. The service projects durable records into this read
model; the dashboard displays its result. Questionnaire readiness means no
outstanding record blockers. Dossier composition, semantic summaries, Node
responsibilities, validation, and Workflow owner approval remain separate
requirements. The dossier/FactoryPlan form of the same handoff API retains
its existing completion checks.

Only active, acknowledged restatements are confirmed user facts. Every answer
referenced by a restatement needs its answering person's acknowledgement.
A dispute blocks until a new resolution replaces it. Correcting an answer or
question removes the old restatement from the confirmed ledger immediately.
Source-derived facts retain their source-study identities and revisions;
stale evidence blocks its topic, and an unstudied pin blocks all topics.

Inferences and assumptions are revisioned drafts, never caller-declared
facts. A draft may link a same-topic question in its Workflow version and
records the question revision it linked. It becomes confirmed only when that
question has current, acknowledged facts. The link follows later revisions of
the question, because the sign-off is the resolution: its preview lists every
linked draft and binds the draft revisions, so concurrent draft edits require
review again. A deferral does not confirm an inference. New or changed meaning
cannot reuse a resolved question. Agents with an engineer token may create and
revise drafts; retiring one removes a readiness blocker, so it stays with a
signed-in person. Retirement preserves every revision and is recorded in
Activity.

Round publication stores an immutable ledger baseline in the same transaction,
including publication of a follow-up round. Comparisons use record identities,
revisions, states, and provenance rather than wall-clock timestamps. Publication
retries preserve the first baseline. Historical rounds published before this
feature have no reconstructable baseline and are explicitly unavailable for
comparison. Draft questions are hidden from readers without composing rights
in both current and historical views.

## Considered Options

- Compute readiness in the dashboard or server. Rejected because the kernel
  remains the authoring authority and CLI callers need the same rules.
- Reconstruct a round's ledger from timestamps. Rejected because mutable
  state, equal timestamps, and concurrent writes can lose the publication
  boundary or reuse later acknowledgements.
- Store a caller-controlled confirmation flag on drafts. Rejected because
  Agents draft and people sign off through questions and acknowledgements.
