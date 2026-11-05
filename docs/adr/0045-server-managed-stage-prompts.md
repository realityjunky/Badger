# Deliver stage instructions from the server through prompts and MCP

Status: accepted. The collaborative dashboard is the primary authoring flow.
Dedicated laptop Skills are optional. The standalone questionnaire Skill and
CLI commands remain unchanged until a later companion-CLI update is requested.

The kernel owns a prompt-template catalog classified by workflow stage,
scenario (Agent drafting, Agent assistance, or human review), role, required
context, and expected result. The defaults extract the source-reading method,
progressive questioning, five-part ledger, semantic completeness, provenance,
deferrals, and confirmation rules from `badger-workflow-questionnaire/SKILL.md`
and its `source-study.md` and `semantic-dossier.md` references. Local project
discovery, conversational owner-only approval, CLI commands, and file-based
handoffs do not belong in the dashboard templates.

Only signed-in Administrators read or edit the catalog in Admin. Editing needs
a current revision, a preview and explicit confirmation of its hash. Saves
append template history and an audit event; concurrent stale edits conflict.
Required permissions, validation, provenance and human sign-offs remain server
rules independent of editable wording.

New drafting jobs snapshot their template revision and hash inside their
hash-bound input context. Template edits affect future jobs, not outstanding
ones. Copying a dispatch prompt assembles that snapshot with the exact task and
MCP transport instructions. Claiming supplies processing instructions from the
same snapshot, written to `instructions.md` by the MCP alongside context,
schema and pinned files. Processing instructions do not dispatch another job.
An existing pre-template job receives the packaged default as compatibility
guidance, without claiming a historical template was used to produce its result.

Creating a questionnaire round can queue its question-drafting job in the same
transaction. It remains a draft round. The Engineer copies the prompt to their
Agent, reviews the returned suggestions, accepts them, and separately publishes
the questions. Question and follow-up jobs receive all pinned Skill files,
source-study findings, prior questions and submitted answers, the ledger,
concerns, discussion, assignees and settings. Changes to these discovery inputs
cancel outstanding jobs. Private answer drafts never enter this context.

Single-Skill source-study jobs generate evidence-backed facts, including the
Skill's input and output contracts, and script-effect suggestions. Their legacy
`interfaces` field must be empty, including when reviewing or accepting an old
job. Evidence is confined to the job's target Skill version. Cross-Skill
comparison belongs to questionnaire discovery, where both producer and
consumer files are available. A documented contract is source evidence;
choosing a connection or transformation is proposed workflow meaning requiring
human confirmation. Historical interface records retain their revisions, and
manually recorded interfaces must identify distinct Skills.

Assigned Field experts, Workflow owners and Engineers can copy an answer prompt
and refresh it through `answer_context`. It contains the current question and
only their own private draft. Their Agent elicits their knowledge and uses the
existing revision-checked answer tools with permission. It never invents an
answer. An Engineer can be assigned a question and acknowledges their own
restatement through the same human-only process as other answering people.

Workflow Engineers and Field experts can copy suggestion-review prompts and
use `suggestion_review_context` and `save_suggestion_review` through their
scoped personal tokens. This extends ADR 0043's browser-only editing rule:
editing shared provisional suggestions is drafting, not sign-off. Saves retain
the original submission, increment the shared review revision and invalidate
older decision previews. Accepted records and approvals remain unchanged until
the Engineer's separate dashboard decision. Unpublished questions unrelated to
the review are excluded from Field-expert review context.

Human-review templates provide stage guidance to authorized signed-in roles.
The dashboard's current previews and capability checks remain authoritative
for who may approve each action, including Workflow-owner approval and
publication. Prompts cannot grant permission, perform approvals, or replace
the kernel's authoring or runtime decisions.

## Considered options

- Require every Agent host to install the questionnaire Skill. Rejected for
  the dashboard flow: instructions would drift across laptops and lack the
  task's role, revision, stage and current context.
- Put one large prompt in the copied browser text. Rejected: the claim path
  must deliver the same method when an Agent starts directly from MCP.
- Let an Administrator change in-flight instructions. Rejected: a submitted
  result must remain reviewable against the context the job supplied.
- Generate cross-Skill interfaces during per-Skill study. Rejected: the Agent
  cannot establish the consumer contract from the producer's files alone.
