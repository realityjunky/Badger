# Dashboard guide

Use Badger to turn pinned source Skills and confirmed workflow knowledge into
a reviewed, published package. Agents draft from the supplied evidence;
signed-in people review meaning and perform confirmations.

Open **Documentation** in the sidebar for guidance alongside the current page.
**My work** shows personal counts and the Inbox. **Workflows** opens the
workflow catalog and its versioned stages. **Activity** sits under
**Administration**; its location grants no additional permission.

## Choose the workflow version and language

Select the Group, Workflow, and version before requesting work. A version keeps
the name, goal, intent, locale, and pinned sources it was created with. Editing
the workflow frame supplies defaults for future versions.

| Setting or content                                                           | What controls it                                                               |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Menus, buttons, and built-in help                                            | Your personal English/Chinese interface setting                                |
| Generated statements, questions, and narrative script-effect fields          | The selected Workflow version's locale, exposed to the Agent as `outputLocale` |
| A question translation                                                       | That translation job's explicit target locale                                  |
| Answers supplied by people                                                   | The answering person's own words and requested language                        |
| Paths, identifiers, hashes, schema enum values, code, and verbatim citations | Their original exact values                                                    |
| Saved suggestions and accepted records                                       | The stored text; changing interface language does not translate it             |

For example, a `zh-CN` workflow requests Chinese statements and explanations
even when a source Skill and the Agent's processing instructions are English.
An English draft already submitted by an Agent remains English until a new
draft is submitted or an authorized person edits it. Changing the interface
language alone does not rewrite that draft.

## Know who performs each action

| Person                  | Typical responsibility                                                                                                                                                                 |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Engineer                | Pin sources, request drafting, edit shared suggestions, accept or discard results, publish question rounds, compose dossier and plan versions, manage package Authoring and evaluation |
| Field expert            | Answer assigned Questions, edit shared suggestions, acknowledge or dispute restated answers, and raise domain concerns                                                                 |
| Workflow owner          | Approve exact dossier, plan, and proposal versions; review and publish the evaluated package                                                                                           |
| Original Skill uploader | Review and personally confirm that exact Skill version's script-effect declarations                                                                                                    |
| Operator                | Install published packages, start Runs, and perform authorized recovery on the Run's computer                                                                                          |
| Observer or Auditor     | Read the records their current scope permits; Auditors can inspect Activity                                                                                                            |

Administrators have workflow management overrides, but cannot confirm another
person's script declarations or acknowledge an answer on that person's behalf.
An Agent's token scopes narrow the person's permissions. Tokens cannot save
shared suggestion reviews or perform human sign-offs.

## Follow the eight stages

| Stage                  | Work and completion                                                                                                                                                                                                                        |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Sources                | An Engineer pins exact Skill versions, waits for the source check, reviews the current set, and confirms Sources. Pending script effects allow this read-only stage.                                                                       |
| Source study           | Record evidence-backed facts about each pinned Skill. Review script-effect suggestions with the original uploader. Mark a version studied only after its current requirements are complete. Script-free versions need no declaration task. |
| Questionnaire          | Request useful questions, publish reviewed rounds, collect people's answers, resolve them, and obtain any required acknowledgements. Use Ledger and readiness to find missing meaning.                                                     |
| Dossier                | The Engineer composes a coherent version from the Ledger and checks the kernel's findings. The Workflow owner approves the exact version.                                                                                                  |
| Plan and proposal      | Draft or compose the plan from the approved dossier, review its findings, obtain plan and proposal approvals, then explicitly initialize the project.                                                                                      |
| Package                | Confirm generation, request the kernel's ready Authoring lanes, review their submitted results, and confirm assembly when all required outputs are current.                                                                                |
| Evaluation             | Request an evaluation of the assembled package's exact hash and inspect its retained report. Source scripts are not executed by this evaluation.                                                                                           |
| Review and publication | The Workflow owner or Administrator reviews the current package and passing evidence, approves it, then separately confirms publication. Installation has its own local preview and confirmation.                                          |

Open the first incomplete stage and follow its named blockers. Changes to pins,
evidence, or accepted meaning can invalidate dependent work; earlier versions
and approvals remain in history. A passing result applies to its recorded
inputs, not to later changes.

## Request and share a drafting job

1. Open **Questionnaire → Drafting jobs and suggestions** for the selected
   version. Create a draft round first for question, follow-up, or import jobs.
2. Choose **Request drafting** and supply the target required by the kind.
   A source study targets one pinned Skill; cross-Skill comparison belongs to
   Questionnaire discovery.
3. For a queued job, choose **Copy Agent prompt** and paste it into an Agent
   connected to this deployment's Badger MCP. If copying fails, use the
   manual-copy dialog.
4. The Agent claims that exact job, reads `instructions.md`, the bound context,
   output schema, and pinned files, then submits suggestions. Claiming or
   submitting creates no accepted workflow records.
5. Right-click a job card's body and choose **Copy link address** to share
   that job. The link opens the correct version, reveals the job even when
   its status is normally filtered out, and highlights its card. Recipients
   still need their own current access.

The default status filter selects **Queued**, **Claimed**, and **Awaiting your
review**. **Filter by status** supports any combination of all six states:

| State                     | Meaning                                                   |
| ------------------------- | --------------------------------------------------------- |
| Queued                    | Ready to be claimed by the connected Agent                |
| Claimed                   | Leased to an Agent; an expired lease returns to the queue |
| Awaiting your review      | Submitted suggestions awaiting people                     |
| Accepted                  | Accepted into the appropriate workflow records            |
| Discarded                 | Rejected by an authorized person with a recorded reason   |
| Cancelled: inputs changed | Superseded because the inputs read by that job changed    |

## Edit shared suggestions and make decisions

**Review suggestions** and **Review decisions** perform separate actions.

1. Open **Review suggestions** to load the latest persisted result. For a
   source study, choose **Statements** or **Script effect review**, then a
   numbered item tab. Use the tab overflow menu when there are many items.
2. Edit statements or suggested effect labels, rationale, conditional behavior,
   and uncertainty. Script identities and citations stay bound to the pinned
   source. Choosing **None** excludes every other effect label.
3. Choose **Save** to share the whole edited result with the Engineer and Field
   experts. Moving between item tabs retains your unsaved edits. Closing the
   dialog without saving does not share them.
4. The Engineer opens **Review decisions** to inspect the latest saved result
   and confirm **Accept reviewed result**, or discards the batch with a reason.
   Accepted questions remain in their chosen draft round until that round is
   separately published. Restated answers still need the answering people's
   acknowledgements.

Multiple people may open the same review. Saves serialize and check the job's
revision: the first save advances it, and a stale save receives a conflict.
Keep a copy of local edits, reopen the current review, and reconcile them.
Automatic retries do not merge competing edits. Every successful save retains
the original Agent submission, appends review history, and invalidates an older
decision preview. Accept/discard confirmations have replay keys so retrying the
same confirmed request does not duplicate its result.

## Complete script-effect review

A statement records what a source says. An effect suggestion describes what an
inventoried script can do. The two have separate review and completion rules.

After saving useful suggestions, the Engineer chooses the current Source study
draft and **Send effect draft to uploader**. The initial proposal uses the
saved suggestions and creates one shared task. Sending the same job again
returns its existing review; use the clarification/correction workflow for
later investigation rather than overwriting the uploader's work.

The original uploader checks every script's labels, rationale, immutable
citations, conditional behavior, and uncertainty answers; marks rows reviewed;
previews the complete set; and personally confirms it. An Engineer accepting
statements or saving draft effects does not perform this confirmation.

See [Script effect review](script-effect-review.md) for coverage, clarification,
reuse, corrections, and invalidation.

## Resolve common problems

| Symptom                                       | What to check                                                                                                                                   |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| A job seems missing                           | Check the Workflow version and status filter. Accepted, discarded, and cancelled jobs are hidden by default.                                    |
| A review save conflicts                       | Preserve local text, reopen the latest revision, and reconcile the edits.                                                                       |
| A decision preview becomes stale              | A review or its inputs changed. Generate a fresh preview and inspect it before confirming.                                                      |
| A Chinese interface shows English suggestions | Check the version locale and job's requested output language. Stored draft text is not automatically translated.                                |
| The effect tab has no items                   | The version may contain no inventoried scripts, or the Agent may have supplied only facts. Missing required coverage remains pending.           |
| Source study cannot finish                    | Confirm Sources, resolve the study findings, and complete any current uploader declaration review.                                              |
| An Agent cannot claim a copied prompt         | Read the current job and report stale revisions, changed inputs, expired credentials, or denied access. Do not silently substitute another job. |

## Further reading

- [Dashboard prompts](dashboard-prompts.md): Agent dispatch, language rules,
  template snapshots, and human review boundaries.
- [Badger MCP](../packages/mcp/README.md): connection profiles, local claim
  folders, tool contracts, and supported hosts.
- [Identity adapters](identity-adapters.md): deployment sign-in and trusted
  proxy configuration.
- [Backup and restore](backup-and-restore.md): operational recovery.
- [Workflow manual](badger-workflow-manual.html): bilingual architecture and
  implementation reference.
- [Glossary](../GLOSSARY.md): the shared domain terms.
