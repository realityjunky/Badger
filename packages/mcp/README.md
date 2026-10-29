# `@realityjunky/badger-mcp`

The local Badger MCP runs over stdio and connects to one deployment through
its HTTP API. It delivers the expert profile (#54); the engineer and operator
profiles and the host installer remain planned. The service owns roles,
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

| Environment variable | Meaning                                                                                                                                  |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `BADGER_URL`         | The deployment URL, including its base path, such as `https://badger.example/team`. HTTPS is required except on loopback HTTP addresses. |
| `BADGER_TOKEN`       | A personal access token created in the dashboard, normally with the `expert` scope.                                                      |
| `BADGER_AGENT_HOST`  | Optional attribution for answers; defaults to this machine's hostname.                                                                   |

The MCP never prints configuration or credentials. Stdout carries only MCP;
startup failures go to stderr. Redirects are refused so a credential cannot
follow a redirect to another deployment. For Codex's stdio environment format,
see the [official MCP documentation](https://developers.openai.com/codex/mcp).

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

Tool discovery and every call check the service's current role and scope
capabilities. Each HTTP mutation also enforces its target's permissions and
optimistic revisions. A token never signs off. Server instructions require
Agents to submit only what the user said, and only when instructed to save or
send it. A host accepting a URL elicitation does not constitute approval.

For an upload, provide the existing `skillId`, local `folder`, and a `scripts`
map from each script path to the kernel's supported side effects, such as
`{"scripts/check.py": ["none"]}`. The preview creates no immutable version.
After the user reviews it, repeat with its hash and confirmation. Changed
files fail the service's hash check. Symbolic links and special files are
refused; the service's file, total-byte, and file-count limits are also checked
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
| Claude Code | `.mcp.json`, generated JSON checked in the browser journey                                          | Real SDK stdio client verified; application check pending | Optional; local file fallback verified | Capability negotiation and link fallback verified with SDK; application support unverified |
| Codex       | `~/.codex/config.toml`, generated from the official stdio format and checked in the browser journey | Real SDK stdio client verified; application check pending | Optional; local file fallback verified | Capability negotiation and link fallback verified with SDK; application support unverified |
| WorkBuddy   | MCP server JSON, generated configuration checked in the browser journey                             | Real SDK stdio client verified; application check pending | Optional; local file fallback verified | Capability negotiation and link fallback verified with SDK; application support unverified |

These checks establish protocol and configuration behavior; they do not claim
manual application validation. Prompts are not required or advertised. Hosts
without URL elicitation receive the same dashboard link as a normal tool result.

Tests use an in-memory MCP client connected to the real service harness,
through `@realityjunky/badger-server/testing`, and exercise the real stdio
entry point. Run `npm test -w packages/mcp` after building the workspaces.
The same tests use Postgres when `BADGER_TEST_DATABASE_URL` is set.
