# Bound Server-side Script Suggestions to Validated Upload Previews

Status: accepted. Implements [#95](https://github.com/realityjunky/Badger/issues/95)
within the collaborative service scope of #24. ADR 0005 deferred a general
server-side drafting runner because Engineers already connect their own Agents.
This decision permits one narrower server-side call: a fixed structured task
that suggests script side effects before a person confirms a Skill upload.
It does not introduce a general Agent, conversation, tool runner, workflow
authoring authority, or runtime authority.

The kernel still validates source inventories and immutable source identities.
Only validated uploaded bytes, including bundled scripts, wrappers,
configuration and references, enter the text-only task. They are untrusted
static evidence and never execute. A bounded temporary database snapshot
binds each request and result to the uploader, Skill, source hash, script
paths and hashes, task prompt hash, model profile hash and accepted
configuration revision. A changed source invalidates earlier previews; a
changed configuration invalidates in-flight results. The dashboard does not
overwrite declarations that a person edited while the call was pending.

An Organization Administrator manages connections, model descriptors,
function assignments and task prompts through the dashboard or an explicit
external-file import. One revisioned database record is authoritative for
all server and worker processes. File imports and dashboard saves use the
same validator and compare-and-swap revision. A restart preserves accepted
dashboard edits and never reimports a stale startup file. Configuration and
prompt writes append secret-free Activity records in the same transaction.

API keys live in authenticated AES-256-GCM encrypted storage under a
deployment-owned encryption key, or in explicitly named protected environment
references. APIs return only references and configured status. Keys are
write-only, preserved by ordinary saves, and replaced or cleared explicitly.
The provider transport follows deployment proxy settings and never returns
remote errors or credentials. Network calls have distributed concurrency
leases, input/output bounds and a deadline, with no automatic retries.

The task prompt is inspectable at upload time and editable only in
Administration. The server independently enforces the JSON response schema,
allowed effects, exclusive `none`, script identity and source citations.
Missing evidence, missing configuration and provider errors preserve manual
declarations. Suggestions remain drafts and never create a Skill version or
sign off on declarations. A person's explicit hash-bound immutable upload
confirmation remains the only write path, including its existing conflict
rule for identical source with different declarations.

## Considered Options

- Require an Engineer's connected Agent for this inventory task. Rejected:
  uploaders may be Field experts without a connected Agent, and the task
  needs no conversation or host filesystem access.
- Let each process read a mutable configuration file as its live authority.
  Rejected: processes can observe different revisions and dashboard saves
  can disappear after restart. The file is an explicitly accepted revision
  of the same durable configuration instead.
- Infer missing script declarations as `none`, execute scripts, or accept
  model output directly as an immutable version. Rejected: absent evidence
  is not harmless behavior and model output cannot replace a person's gate.
