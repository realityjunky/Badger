# LLM configuration and script side-effect suggestions

An Organization Administrator opens **Administration → LLM configuration**.
Group leads, workflow roles, Auditors and personal access tokens cannot read,
edit, reload or test these settings through the dashboard or direct API.

## Set up a connection

1. Import the model profiles from
   [`packages/server/config/llm.example.json`](../packages/server/config/llm.example.json),
   or add a connection. Importing profiles adds models and preserves existing
   models, assignments and prompts; duplicate identifiers are refused.
2. Enter the deployment's LiteLLM API base URL, including its `/v1` prefix
   when applicable. Badger appends `/chat/completions`. Use HTTPS; loopback
   HTTP is supported for local testing. URLs cannot contain credentials,
   query parameters or fragments.
3. Configure a protected secret reference such as
   `env:BADGER_LLM_SECRET_FLASH`, or choose **Replace key** after the operator
   enables encrypted storage. Save preserves an existing key unless Replace
   or Clear is selected. Keys never return in configuration reads or exports,
   and the dashboard stores no key in browser persistence.
4. Choose an enabled model under **Function-to-model assignments → Script
   side-effect suggestion**, inspect **Task prompts**, and save.
5. **Test saved connection** sends a synthetic JSON task with the exact saved
   model settings. Unsaved changes must be saved before testing. A successful
   response proves that the request and JSON response succeeded, not that a
   proxy honored every provider option. Record live verification separately.

Model identifiers are stable. Disable a connection to stop using it without
losing its settings. Function assignments use identifiers, so changing the
assigned model needs no code change. Additional function identifiers and
prompts may be preserved in configuration; only `script-side-effects` has a
functioning integration in this release.

## Model descriptors and the supplied DeepSeek profile

The secret-free example contains a selectable `deepseek-v4.1-flash` alias
through LiteLLM, with thinking enabled, input/context budget **500,000 tokens**,
and reasoning effort **Max**. Its API URL and key are deliberately empty.
These deployment choices live in an editable example profile, not application
logic. Other connections can use different descriptors and settings.

Each model's descriptors define the control label, type (`boolean`, `enum`,
`integer`, `number`), default, options/range, and provider request mapping.
The dashboard renders these descriptors and offers an advanced descriptor
editor. Unknown settings, duplicate keys/targets, invalid ranges and invalid
provider values fail validation. Supported request targets are
`thinking.type`, `reasoning_effort`, `temperature`, `top_p` and `max_tokens`.
`context-budget` is a local coverage limit, never an output-token parameter.
Every model must define separate context and output descriptors.

The profile maps thinking to `{"thinking":{"type":"enabled"}}` and Max to
`{"reasoning_effort":"max"}`. It does not use `budget_tokens`, translate Max
to `high`, or assume these parameters work on every compatible endpoint.
DeepSeek thinking rejects temperature/top-p settings. LiteLLM requests include
`drop_params: false` so unsupported parameter handling must fail visibly.

Mapping evidence checked on 2026-11-03 while implementing #95:

- [DeepSeek thinking mode](https://api-docs.deepseek.com/guides/thinking_mode)
  documents `thinking.type` and `reasoning_effort` values `low`, `high`, `max`;
  thinking mode does not support sampling settings such as temperature.
- [LiteLLM DeepSeek adapter](https://github.com/BerriAI/litellm/blob/28c80048ed47d53befd819f22b5ac1bb112ec3fd/litellm/llms/deepseek/chat/transformation.py)
  accepts `thinking.type` enabled/disabled, preserves supported effort when
  thinking is enabled, and explicitly discards a thinking token budget.

Stub-provider HTTP tests verify the exact request fields and their separation
from the input budget. **The deployment alias and actual upstream behavior
are not live-verified.** After the owner enters the URL and key, test the
connection, verify LiteLLM routes that alias to the intended DeepSeek model
without dropping parameters, inspect upstream effective thinking/Max settings,
and record the deployment revision, provider/LiteLLM versions and outcome in
the deployment's own records. No supplied key is required to use manual upload
declarations or to run Badger's tests.

## Durable configuration and file reloads

The shipped [JSON schema](../packages/server/config/llm.schema.json) describes
the version 1 `{revision, configuration}` file. The server build generates it
from the runtime validator's authoritative definition. Runtime validation also checks
descriptor defaults and selected values, referenced model IDs, URL safety and
prompt placeholders. Configuration files contain secret references, never keys.
Treat references and prompts as operator-managed configuration.

Set `BADGER_LLM_CONFIG_FILE` to a readable file. On the first start against an
empty database, Badger imports a valid file with `revision: 0` as accepted
revision 1. Without a file it starts with an unassigned function and useful
default prompt. On subsequent starts the database's accepted revision wins;
the file is not automatically reimported or watched.

For a later file edit, export the accepted configuration in Administration,
edit that complete file while retaining its revision and unrelated models,
settings, bindings and prompts, and replace the configured file atomically.
Then choose **Accept external file revision**. Both the file and request must
quote the current accepted revision. The entire configuration is validated
and accepted atomically, increments the revision, and records its hashes in
Activity. Invalid files and stale file/UI saves change nothing. Reload the
current configuration and reapply edits after a conflict. Dashboard saves
write the same durable database record, without rewriting the external file.

All server and worker processes share the database's accepted revision.
There is no cached worker model configuration or separate drafting queue;
the bounded provider call runs in the HTTP server. Configuration changes
during a call reject its result. Supply the same encryption key, external
secret references and proxy policy to the server roles that make model calls.
Back up the database and encryption key together; never commit that key.

| Deployment setting                      | Purpose                                                                                                                                             |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BADGER_LLM_CONFIG_FILE`                | Optional versioned JSON import file.                                                                                                                |
| `BADGER_LLM_KEY`                        | 32 random bytes encoded as 64 hexadecimal characters, supplied through protected deployment configuration; enables encrypted dashboard key storage. |
| `BADGER_LLM_SECRET_*`                   | Protected external secret values, named explicitly by `env:` references. Other environment variables cannot be referenced.                          |
| `HTTPS_PROXY`, `HTTP_PROXY`, `NO_PROXY` | Provider transport policy; lowercase equivalents take precedence, matching the other service transports.                                            |

The server image ships the schema and example under `packages/server/config/`.
Keep the deployment's actual endpoint, secret values and reload file outside
this repository. TLS verification remains enabled and redirects are refused.

## Task prompts and uploader review

The `script-side-effects` task prompt has a stable function identifier,
description and content hash. Prompt text must contain exactly one `{{source}}` and
one `{{scripts}}`, with no unknown placeholders. The system message independently
fixes the response schema and exactly these effects: `none`, `local-writes`,
`network`, `scheduler-submission`, `installs`. `none` must stand alone.
Prompt edits cannot widen the effect set or bypass confirmation.

After a valid folder, zip or Git preview, the dashboard automatically requests
suggestions when the function has an enabled assigned model. A script-free
Skill makes no provider call. Review progress in the upload dialog, inspect
the active prompt and its hash, read each rationale, and expand citations to
see the exact bundled source lines and file hash. Every suggested declaration
is editable. Scripts omitted by the model or marked uncertain remain
undeclared. A late result does not overwrite a field edited while it ran.

Only validated source inventory files are sent as text. Badger includes the
scripts and their bundled wrappers, configuration and references, never host
directories or protected real data. Source instructions are evidence, not
instructions to the model. Nothing executes. Use synthetic examples only.
Binary/non-UTF-8 evidence or a source set over the configured bound prevents
complete analysis and leaves all scripts for manual review.

Source identity, script file hashes, task prompt hash, effective configuration
revision/hash and model/settings hash bind the request and result. Changing
the selected upload invalidates earlier results. This provenance is temporary
and separate from immutable Skill source identity. All scripts still need a
declaration before **Confirm immutable upload**. Suggestions never create a
version, approve a declaration or bypass the final explicit hash-bound gate.
Identical source with conflicting declarations remains a conflict.

## Limits, failures and API

Defaults: 1 MiB source, 128 KiB provider response (including reasoning text),
60 seconds per provider call, at most 3 concurrent calls deployment-wide and
one per person. There are no automatic retries. Administrators may adjust
these within the shipped schema's hard bounds. Source is never silently
truncated: a conservative UTF-8 byte upper bound for input tokens, including
the serialized prompt/schema request, plus reserved output tokens must fit
the model context budget. Increase that budget or declare scripts manually
when full evidence cannot fit. Output tokens and output bytes are independent
limits. Source snapshots expire after 15 minutes, with at most 10 per person;
new previews clean expired snapshots, and completed results discard source text.

Missing URL/key, disabled models, busy service, timeouts, provider failures,
malformed JSON, invalid enums/citations and incomplete coverage leave manual
declarations available. Remote error bodies are withheld. An unclassified
script never becomes `none`. A connection test or output-byte error can be
resolved by the Administrator; uploaders can continue manually.

- `GET /api/v1/admin/llm`: accepted configuration, revision, hash and masked
  credential status.
- `PUT /api/v1/admin/llm`: `{revision, configuration, secrets?}`; optional
  secret changes are keyed by model ID and are `{action:"replace", value}`
  or `{action:"clear"}`. Omitting changes preserves keys.
- `POST /api/v1/admin/llm/reload`: `{revision}`; accept the configured file.
- `POST /api/v1/admin/llm/test`: `{revision, modelId}`; test saved settings
  with synthetic evidence.
- Existing upload/Git preview responses include `preview.suggestion`, its
  active prompt and revision, and an opaque preview ID when analysis is ready.
- `POST /api/v1/skills/:id/side-effect-suggestions`:
  `{previewId, expectedHash}`; requires the same Group upload permission and
  the preview's original uploader. Replies contain bounded validated drafts
  and provenance, never a stored Skill version.
