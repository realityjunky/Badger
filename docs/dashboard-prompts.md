# Dashboard prompts

Badger supplies stage instructions through its server and the connected Badger
MCP. A person needs an Agent host and an authorized MCP connection; dashboard
jobs do not require installing a separate questionnaire Skill or configuring a
server-side model provider. The CLI questionnaire Skill remains a separate flow.

For the human workflow, start with the [dashboard guide](dashboard-guide.md).
For tool names, claim folders and profiles, use the [MCP reference](../packages/mcp/README.md).

## Instruction and data boundaries

Every Agent job combines three inputs:

1. **Kernel rules** establish evidence handling, bounded scope, output-language
   instructions, conflict handling and the people-only review/sign-off boundary.
2. **A template snapshot** describes the stage's method, audience, dependencies,
   output and completion criteria. Administrators can revise template bodies.
3. **Bound task data** identifies the workflow/version, target, revisions,
   context hash, output schema and supplied evidence. Names, source files,
   answers and comments are data, not instructions to override the task.

Prompts do not grant permissions. The server still checks roles, token scopes,
leases, revisions, evidence, schemas and confirmation hashes. The kernel remains
the authoring and runtime authority.

## Output language

The copied dispatch prompt, claim's `instructions.md`, and job metadata expose
`outputLocale`. Ordinary drafting uses the job's bound Workflow version locale;
`translate-question` uses its explicit target locale. A later edit to the
workflow's future frame, another person's interface language, or English source
files does not change that target.

For `zh-CN`, generated statements, questions, rationales, conditional behavior,
uncertainty and review summaries use Simplified Chinese. Schema keys and enum
values, identifiers, file paths, hashes, code, commands and verbatim citations
retain their exact forms. Check the language of every item before submission.
An answer-assistance task preserves the person's requested language and words.
Formal Skills, their references, tests and package documentation retain their
required English language; the locale applies to review narrative and workflow
records around those artifacts.

Templates themselves are English processing instructions. Their language does
not select the language of generated records. Changing a personal interface
setting also does not translate stored suggestions or accepted records. An
incorrect-language draft needs a new Agent draft or an authorized person's
manual edits; the service does not silently rewrite it.

The per-task language instruction is derived from the already-bound task,
including when an older template snapshot omits language guidance. This does
not mutate that snapshot, the original Agent submission or its context hash.

## Dispatch, claim and submit

1. Select the intended Workflow version and confirm its locale and pinned
   sources. Create a draft round first when the drafting kind requires one.
2. Request drafting, or create a round with **Queue question drafting for this
   round** selected. Plan and Authoring jobs use their own stage panels.
3. Copy the queued job's **Copy Agent prompt** text into the Agent connected to
   this deployment. The short text carries exact claim identifiers, revision,
   context hash, output locale and MCP steps. A copy failure opens a manual-copy
   dialog.
4. The Agent claims that exact job and reads `instructions.md`, `job.json`,
   `context.json`, `output-schema.json`, any bounded `inputs/`, and the supplied
   pinned files. It reads source code as evidence and never executes it.
5. The Agent writes `result.json`, checks the complete result's schema, target
   IDs, citations, language and scope, then calls `submit_job` for that claim.
6. Submission keeps the job **Claimed**. Continue follow-up changes through
   the same Agent session, editing `result.json` and calling `submit_job` again.
7. When the person says the drafting session is finished, the Agent calls
   `finish_job`. The latest saved suggestions become available for dashboard
   editing or another Agent claim. Only a person's separate acceptance enters
   them into records; finishing completes no human gate.

The MCP renews claims while connected and releases them on disconnect. A crash
or prolonged outage recovers through the thirty-minute lease without losing
saved suggestions. While claimed, other dashboard edits, decisions and claims
are blocked. An unclaimed suggestion's **Copy Agent prompt** starts another
session from the latest saved edits. Accepted jobs require new drafting work.

An already-running local MCP keeps its old behavior until it is updated and
restarted. Confirm that `finish_job` appears before starting an iterative
session. A submit receipt identifies legacy submit-and-release requests.
Check `savedDraft.resultHash` and `job.currentResultHash`, and read the content
at `job.currentResultPath` (`review.result` for revisions). The original
`job.result` and `job.resultHash` remain unchanged intentionally. Releasing a
saved claim keeps the suggestions available; never submit probes to a real
job to test whether a save worked.

A claim carries the same method when an Agent starts directly through MCP
without a copied prompt. Claiming creates the private local evidence folder;
it does not authorize host-wide Skill discovery or writes to service-host paths.

On a changed revision, cancelled job, expired lease or denied access, read the
current record and report the conflict. Preserve any useful local draft for
human reconciliation. Do not silently claim a replacement job, overwrite a
newer result or repeat a confirmation with different contents.

## Stage methods and completion

| Task                     | Read first                                                                                                        | Draft and check                                                                                                                   | Human handoff                                                                                |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Source study             | One pinned Skill's complete inventory, scripts and invoked helpers, existing findings, and script-effect contract | Independently reviewable facts; per-script effects with evidence, conditional modes and explicit uncertainty; `interfaces: []`    | Engineer accepts useful facts; original uploader separately confirms declarations            |
| Questions and follow-ups | All supplied Skills, current Ledger/readiness, prior questions, submitted answers, concerns and selected round    | High-value unresolved questions, one decision per question, existing target/assignee IDs, suitable answer types and no duplicates | Engineer reviews, accepts into the draft round, then separately publishes it                 |
| Open-question import     | Target Skill's explicit questions and original numbers, previous imports and selected round                       | Relevant existing questions with immutable provenance, translated faithfully into the target locale                               | Engineer accepts unpublished draft Questions                                                 |
| Answer assistance        | Current assigned Question, answer format and this person's private draft                                          | Elicit the person's knowledge; preserve partial answers, uncertainty, values and attachments                                      | Save or submit only at that person's request; acknowledgement stays separate                 |
| Restatement              | Selected Question and exact latest submitted answer revisions                                                     | Faithful, attributed facts; preserve qualifications and disagreements                                                             | Engineer confirms; answering people acknowledge or dispute                                   |
| Translation              | Exact source Question revision and explicit target locale                                                         | Question and rationale with unchanged meaning, technical values and uncertainty                                                   | Engineer accepts a translation without replacing canonical text                              |
| Plan                     | Approved dossier, supporting Ledger facts, kernel planning input, skeleton and schema                             | Complete candidate with bounded Nodes, contracts, routes, guardrails and recovery; named gaps remain unresolved                   | Plan/proposal approvals, initialization and generation remain separate                       |
| Authoring lane           | Kernel handoff, approved inputs and exact accepted dependencies                                                   | Only assigned claims and owned leaves; inline artifacts, required evidence and schema checks                                      | Engineer accepts the exact output; missing context and blockers are resolved before assembly |
| Review vote              | Accepted lane records, assembled package, dossier, plan and review handoff                                        | Specific, evidenced findings and blockers with current dependency hashes                                                          | A person accepts the proposed review; an Agent vote grants no approval                       |

Sources, Dossier, Evaluation and Review/publication also have human-review
templates. Their **Review guidance** explains what the authorized person checks;
it does not create additional Agent tools or bypass a current confirmation.

## Review submitted suggestions personally

Engineers and Field experts use **Review suggestions** in the dashboard. Source
results have **Statements** and **Script effect review** main tabs, each with
numbered item tabs. Saving shared edits retains the original submission and
appends review history; it does not accept records, confirm declarations or
publish a round.

A competing save returns a revision conflict. Reopen the current result and
reconcile local edits. The Engineer separately uses **Review decisions** to
preview the latest saved batch, then accepts it or discards it with a reason.
A later save invalidates an earlier decision preview.

Standalone Agent-assistance review tools remain unavailable. To continue with
an Agent, copy the unclaimed job's prompt and claim it again. The new session
receives the latest saved suggestions and retains the exclusive claim across
submissions. Personal access tokens cannot write the human review endpoint;
all sign-offs remain dashboard work.

## Source study, effects and interfaces

Source study records one Skill's existing behavior and input/output contracts.
Its legacy `interfaces` compatibility field must be empty. Questionnaire
discovery can read both producer and consumer Skills and ask about mismatches,
transformations and decisions. Choosing an adapter or a connection remains
workflow meaning for people to confirm.

Historical submitted suggestions may contain legacy interfaces. Reviewers can
remove that section before saving and accepting useful facts. Previously
accepted records retain their history and can be corrected or retired through
Source study controls.

The initial effect proposal sent to the original uploader uses saved review
edits. An existing routed review is preserved on repeated sends; clarification
and correction retain their own history. See [Script effect review](script-effect-review.md).

## Manage templates

Administrators open **Admin → Prompt templates**. Eight stage tabs list Agent
drafting, answer-assistance and human-review templates, including their audience,
dependencies, expected output and revision. Edit, inspect the proposed text, then
confirm and save. Conflicting edits require reloading; history retains saved
revisions.

Each new job freezes its selected template snapshot. Editing a default or an
Administrator's saved body affects future jobs, while already-queued jobs keep
their template body and hash. Published application updates do not overwrite an
Administrator's saved template revisions. Compare customized bodies with the
current catalog and deliberately review any changes you want to adopt.

When revising a template, preserve its task, scope and output schema; make the
read-first inputs, drafting method, final checks and human handoff explicit.
Use the supplied `outputLocale` for generated prose. Keep source identity,
uncertainty and immutable citations intact. Test the claim path as well as the
copied prompt, since the claim delivers the actual processing instructions.
