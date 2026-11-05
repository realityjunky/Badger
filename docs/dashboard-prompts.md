# Dashboard prompts and questionnaire discovery

Badger's dashboard supplies stage instructions through the server and Badger
MCP. A person needs their Agent and a configured MCP connection, without
installing a dedicated questionnaire Skill. The existing CLI Skill remains a
separate, older flow; it is not loaded by these tasks.

## From the questionnaire Skill to staged work

| Essential method | Scenario and stage | Available context | Result and sign-off |
| --- | --- | --- | --- |
| Read inventoried evidence before interpreting a Skill | Engineer-dispatched Source study | One complete pinned Skill, existing findings, script-effect contract | Source facts and effect suggestions; Engineer acceptance and uploader confirmation remain distinct |
| Discover only unresolved workflow meaning; prioritize one idea per question | Engineer-dispatched Questionnaire questions and follow-ups | All pinned Skills, accepted findings, workflow frame, submitted answers, ledger, concerns and readiness | Suggested questions for a selected draft round; Engineer acceptance and round publication are separate |
| Compare the producer's output contract with the consumer's input contract | Questionnaire discovery | Both pinned Skills and their evidence | Compatibility evidence plus questions about mismatches, transformations and decisions |
| Preserve partial knowledge and uncertainty | Agent-assisted answers | Assigned question, requested answer type, person's own draft and explanation | Draft or submitted answer at that person's request |
| Keep confirmed facts, source facts, inferences, assumptions and questions distinct | Agent-assisted suggestion editing | Latest shared result, original submission, schema and bounded task context | Shared review revision; Engineer accepts separately |
| Restate faithfully with exact provenance | Engineer-dispatched restatements | Current submitted answer revisions | Proposed facts; Engineer confirmation and answering person's acknowledgement |
| Check every semantic topic and Node responsibility against ledger facts | Dossier and plan review | Current dossier, ledger, pinned sources and kernel findings | Workflow-owner approval of exact versions |
| Preserve bounded responsibilities, evidence and dependency hashes | Package Authoring and review | Kernel lane handoffs and accepted dependencies | Proposed lane outputs; human acceptance, assembly, evaluation and publication |

The first three methods come from `SKILL.md`'s evidence, exchange and
completeness sections. `reference/source-study.md` contributes incremental
source reading, per-script coverage, uncertainty and separate uploader review.
`reference/semantic-dossier.md` contributes the five categories, topic coverage,
fact provenance, Node responsibilities, explicit deferrals and consistent goals.
The CLI's project search, filesystem handoff and automatic first-use behavior
are intentionally absent from dashboard prompts.

## Manage templates

Administrators open **Admin → Prompt templates**. Eight stage tabs list Agent
drafting, Agent assistance and human-review templates with their roles, required
context, expected output and revision. Edit, review the exact proposed text,
then confirm and save. History retains earlier saved revisions. Conflicting
edits require reloading. Templates are English instructions; the dashboard
controls follow the person's selected language.

Template access never grants workflow access. Other roles receive only prompts
for tasks they may perform. Required authorization, schema checks and personal
sign-offs are enforced independently of editable instructions.

## Dispatch and claim

1. Create a round with **Queue question drafting for this round** selected,
   or request another drafting kind for an existing draft round.
2. In **Suggestions**, copy the queued job's Agent prompt. Plan and Authoring
   jobs expose the same control in their stage panels.
3. Paste it into an Agent connected to that deployment's Badger MCP. The Agent
   claims the exact job, reads `instructions.md`, context, schema and pinned
   files, then submits `result.json` through MCP.
4. Review and optionally edit the shared suggestions. The Engineer separately
   accepts the reviewed result. Accepted questions enter the draft round;
   publishing it remains a separate dashboard confirmation.

Each new job carries a template snapshot, so a later template edit does not
change its instructions. A claim receives the method even if the Agent did
not start from a copied prompt. Changing discovery inputs cancels a stale job.
The copy dialog includes a manual-copy fallback when clipboard access fails.

## Answer or edit with an Agent

An assigned question's answer editor offers **Copy answer prompt**. The Agent
refreshes `answer_context`, elicits the person's knowledge, saves with current
revisions and submits only when asked. It receives only that person's private
draft. An Engineer can answer when assigned, using their engineer token scope.

Submitted questionnaire jobs offer **Copy review prompt** to Engineers and
Field experts. Their Agents read `suggestion_review_context` and, with the
person's permission, save the complete edited result through
`save_suggestion_review`. A stale job revision conflicts; it must be reloaded
and reconciled. Saving shared edits does not accept results or publish a round.

Confirmation, acknowledgement, approval, publication and Run gate answers
remain manual dashboard actions. Workflow stage panels expose **Review
guidance** drawn from the corresponding human-review templates.

## Source study and interfaces

A source study establishes one Skill's existing inputs, outputs and constraints.
Its `interfaces` compatibility field must be empty. Cross-Skill questions are
generated by Questionnaire jobs that can read both sides. A proposed adapter,
new column mapping or changed validation rule stays an inference or question
until confirmed by the appropriate people.

Historical submitted single-Skill suggestions may still display invalid
interfaces. Reviewers can remove that section before saving and accepting
the remaining facts. Previously accepted records retain their history and
can be corrected or retired through the existing Source study controls.
