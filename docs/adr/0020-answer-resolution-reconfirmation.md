# Preserve Fact Provenance When Answers or Evidence Change

Status: accepted. Each Engineer resolution and every fact and acknowledgement
it produces is immutable. Facts bind exact submitted answer revisions, the
workflow version's locale, and evidence file hashes. Signed-in people review
a hash-bound preview before confirming or acknowledging; personal access
tokens cannot sign off. A retry quotes a client request ID and returns the
original result rather than recording another decision.

A confirmed answer may be corrected even after sign-off. Its first new draft
immediately makes the resolution's facts inactive and marks the question as
needing re-confirmation, so an earlier acknowledgement cannot validate changed
meaning. Revising the confirmed question does the same. Other resolutions
remain locked. A dispute makes the facts inactive and reopens the question,
with a reason and an Engineer inbox item. Re-confirmation produces new facts
requiring new acknowledgements; it never rewrites earlier records.

Replacing a Skill pin compares the cited file hashes, preserving facts when
only unrelated files changed. A changed or missing cited file requires
re-confirmation, and the Engineer updates the question's evidence before
confirming again. Invalidating every fact on any Skill upload was rejected
because an immutable version that the workflow has not pinned changes none of
its inputs. Keeping a fact active until the next dossier approval was rejected
because readers could continue relying on a restatement whose answer changed.
