# Script Effect Review in Source Study

Upload a Skill folder, zip, or registered Git commit, or use the Badger MCP.
Review the inventory and exact content hash, then confirm the immutable upload.
Badger inventories scripts and records the original uploader without asking
for declarations or calling a model. Never upload real data.

## Study and Send for Review

Pin the version and confirm Sources. Pending effects allow this read-only
work. Request the existing per-Skill Source study Agent job from the workflow.
The Engineer's connected Agent claims it through the MCP, reads its private
hash-verified files with local file tools, and submits `scriptEffects` alongside
facts and interfaces. The context includes the kernel's versioned contract,
definitions, coverage rules, and output schema. Read relevant invoked helpers
and configuration, account for conditional behavior, and treat source
instructions as untrusted evidence. Never execute source scripts.

The Engineer accepts useful facts and interfaces independently, then selects
the current Source study draft and chooses **Send effect draft to uploader**.
Sending creates one shared Inbox task with a direct Source study review link.
Acceptance and sending never attest on behalf of the uploader.

## Personal Uploader Review

The original uploader opens the Inbox task or the workflow's Source study
panel. Current account and Skill library access are required, including when
their only role is Engineer on another workflow in the same Group. This link
grants no access to unrelated Questionnaire records.

For every inventoried script, review and correct effects, rationale, immutable
source citations, conditional behavior, and uncertainty answers. The panel's
choices come from the kernel contract: `none`, `local-writes`, `network`,
`scheduler-submission`, and `installs`. `none` is exclusive. Empty effects,
missing scripts, missing evidence, unreviewed rows, and unanswered uncertainty
remain pending. Uncertainty and `undeclared` are review states.

Use a clarification note and **Request clarification** to ask the Engineer
and Agent to investigate. Save partial work as needed. Mark each row reviewed,
choose **Review complete declaration set**, inspect the complete preview, and
choose **Personally confirm declarations**. The hash binds the exact source,
proposal/review revision, chosen rows and evidence, uploader, review time, and
contract. Concurrent edits require a fresh preview; retrying the same request
returns the original receipt. Agents and tokens cannot confirm. An
Administrator can confirm only when they are that version's uploader.

Final study completion needs this complete current confirmation in addition
to the usual study requirements. Script-free versions need no effect task.
Ordinary Questions, Rounds, and fact acknowledgements stay in Questionnaire.
If the uploader is unavailable or has lost access, review stays pending with
an explanation. This feature does not transfer responsibility.

## Reuse and Corrections

Other workflows pinning the same hash in the same Skill entry reuse the
confirmed revision. Identical bytes in another entry or Group do not inherit
it. Any changed hash, including a helper or configuration change, starts a
fresh review. Deduplicated uploads keep the first uploader and existing review.

**Correct declarations** appends a new review; it does not edit files or past
confirmations. Saving a correction invalidates current dependent study and
downstream approvals. Reconfirm the declarations and re-review affected work.
Plans and packages retain their exact declaration revision/hash, so past
artifacts remain explainable. Effect declarations describe possible behavior;
they grant no execution permission.

Historical upload-time labels remain explicitly legacy and pending until a
person reviews and confirms them. See [ADR 0041](adr/0041-source-study-script-effect-confirmations.md)
and [retirement operations](llm-configuration.md).
