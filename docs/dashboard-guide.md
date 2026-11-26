# Dashboard guide

Use Badger to turn pinned source Skills and confirmed workflow knowledge into
a reviewed, published package. Agents draft from the supplied evidence;
signed-in people review meaning and perform confirmations.

Open **Documentation** in the sidebar for guidance alongside the current page.
Expand a topic under **Workflows** to see what to do in a stage. Find the
optional **Script effect review** and **Request clarification** guides under
**Skills**. **My work** shows
personal counts and the Inbox. The dashboard's **Workflows** page opens the
workflow catalog and its versioned stages. Find **Activity** under
**Administration**.

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
| Original Skill uploader | Optionally review and personally confirm script effects for that exact Skill version in the Skill Library                                                                              |
| Operator                | Install published packages, start Runs, and perform authorized recovery on the Run's computer                                                                                          |
| Observer or Auditor     | Read the records their current scope permits; Auditors can inspect Activity                                                                                                            |

Administrators have workflow management overrides, but cannot confirm another
person's script declarations or acknowledge an answer on that person's behalf.
An Agent's token scopes narrow the person's permissions. Tokens cannot save
shared suggestion reviews or perform human sign-offs.

## Follow the eight stages

| Stage                  | Work and completion                                                                                                                                                                               |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sources                | An Engineer pins exact Skill versions, waits for the source check, reviews the current set, and confirms Sources.                                                                                 |
| Source study           | Copy the prompt for the checked pin set. Inspect the Skill uses, handoffs, routes, and evidence. Record effects that matter to workflow decisions in Executable disclosures.                      |
| Questionnaire          | Raise assigned Questions, publish rounds, resolve Answers, and review questionnaire records.                                            |
| Dossier                | Edit working dossier fields and handoffs, apply reviewed Answers, and check readiness. The Workflow owner approves the exact revision.                                                                                                             |
| Plan and proposal      | Draft or compose the plan from the approved dossier, review its findings, obtain plan and proposal approvals, then explicitly initialize the project.                                             |
| Package                | Confirm generation, request the kernel's ready Authoring lanes, review their submitted results, and confirm assembly when all required outputs are current.                                       |
| Evaluation             | Request an evaluation of the assembled package's exact hash and inspect its retained report. Source scripts are not executed by this evaluation.                                                  |
| Review and publication | The Workflow owner or Administrator reviews the current package and passing evidence, approves it, then separately confirms publication. Installation has its own local preview and confirmation. |

Open the first incomplete stage and follow its named blockers. Changes to pins,
evidence, or accepted meaning can invalidate dependent work; earlier versions
and approvals remain in history. A passing result applies to its recorded
inputs, not to later changes.

## Draft the working dossier

After the source check passes, open **Source study** and copy the prompt for the
selected Workflow version. Paste it into an Agent connected to this deployment's
Engineer MCP. It can use hash-matching workstation files or retrieve the pinned
bytes. Its saved changes appear in **Workflows → Dossier**. The version selector
opens on the working revision. **Readiness by topic** shows field values,
their evidence, and open decisions. Expand **Workflow structure** there to
edit occurrences, handoffs, and routes. The dashboard and the Engineer MCP
update the same working revision. **Questionnaire records** links to the
five-part ledger and comparisons with published rounds.

In **Executable disclosures**, record effects that matter to the workflow's
use of a script. If a Node uploads a report, record what it sends, its
destination, and any approval the workflow needs. Ask about unresolved
conditions or approvals in **Questionnaire**.

Use **Ask a Question** on a field to start an assigned draft. Review the submitted
Answer through the round, then apply it to the field and select its reviewed
revision. In **Dossier**, choose **Workflow diagram** to inspect the handoffs,
**Workflow details** for workflow-wide fields, or **Revision details** to
review changes since approval. **Working JSON** shows the saved draft data.
Selecting a Dossier version switches every tab to that snapshot. Its
**Canonical JSON and record snapshot** tab displays indented JSON and lets
you inspect the exact text used for the hash.
After an edit conflict, reload the team's save and reconcile your changes.
Earlier workflows with Source study records use their original composition route.

## Inspect the Source study diagram

The diagram lays out Nodes from left to right, with Required Skill calls below
their parent Nodes. Dotted lines show the parent relationships. Select a box
or arrow in the diagram, or use the tabs and selectors below it. The selected
details appear below the diagram.

- **Handoffs** groups Documented and Proposed records in a dropdown. Muted
  solid arrows show Documented handoffs, and muted dashed arrows show
  Proposed ones. Select one to see the producer, consumer, artifact, format,
  and any recorded conditions.
- **Routes** shows control flow. Next and Optional routes use the accent color.
  Bounded rework uses the warning color. A pair of Nodes can have both a route
  and a handoff. Select a route to see its condition and visit limit when recorded.
- **Material findings** explains why a finding matters and lists its linked
  fields. Selecting a finding highlights the corresponding occurrences,
  handoffs, or routes when those fields appear in the diagram.
- **Pinned Skills** highlights every box that uses the selected pinned
  version. A Skill without any recorded uses is still listed.

Expand **Workflow details** for fields such as Scope and Roles.

## Open pinned source evidence

Expand **Source evidence** using the chevron on a detail card. Choose a file
and line range to read the cited excerpt. See **Sources → Pinned sources** for
each current Skill version's full hash.

## Initialize the approved proposal

In **Plan and proposal → Plans**, the Engineer records implementation choices
against the approved Dossier. The Workflow owner approves a saved Plan version.
In **Proposal & initialization**, the kernel shows what that plan would create
from the pinned sources, together with warnings and blockers. After the owner
approves the proposal, the Engineer chooses **Initialize project**. Initialization records the Creator state
that binds later generation to that proposal.

Once a Creator state exists, the action is **Replace Creator state**. Use it
when you intend to initialize again from the current approved proposal, for
example after approving a revised proposal. The confirmation identifies the
existing state by its hash. If that state changes before the job runs, Badger
refuses the replacement. Successful replacement withdraws the current package
and discards its generation, authoring, evaluation, and package review progress.
After a successful initialization, continue to **Package**.

## Author the generated package

1. Choose **Generate package** and confirm the generation preview. The first
   package is a scaffold with work for the Authoring lanes. **Generation jobs**
   shows progress and earlier generation attempts for the selected Workflow version.
2. In **Package files**, use **Filter package files** to find files by any part
   of their path, such as `reference/` or `SKILL.md`. The filter ignores case.
   Clear it to see every file. Select a path to preview it.
3. In **Authoring lanes**, choose **Request ready lanes**. Badger queues drafting
   jobs for unfinished lanes whose dependencies are current. Under **Lane jobs**,
   copy a queued job's Agent prompt for a connected Engineer Agent.
4. Review and accept the submitted results you want to use. Request ready lanes
   again as accepted results unlock dependent lanes. When all required results
   are current, confirm **Assemble package**, then request evaluation.

Use **View report** on an accepted lane or an earlier attempt to read the
summary, claims, findings and evidence. A finding can link to its owning
workflow stage or to **Evaluation**. An Engineer can choose **Request revised
draft** on the current report after addressing open lane concerns. The new job
receives the findings with its current inputs. The Engineer's acceptance can
assign minor concerns to named Evaluation checks when the authoring evidence
is complete. Those checks must pass before package review.

Open **Authoring plan** to check each lane's wave and dependencies. **Package**
shows the latest generated package for the selected Workflow version. Each
version can have one current package. Regeneration keeps the earlier package
snapshot and makes the new one current. Published packages retain their exact
bytes and appear under **Review & publication**.

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

## Review a Skill's script effects

The responsible uploader can record an optional attestation under **Skills →
Script effect review** for an exact version. To use Agent assistance, the
Engineer requests **Draft script effects (optional)** in **Questionnaire →
Drafting jobs and suggestions**. Send the reviewed draft from the job card.
The uploader opens it in Skills, checks evidence and answers uncertainties,
then previews and personally confirms the declaration set.

See [Script effect review](script-effect-review.md) for coverage, clarification,
corrections, and review history.

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
