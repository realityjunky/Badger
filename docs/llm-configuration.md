# Retirement of Upload-time Model Configuration

Badger #96 replaces #95's dedicated server-side script-effect task with
[Source study and personal uploader confirmation](script-effect-review.md).
Uploads and study require no Badger-managed model connection or external LLM
credential. Engineers use their own connected Agent to read pinned files
locally. [ADR 0041](adr/0041-source-study-script-effect-confirmations.md)
supersedes the relevant parts of ADRs 0013 and 0040.

The Administration model configuration/test panel, `/api/v1/admin/llm`
endpoints, upload suggestion endpoints, dedicated task prompt and model
assignment, provider calls, configuration import, and credential decryption
are removed. `BADGER_LLM_CONFIG_FILE`, `BADGER_LLM_KEY`, and
`BADGER_LLM_SECRET_*` have no runtime consumers. Remove these retired settings
from both server and worker deployment configuration.

## Historical Data and Credentials

Migration 0039 preserves immutable versions and their upload-time labels,
original uploaders, provenance, audit history, and approvals. It seeds
explicitly legacy, unreviewed declaration revisions and creates no personal
attestation. The original uploader must review and confirm current coverage
before new study completion can rely on it.

Migration 0040 preserves three offline archives:

| Archive                             | Retained data                                                                     |
| ----------------------------------- | --------------------------------------------------------------------------------- |
| `retired_llm_configuration`         | Accepted configuration revisions, prompt/model assignment, hash, and timestamp.   |
| `retired_llm_secrets`               | Original encrypted ciphertext and references, including any unrelated references. |
| `retired_skill_suggestion_previews` | Historical provider bindings, source evidence, and results.                       |

Transient provider call leases are dropped. The archives reject mutation and
have no application consumer; retaining ciphertext does not retain an active
drafting path. Existing notification and other unrelated secrets are untouched.

Retain database backups under the deployment's established access and retention
policy. If historical credential recovery is required, retain the old
encryption key separately in protected offline storage, then remove it from
the running deployment. Never copy keys or decrypted values into repository
files, logs, or documentation. Environment-referenced provider credentials were
never stored in these tables; their lifecycle stays with the deployment's
secret store. After the retention period, archive disposal requires a separate
reviewed database migration and coordinated backup/key disposal. This release
does not silently purge retained credentials or historical evidence.
