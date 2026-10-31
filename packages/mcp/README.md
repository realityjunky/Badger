# `@realityjunky/badger-mcp`

The local Badger MCP runs over stdio and connects to one deployment through
its HTTP API. It delivers the expert (#54), engineer (#55), and Operator installation (#64)
profiles, local Run tools (#65), dashboard gate delivery (#66), and Run integrity
and recovery reporting (#67). The service owns roles,
questionnaire records, Skill identities, and sign-offs.

Build and install the local command from the repository root:

```bash
npm install
npm run build
npm link -w packages/mcp
```

Alternatively launch `node /absolute/path/to/Badger/packages/mcp/dist/src/cli.js`.
The dashboard's **Settings → Personal access tokens → Connect your Agent**
offers configuration for Claude Code, Codex, and WorkBuddy. Set:

| Environment variable | Meaning                                                                                                                                                                                                                                                                            |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BADGER_URL`         | The deployment URL, including its base path, such as `https://badger.example/team`. HTTPS is required except on loopback HTTP addresses.                                                                                                                                           |
| `BADGER_TOKEN`       | A personal access token created in the dashboard, normally with the `expert` scope.                                                                                                                                                                                                |
| `BADGER_AGENT_HOST`  | The Agent host, 1 to 200 printable ASCII characters. The MCP sends it with every request, and the service requires it and records it in the audit of each one. Defaults to this machine's hostname, in IDNA form if it is not ASCII, or `unnamed-host` when neither form is valid. |
| `BADGER_MCP_PROFILE` | `auto` (default), `engineer`, `expert`, or `operator`. Profile selection only narrows the tools allowed by current roles and token scopes.                                                                                                                                         |

The MCP never prints configuration or credentials. Stdout carries only MCP;
startup failures go to stderr and name the setting at fault, never its value.
Redirects are refused so a credential cannot follow a redirect to another
deployment. For Codex's stdio environment format, see the
[official MCP documentation](https://developers.openai.com/codex/mcp). The
Claude Code configuration goes in `.mcp.json`, which teams often commit, so it
reads the token as `${BADGER_TOKEN}` from the environment that starts Claude
Code instead of holding it.

| Tool                   | Behavior                                                                                                                                                                                           |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `whoami`               | Read the token owner's identity and scopes.                                                                                                                                                        |
| `inbox`                | Read a bounded page of inbox items, with absolute dashboard links and the service's next cursor.                                                                                                   |
| `my_questions`         | Read current assigned questions, own answers, and comments, optionally for one workflow version.                                                                                                   |
| `save_answer`          | Save the user's answer with the answer and question revisions just read: `text` for free text, `value` for other answer types, and `attachments`. First drafts use answer revision `0`.            |
| `upload_attachment`    | Upload a local file the user chose for an assigned question and return its attachment receipt. It stays private until a submitted answer lists it.                                                 |
| `submit_answer`        | Submit a saved answer with its current revisions. The service marks it as sent through an Agent and records the Agent host.                                                                        |
| `comment`              | Add the user's words to a question's thread.                                                                                                                                                       |
| `raise_concern`        | Send volunteered workflow knowledge to the Engineer.                                                                                                                                               |
| `upload_skill_version` | Preview a local folder; upload only with `confirmed: true` and the preview's `expectedHash`.                                                                                                       |
| `open_dashboard`       | Return a dashboard link for a person to confirm, acknowledge, dispute, approve, publish, or answer a gate. Offer URL-mode elicitation when the host supports it. Opening the link never signs off. |

Tool discovery reads the service's current role and scope capabilities, and
a call reuses a read from the last 30 seconds, because every read is a
rate-limited token request. Each HTTP request is still checked by the service
against the person's current roles, the token's scopes, and its target's
permissions and revisions. A refused call, or a call to a tool missing from
the recent read, rereads the capabilities, and when the permitted tools change
the MCP sends `notifications/tools/list_changed`. A token never signs off.

A refused call returns the status, the error kind (`invalid`, `denied`,
`rejected`, `conflict`, or `unavailable`), and the facts needed to retry, such
as a conflict's `currentRevision` or the rate limit's `Retry-After`. Requests
time out after 30 seconds; an upload allows another second for every 64 KiB it
sends. A write that times out may still have been saved, and the tool says so:
an identical Skill upload returns the existing version, and a repeated
attachment upload stores another private copy. Server instructions require
Agents to submit only what the user said, and only when instructed to save or
send it. A host accepting a URL elicitation does not constitute approval.

Questions from `my_questions` carry their `answerType`; a question without one
takes free text. `save_answer` sends free text as `text` and other types as
`value`, using the service's shapes: one of the question's options, an array
of distinct options, `true` or `false`, a number in the question's unit, or
table rows matching its columns. `attachments` lists the IDs of every
attachment the draft keeps, so a save without it keeps none; a file question
needs one before submission. The service validates values and attachments
against the current question revision, as it does for the dashboard.

`upload_attachment` takes the `questionRevision` just read and a local `file`,
with an optional `name` (the file's base name by default) and `mediaType`
(inferred from `.txt`, `.csv`, `.json`, `.pdf`, `.png`, `.jpg`, or `.jpeg`).
Before sending a byte, the MCP checks that the person is a current assignee of
that revision, that the service allows the type, and that the regular file is
within the service's per-file size limit; symbolic links and special files are
refused. The service validates the content and returns an immutable
`{attachment: {id, name, mediaType, size, hash}}`. Attachments are examples
only and must never contain real data.

## Engineer drafting

Use a token with the `engineer` scope and a workflow's Engineer role (or an
Administrator). The engineer profile keeps `whoami`, `inbox`, and
`open_dashboard`, and adds these tools. All version tools take `workflowId`
and `versionId`; job tools also take `jobId`.

| Tool            | Behavior                                                                                                                                                                                   |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `list_jobs`     | Read jobs, leases, and suggestions for one workflow version.                                                                                                                               |
| `claim_job`     | Quote the queued job's `revision`; claim it and return a private local folder with `context.json`, `job.json`, `output-schema.json`, `claim.json`, and `skills/<skillId>/<versionHash>/…`. |
| `submit_job`    | Supply the claimed `folder`. Read its `result.json`, validate against the schema reloaded from the service, then submit suggestions.                                                       |
| `release_job`   | Supply the claimed `folder` to return this token and Agent host's lease to the queue.                                                                                                      |
| `questionnaire` | Read the workflow version's questionnaire, including draft questions and submitted suggestions.                                                                                            |
| `ledger`        | Read the kernel's five-part ledger and optional `sinceRound` changes.                                                                                                                      |
| `readiness`     | Read the kernel's blockers by dossier topic.                                                                                                                                               |

A signed-in Engineer requests drafting from
**Questionnaire → Drafting jobs and suggestions**. Source study also links there
from the Workflow version. Question drafting and follow-ups choose a draft round;
follow-ups also name a published parent. The other kinds are `source-study`
(one pinned Skill), `restate-answer` (an answered question), `translate-question`
(a question and target locale), and `import-open-questions` (a pinned Skill and
draft round). The claim response and `job.json` identify those targets.
The folder holds only the pinned Skills the job's kind reads, which the claim
result's `skills` lists: the job's Skill for source study and imports, every
pin for question, follow-up, and plan drafting, and none for restatement and
translation. Before writing anything, claiming verifies the context hash and
every file against its pin's inventory, and refuses any path with a `.git`
component in any letter case, as a folder or a file, including spellings that
HFS+ or Windows file systems resolve to `.git`, so Git never finds a repository
configuration it would run; a refused claim is released. Files
never execute. Folders use mode `0700`, files `0600`, and the files persist
across MCP restarts so the Agent can resume with the same deployment, person,
token, and host. Delete the folder when finished; it contains workflow
evidence. General large-result files remain connection-local.

Write `result.json` using the claimed job's `output-schema.json`. Question jobs
use `{"questions":[…]}`; source study uses `{facts, interfaces}`; restatement uses
`{facts: [{text, answers: [{personId, revision}]}]}`; translation uses
`{text, rationale}`; imports use `{questions: [{number, source, question}]}`.
Source citations bind the pinned Skill hash, file hash, path, and line range.
Restatements use the Workflow version's locale and exact submitted answer
revisions; acceptance still leaves expert acknowledgement outstanding.
Each question needs text, topic, targets, rationale, evidence, assignees, and
priority. A result is limited to 1 MiB and 20 questions (or 100 source facts,
100 interfaces, or 100 restatement facts). Local reads refuse
symbolic links and special files. The service validates the schema again.
A claim's Skill files total at most twice the deployment's
`BADGER_UPLOAD_MAX_BYTES`, so any two Skill versions within the upload limit
fit. Leases last 30 minutes and are bound to the claiming person, token, host,
and lease ID. Expired leases return to the queue on the next job or Engineer
questionnaire read. At the same boundaries, a change to a job's inputs, the
part of the context its kind's result depends on, cancels it when queued,
claimed, or submitted; other changes, such as a comment, leave it pending. The
old lease cannot submit after expiry, release, or re-claim.

Plan drafting (#58) uses the same tools. The Engineer requests **Plan versions
→ Request plan draft** after the Workflow owner approves the dossier. A
`draft-plan` context includes `planning.input` with the approved dossier and
pins, `planning.skeleton`, and `planning.basePlanVersionId`. Complete the
skeleton and write `result.json` as `{"plan":{…}}` using the supplied schema.
Submission returns a dashboard link to the workflow's `#plan` panel. A signed-in
Engineer reviews and accepts or edits the suggestion before it becomes a Plan
version; the Workflow owner then approves it separately. Agents cannot save,
accept, or approve plans. A changed planning input or a newer Plan version
cancels pending drafts.

The claimed `job.json` identifies the job kind, selected draft round, and parent question, if any. Submission returns a dashboard review link and creates suggestions and an inbox item for the requester. Use `open_dashboard` with `action: "review_suggestions"` to offer that link through URL elicitation when the host supports it. It
creates no Question, Fact, resolution, or publication. The Engineer reviews,
edits, removes suggestions from the batch, or discards the batch with a
reason in the dashboard. Acceptance creates draft questions in the selected
round, preserving the parent link for follow-ups. Publishing the round and
resolving its parent remain separate people-only actions. Review decisions
bind the exact result, edits, and current input hashes. The MCP has no
acceptance, rejection, or sign-off tool.

For an upload, provide the existing `skillId`, local `folder`, and a `scripts`
map from each script path to the kernel's supported side effects, such as
`{"scripts/check.py": ["none"]}`. The preview creates no immutable version.
After the user reviews it, repeat with its hash and confirmation. Changed
files fail the service's hash check. A metadata-only inspection of the entire
folder refuses any path segment that names Git metadata, by the rule claimed job
folders use and the service applies to uploads: `.git` in any letter case,
including spellings that HFS+ or Windows file systems resolve to `.git`, and
including an empty `.git` directory. It refuses before any file contents are
read or upload requests are sent. Upload the Skill without its `.git` folder,
for example from `git archive` output. Symbolic links and special files are refused; the service's file, total-byte, and file-count limits are also checked
locally before transfer. Files never execute, and real data must not be uploaded.

Tool results, including their MCP envelopes, stay within 8 KiB. Larger results
return a private local JSON file path and a `badger://results/…` resource link.
Read the file with the host's file tools, or use `resources/read`;
read operations reload current records, and mutation responses check current
target access without repeating the mutation. Resources last for the connection,
with at most 32 retained results and a 16 MiB retention budget. Narrow requests
whose content exceeds 16 MiB. Temporary result directories use mode `0700`
and files use `0600`; normal connection closure removes them. A local file
is the snapshot already delivered to the person; resource reads recheck access
and reload current records. Resources, prompts, and elicitation are optional.

## Host compatibility

| Host        | OS / app version  | Stdio tools | Prompts | Resources | URL-mode elicitation | Application evidence |
| ----------- | ----------------- | ----------- | ------- | --------- | -------------------- | -------------------- |
| Claude Code | Pending           | Pending     | Pending | Pending   | Pending              | Not yet recorded     |
| Codex       | Pending           | Pending     | Pending | Pending   | Pending              | Not yet recorded     |
| WorkBuddy   | macOS / pending   | Pending     | Pending | Pending   | Pending              | Not yet recorded     |
| WorkBuddy   | Windows / pending | Pending     | Pending | Pending   | Pending              | Not yet recorded     |

The application table records observed host behavior separately from SDK tests.
Follow the [laptop validation procedure](../../docs/laptop-host-validation.md)
and link a completed, versioned record before replacing a pending result.
Installer locations and token forwarding are documented in the
[host adapter](../hosts/README.md#host-locations-and-token-forwarding).

`npm run test:laptop -w packages/mcp` checks both in-memory and production stdio
execution, including installer-generated WorkBuddy configuration, Completion,
roots, receipts, routes and Cycles. The separate `badger-mcp-host-check` stdio
executable probes tools, prompts, resources and URL elicitation in each app
without deployment credentials. Its report records which features the client
actually requested and the negotiated URL capability. The production MCP does
not advertise prompts; hosts without URL elicitation receive an ordinary
dashboard link, and large results have a private local file fallback.

Tests use an in-memory MCP client connected to the real service harness,
through `@realityjunky/badger-server/testing`, and exercise the real stdio
entry point. Run `npm test -w packages/mcp` after building the workspaces.
The same tests use Postgres when `BADGER_TEST_DATABASE_URL` is set.

Authoring lanes and review votes also appear in the engineer job tools (#61).
`claim_job` writes the kernel's bounded handoff files under `inputs/`, verifies
their hashes against `context.json`, and includes the pinned source Skills as
usual. Submit `{ "laneOutput": ... }` in `result.json`; the service validates
it through the kernel. The result remains a draft and links to the workflow's
Package page for human acceptance. Engineers request ready lanes, accept or
reject results, and confirm assembly in that page; those actions are never
MCP tools. NEEDS_CONTEXT and BLOCKED remain explicit outcomes, with the kernel's
question or repair requirement; never guess missing context to report DONE.

The Engineer profile's read-only `evaluation_status` tool returns worker progress,
immutable evaluation history, the passing report for the current package hash,
kernel publication readiness, and a dashboard link. It requires the Engineer
role/capability and an `engineer` token scope. Starting an evaluation stays with
a signed-in person in the dashboard.

## Published workflow installation (Operator profile, #64)

Set `BADGER_MCP_PROFILE=operator` for the small installation profile, or `auto`
for all permitted tools. The token needs `operator` scope plus an Operator,
Engineer, or Administrator role on a visible Workflow. The service capability
`installPublished` controls discovery; every publication request rechecks access.

- `list_published_workflows({workflowId?})` lists visible workflows with immutable
  publications, or the selected workflow's published versions.
- `install_workflow({workflowId,publicationId,packageHash,target,command?})` previews
  verified local installation. `target` supplies `host` (`claude`, `codex`,
  `workbuddy`), `scope` (`project`, `user`), and absolute `projectRoot`/`homeRoot`.
- After the person reviews every operation and explicitly confirms, call
  `install_workflow({workflowId,previewId,digest,confirmed:true})`. It commits only
  this connection's exact preview and rechecks service access and published bytes.
- `uninstall_workflow({workflowId,target})` previews removal of the currently
  verified owned installation. Confirm through
  `uninstall_workflow({workflowId,previewId,digest,confirmed:true})`.

Preview plans use private temporary directories/files (`0700`/`0600`) and are
removed on commit or connection closure. Unknown or modified files and MCP
entries are refused. Badger MCP configuration reads `BADGER_TOKEN` from the
Agent host's environment: Codex forwards `env_vars = ["BADGER_TOKEN"]`; Claude
Code and WorkBuddy expand `${BADGER_TOKEN}`. Codex's environment table never
contains a token placeholder or value. Project/user paths, local CLI setup and
limitations are documented in [the hosts workspace](../hosts/README.md). The
dashboard uses the same renderer and supplies local preview commands; it cannot
install to a browser person's computer. These tools never approve or publish.

## Operator Runs

The Operator profile offers `whoami`, `inbox`, published workflow installation,
`start`, `next`, `submit`, `status`, `recover`, and `my_runs`. An Engineer can use
these Run tools with an `engineer` token for `testRun:true`; production Runs
require an Operator role and `operator` scope. The service checks the current
workflow role and scope on every request. Revoked access is refused; a connection
that already checked its exact binding may continue locally through connection
failures, timeouts, HTTP 429 token rate limits, and HTTP 502/503/504 outages and
retry reporting when the service returns. A rate limit is never a denial: it keeps
the successful check, and a binding never checked in this process fails with the
service's message. An authorization denial, identity mismatch, or other
non-retryable failure clears the successful check; a fresh successful service
check is required before outage continuation becomes available again.

Before starting, call `status` with `workflowId`, `publicationId`, `packageHash`,
`projectRoot` (an absolute local directory), and a new `runId`. Its
`startRequirements` is the unchanged WorkflowRuntime reply. Ask the person for
each declared external directory, and confirm those directories with them.
`start` takes the same identifiers, `hostLabel`, `confirmed:true`, optional
`testRun` (default false), and optional `externalRoots: {name: absoluteDirectory}`.
Only `start` accepts root bindings. Runtime refusals are returned unchanged and
create no service Run registration.

`next`, `status`, and `recover` take `projectRoot` and `runId`. Replies include the
unchanged `continuation`, the current Node's local `skillPath`, and `runUrl`.
`continuation.completion` comes from the kernel's Completion plan, including full
Output Schemas, required Skill Calls, augmentations and guardrails. `submit`
takes the same location and a machine `submission`: the action, Run, revision,
Node, execution identity, status, summary, evidence and routing read from the
continuation. WorkflowRuntime enforces Completion and legal transitions.
Decision/reviewer attestations, repair overrides, manual-stop decisions, human
verification and finalization confirmations are excluded from Agent submissions.
Human gates return a Run dashboard link. A person holding the published policy's
required authority reviews and confirms their answer there. On the next `next`
or `status` call, the MCP delivers the service-attested answer to WorkflowRuntime
only if its Run revision and pending action still match. Changed finalization
effects require another review. Concurrent delivery and reconnects preserve one
committed answer. `status` can therefore advance a Run after human sign-off.

Published bytes are verified by the kernel snapshot hash and installed under
`<project>/.badger/packages/<hash>`. Runtime state stays authoritative under
`<project>/.badger/runs/<runId>`. A pre-start identity intent and private Run
binding fix the service URL, person, machine label, Agent host, publication and
package hash. No token is stored. The durable queue is `.badger/mcp-queue.json`
inside the Run root. Every reporting attempt reconciles against the kernel's
committed event stream, including a crash between runtime commit and queue write.
Events retain their original sequence and bytes; the service stores each
sequence once and refuses gaps or changed duplicates. Events are sent before the
snapshot, in batches of at most 64 and about 768 KiB. Reporting runs in the
background and retries with a 1 to 30 second backoff and on later calls; MCP close stops and drains
retry work. A rate limit pauses all background reporting until its
`Retry-After`. A report reuses the access check that its tool call made within
the last 30 seconds and registers again only after installed bytes change or an
attempt fails; the service still authorizes every request, and a denial clears
the successful check. `status.reporting.error` describes a reporting refusal without
changing runtime authority. Reconnect and call `status` or `recover` to resume
reporting a known Run. Files and ancestors reject symlinks/junctions and lexical
traversal; another deployment or person cannot reuse the binding.

Service observer bounds are 2 MiB per report request, 256 KiB per event, and 1 MiB
per snapshot pair; oversized reports remain local with an explicit reporting
error. Lists show the newest 100 authorized Runs. Outcome summaries retain the
latest 256 entries with explicit total/returned/omitted counts. Run detail pages
through every original event, 500 at a time, using `afterSequence`; the dashboard
offers first/next page controls. Full events remain in the authoritative local
Run and immutable service records. These APIs validate sequence, identity,
structure and size; dashboard gate attestations preserve the person's sign-off
without making the service an execution authority.

The dashboard marks Runs needing recovery and displays service integrity
findings for unattested decisions, missing event sequences, and mismatched
published execution identities or installed package bytes. Changed installed
bytes are reported once and do not stop mirroring; the finding stays until the
MCP observes the published bytes again. Use `recover` on the Run's own computer;
WorkflowRuntime remains the only recovery authority. Recovery notices and
request IDs are persisted separately in `.badger/mcp-recovery.json` inside the
Run root, including when an interrupted transition prevents normal reporting.
They survive service outages and reconnects and are reported with the next
complete mirror. The dashboard shows a settled or blocked outcome and the
reported revision and event cursor. Integrity findings and outcomes are audited.
A local recovery cannot manufacture a missing human gate answer, so unresolved
attestation findings remain visible.

Service evaluation runs the trusted installed `certification.js` child inside the
existing time, process-tree memory, private temporary-directory and scrubbed
environment limits. It uses real in-memory MCP SDK calls against a loopback HTTP
fixture, starts the exact selected package bytes, then exercises synthetic
Completion, skipped-Node, route, Cycle and external-root receipt cases. Domain
scripts are never run. The report retains `mcp-runtime-certification` and its
`BadgerMCP` evidence alongside script certification. The kernel accepts a trusted
host certifier callback and has no dependency on the MCP workspace.
