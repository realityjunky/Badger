# `@realityjunky/badger-mcp`

The local Badger MCP runs over stdio and connects to one deployment through
its HTTP API. It delivers the expert (#54) and engineer (#55) profiles; the
operator profile and host installer remain planned. The service owns roles,
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

| Environment variable | Meaning                                                                                                                                      |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `BADGER_URL`         | The deployment URL, including its base path, such as `https://badger.example/team`. HTTPS is required except on loopback HTTP addresses.     |
| `BADGER_TOKEN`       | A personal access token created in the dashboard, normally with the `expert` scope.                                                          |
| `BADGER_AGENT_HOST`  | Optional attribution for answers, 1 to 200 printable ASCII characters; defaults to this machine's hostname, in IDNA form if it is not ASCII. |
| `BADGER_MCP_PROFILE` | `auto` (default), `engineer`, or `expert`. Profile selection only narrows the tools allowed by current roles and token scopes.               |

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
| `save_answer`          | Save the user's text with the answer and question revisions just read. First drafts use answer revision `0`.                                                                                       |
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
an identical upload returns the existing version. Server instructions require
Agents to submit only what the user said, and only when instructed to save or
send it. A host accepting a URL elicitation does not constitute approval.

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
draft round). The claim response and `job.json` identify those targets. Claiming verifies the
context hash and every pinned file against its inventory before returning
the folder. Files never execute. Folders use mode `0700`, files `0600`, and
the files persist across MCP restarts so the Agent can resume with the same
deployment, person, token, and host. Delete the folder when finished; it
contains workflow evidence. General large-result files remain connection-local.

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
Pinned Skill bundles are limited to 32 MiB. Leases last 30 minutes and are
bound to the claiming person, token, host, and lease ID. Expired leases
return to the queue on the next job or Engineer questionnaire read; changed
inputs cancel queued, claimed, and submitted jobs at the same boundaries.
The old lease cannot submit after expiry, release, or re-claim.

Plan drafting (#58) uses the same tools. The Engineer requests **Plan versions
→ Request plan draft** after the Workflow owner approves the dossier. A
`draft-plan` context includes `planning.input` with the approved dossier and
pins, `planning.skeleton`, and `planning.basePlanVersionId`. Complete the
skeleton and write `result.json` as `{"plan":{…}}` using the supplied schema.
Submission returns a dashboard link to the workflow's `#plan` panel. A signed-in
Engineer reviews and accepts or edits the suggestion before it becomes a Plan
version; the Workflow owner then approves it separately. Agents cannot save,
accept, or approve plans. Changed inputs cancel pending drafts.

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
folder refuses any `.git` path segment (case-insensitively), including an empty
`.git` directory, before any file contents are read or upload requests are sent.
Upload the Skill without its `.git` folder, for example from `git archive`
output. Symbolic links and special files are refused; the service's file, total-byte, and file-count limits are also checked
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

| Host        | Configuration                                                                                       | Stdio tools                                               | Resources                              | URL elicitation                                                                            |
| ----------- | --------------------------------------------------------------------------------------------------- | --------------------------------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------ |
| Claude Code | `.mcp.json` with `${BADGER_TOKEN}`, generated JSON checked in the browser journey                   | Real SDK stdio client verified; application check pending | Optional; local file fallback verified | Capability negotiation and link fallback verified with SDK; application support unverified |
| Codex       | `~/.codex/config.toml`, generated from the official stdio format and checked in the browser journey | Real SDK stdio client verified; application check pending | Optional; local file fallback verified | Capability negotiation and link fallback verified with SDK; application support unverified |
| WorkBuddy   | MCP server JSON, generated configuration checked in the browser journey                             | Real SDK stdio client verified; application check pending | Optional; local file fallback verified | Capability negotiation and link fallback verified with SDK; application support unverified |

These checks establish protocol and configuration behavior; they do not claim
manual application validation. Prompts are not required or advertised. Hosts
without URL elicitation receive the same dashboard link as a normal tool result.

Tests use an in-memory MCP client connected to the real service harness,
through `@realityjunky/badger-server/testing`, and exercise the real stdio
entry point. Run `npm test -w packages/mcp` after building the workspaces.
The same tests use Postgres when `BADGER_TEST_DATABASE_URL` is set.
