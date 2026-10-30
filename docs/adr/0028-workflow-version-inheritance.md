# Inherit Reviewed Records Without Reissuing Approvals

Status: accepted. A new Workflow version copies the latest version's pinned
Skills, source-study records, questionnaire revisions with their accepted
translations and import provenance, answers, facts, and resolutions under the
workflow and source-version locks. Each copied record
gets a new identity and immutable provenance naming its source version,
record, and revision. Further edits are independent, and an inheritance chain
can always be followed to the original decision. Facts and answer attachment
receipts retain their content hashes; inherited acknowledgements retain their
original person, time, and confirmation hash. They describe an earlier decision,
not a new sign-off by the person starting the version.

Changed or removed cited files reopen their questions, including deferred
questions, and mark source-derived facts stale. Comparing file hashes rather
than whole Skill identities preserves unrelated confirmations, and the same
comparison lets new and revised questions keep citing an earlier version
whose file is unchanged. Reopening is
sticky until a person reviews updated evidence and confirms again; restoring
an old pin does not silently restore a withdrawn confirmation. The dashboard
shows the old and current file beside each affected record.
Interface producer and consumer references must still match current pins,
including an endpoint whose own files are not cited by that interface.

Approvals, packages, jobs, and round publication baselines belong to the version
in which they were reviewed and are not copied. The new version queues its own
source check and requires fresh gates. Original round baselines and discussion
remain accessible through provenance links; they are not reconstructed against
the new record identities. Superseded dossier artifacts and approval history
remain readable, including the original confirmation retry response. Sharing
mutable records across versions or issuing fresh confirmations during the copy
was rejected because either would change what an earlier reviewer signed off.
