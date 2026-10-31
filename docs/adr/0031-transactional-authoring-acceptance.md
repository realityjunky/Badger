# Replay Accepted Authoring Outputs Before Committing a New Session

Status: accepted. The service offers Authoring lanes and the review lane as
leased Agent drafting jobs. The kernel's dispatch decision and bounded handoff
own eligibility and inputs; the service stores the handoff with its context
hash. A job binds its generation, lane, prior lane record, and accepted dependency
material. An independent lane may be accepted while another Agent is drafting;
a changed dependency or generation cancels the affected draft. This holds until
an accepted result reports NEEDS_CONTEXT. The kernel then dispatches no lane,
and the result's draft follow-up changes the dossier's records, so the same
transaction withdraws the package and cancels every unaccepted draft. Work
resumes in a regenerated package, a fresh session, once the answer has come
back through the questionnaire, new dossier, plan, and proposal approvals, and
initialization. Agents submit inline authored content and never name files on
the service host.

A signed-in Engineer previews acceptance or rejection against the job revision,
result, and input hashes. Rejection keeps its reason. Acceptance reinitializes
the approved proposal and replays the generation's immutable accepted outputs
through the kernel into a disposable namespace under the same Project root.
It then records the new output through the kernel and commits the exact Creator
bytes, namespace pointer, accepted revision and person, job decision, stage
changes, audit, and any follow-up together. A failed transaction leaves the
previous session untouched; its retry uses another disposable namespace.
The extra generation and replay work was preferred to overwriting a committed
session and relying on a database rollback to undo filesystem writes.

A NEEDS_CONTEXT result creates a draft questionnaire follow-up tied to the lane
and job. A Wave 1 lane's question action supplies its text and, as its
rationale, the kernel's dossier-field requirement. Later lanes and the review
lane may omit the action; their draft takes the result's summary and a
rationale naming the lane and its status. The Engineer edits either draft
before publishing it, and the normal questionnaire invalidation rules apply.
A BLOCKED result creates a linked repair drafting job carrying the lane's
action and current inputs. Neither case counts as a current completed lane. Review votes are drafting
jobs too, and the kernel validates their provider evidence and review policy.
Their human acceptance is separate from the independent package approval.

Assembly is a signed-in Engineer's confirmed action bound to the exact Creator
state and session revision. It replays into another disposable namespace and
calls kernel assembly. The committed package keeps its assembled hash and
inventory for later evaluation. Agents cannot accept a result or assemble.
