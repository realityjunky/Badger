# Review Script Effects During Source Study with the Original Uploader

Status: accepted. Implements [#96](https://github.com/realityjunky/Badger/issues/96).
Supersedes ADR 0013's immutable upload-time declaration requirement and
ADR 0040's dedicated server-side model task and configuration. Source identity,
upload safety, and ADR 0005's Agents-draft/people-sign-off boundary continue.

## Decision

Uploads freeze files, their kernel inventory and identity, and the original
uploader. Folder, zip, registered Git, and MCP ingress need no declarations or
model connection. Deduplicating the same Skill entry and hash preserves that
uploader. Pending effects permit Sources confirmation and read-only study.

The kernel owns the versioned effect contract, its definitions, schema, and
coverage findings. The existing per-Skill Source study job binds this contract
and the current declaration revision into its context. The Engineer's Agent
reads the hash-verified pinned files locally, including relevant helpers and
configuration. It submits effect suggestions alongside facts and interfaces;
partial or uncertain findings remain useful drafts. Uploaded code never runs
and uploaded instructions remain untrusted evidence.

The Engineer explicitly sends the effect section to the original uploader.
Accepting facts and interfaces is a separate decision. A shared typed Source
study panel and deduplicated Inbox task let that uploader correct labels,
inspect bounded immutable citations, answer uncertainties, mark rows reviewed,
or request clarification. Narrow review access uses current Skill library
access and does not grant access to the referring workflow's Questionnaire.
Administrators cannot substitute for the uploader, and tokens cannot sign off.
An unavailable or unauthorized uploader leaves a clear pending blocker;
responsibility transfer is outside this decision.

The uploader previews the complete set and personally confirms its hash. The
hash binds source identity, review and proposal revision, complete rows,
evidence, actor, review time, and contract. Revision checks serialize edits;
confirmation receipts make identical retries idempotent. Only a complete,
current confirmation permits study completion. Script-free versions need no
review task. Questionnaire work remains independently available.

Reviews belong to a Skill entry and immutable version, within that entry's
Group access boundary. Workflows reuse the same confirmation; a different
hash or another Skill entry requires a fresh review. Append-only revisions
preserve proposals, clarifications, corrections, and confirmations separately
from immutable files. Plans and packaged source evidence retain the exact
confirmed revision/hash. Changing a confirmed set invalidates current study,
dossier, plan, proposal, and package work and requires re-review; historical
artifacts and approvals remain available with their original bindings.

## Migration and Retirement

Migration 0039 copies historical upload-time declarations into explicitly
legacy, pending review revisions, retaining original labels, uploader, and
time. Existing versions, Git provenance, audit history, and approvals are
untouched. Legacy labels can seed a review; migration creates no attestation.

Migration 0040 renames configuration, encrypted credentials, and provider
preview provenance into inert `retired_*` archives and removes transient call
leases. The runtime has no provider path, model assignment, prompt, credential
decryption, configuration import, or configuration/test endpoints. Encrypted
ciphertext is retained deliberately for historical recovery; no unrelated
secret is deleted. Deployment operators remove retired environment settings
and manage any offline key retention and later archive disposal under their
backup policy, using a separately reviewed migration for database disposal.
See [retirement operations](../llm-configuration.md).

## Alternatives

- Keeping declarations immutable with uploaded files forces unrelated file
  changes for corrections and prevents uploads by non-experts.
- A dedicated server model sends the whole bundle through another provider
  connection and duplicates the existing Agent drafting workflow.
- Repeating free-text questions in every workflow loses reusable version
  ownership and creates duplicate confirmation obligations.
- Treating old declarations or Engineer acceptance as uploader confirmation
  would manufacture an attestation that the person never made.
