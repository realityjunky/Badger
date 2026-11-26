# Reconcile concurrent lane repairs against the current Plan

An accepted Authoring lane that targets Plan retains its own Drafting job,
original Plan version and submitted suggestions. Several lanes can revise
the same Plan concurrently. When the current Plan advances under the same
approved dossier and source inputs, those jobs can finish on their original
inputs. A submitted repair, including a saved repair cancelled by an older
server, can be reviewed against the current version. Deleting a draft
removes it from this review flow.

The kernel compares the original Plan, current Plan and latest saved draft.
It carries forward one-sided and identical edits and matches entries in
identified lists by ID. Concurrent insertions retain each side's relative
order, using ID order to break ties between independent groups. Competing
values, incompatible order changes and concurrent edits to lists without
stable IDs require an explicit choice. The Engineer may combine competing
text in the dashboard. An explicit edit of the combined Plan quotes its
content hash and goes through the same kernel validation and confirmation.

Acceptance binds the current Plan version, exact combined Plan, draft
revision and conflict choices to the confirmation. A subsequent head change
requires a fresh preview. Accepting changes already present records the
lane's decision and reuses the current Plan and its approvals. Confirmation
retries return the original receipt. Changes to the dossier or source
inputs still invalidate the job under ADR 0025.
