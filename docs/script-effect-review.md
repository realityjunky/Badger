# Review Script Effects for a Skill Version

Script effect review is an optional attestation in the Skill Library. The
responsible uploader confirms the possible effects of scripts in one exact
Skill version. Workflows use their pinned sources and working dossier evidence
for approval. Use the dossier's **Executable disclosures** and **Questionnaire**
for decisions about a script the workflow actually calls.

## Open or start a review

Open **Skills**, select the exact version, and choose **Script effect review**.
The original uploader uses **Start review** to open a new draft. Skill library
readers can inspect the declarations and their history. A script-free version
shows its file inventory without a review tab.

To prepare a draft with an Agent, the Engineer opens **Questionnaire → Drafting
jobs and suggestions** and requests **Draft script effects (optional)** for a
pinned Skill. Earlier workflows use **Study a source Skill** for this job.
The connected Agent reads the exact pinned files and uses the versioned
effect contract. In **Review suggestions**, edit and save the suggestions
before choosing **Send effect draft to uploader** on the job card. The
uploader's Inbox item opens the review for that exact Skill version. Repeated
sends of the same job open the same review.

## Review evidence and confirm

Select a numbered script tab. Check the effects, rationale, and conditional
behavior, including any invoked helpers. The kernel contract supplies
`none`, `local-writes`, `network`, `scheduler-submission`, and `installs`.
`none` is exclusive. A complete attestation needs explicit coverage, rationale,
source evidence, and answers to open uncertainties for every inventoried script.

Expand **Source evidence** to inspect or edit immutable file citations. Enter
a verified answer in **Answer the uncertainty** and choose **Save review
draft**. The script's red **!** clears when Badger saves the answer. A draft can
be saved while there are still questions to resolve.

**Review complete declaration set** saves the current draft and opens a preview
when the declarations are complete. Inspect it and choose **Personally confirm
declarations**. The receipt binds the exact Skill version, review revision,
coverage, sources, uploader, and contract. Only the signed-in responsible
uploader with current Skill library access can confirm. The attestation
describes possible behavior and grants no execution permission.

## Request clarification or make a correction

For an Agent draft sent from a workflow, save any edits before entering a
**Clarification or correction note**. Choose **Request clarification** to send
the note to that workflow's Engineer. The Engineer's **Script effect
clarification** Inbox item opens the exact Skill review. The current note is
below the numbered script tabs, and **Declaration review history** keeps the
earlier notes and answers.

The Engineer may inspect the pinned sources or request a fresh optional draft.
A newly routed draft starts with empty answer fields. The uploader enters
verified answers and saves them in the review.

Use **Correct declarations** to revise a confirmed set. Save the correction
reason with the draft and personally confirm the new revision. **Declaration
review history** retains the earlier drafts and confirmations. New Skill
versions have their own review. Historical Dossiers, FactoryPlans, and packages
retain any declaration bindings they recorded for their exact version.

See the [architecture decision](adr/0052-advisory-skill-script-effect-reviews.md).
