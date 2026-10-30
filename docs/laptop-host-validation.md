# Laptop and Agent host validation (#68)

Run this procedure on macOS and Windows in WorkBuddy. Check Claude Code and
Codex in their actual applications as well, recording the OS and app version
for each. Results belong in the
[host compatibility table](../packages/mcp/README.md#host-compatibility).
Application checks remain pending until a person records them. An SDK client
establishes protocol behavior but cannot establish an application's support.

## Build and run the portable checks

Use Node 22 or later and the candidate Badger revision:

```sh
npm ci
npm run build
npm run test:laptop -w packages/mcp
git rev-parse HEAD
```

The portable suite runs the same runtime certification over an in-memory MCP
connection and the production stdio executable. In stdio mode the installer
previews and commits a WorkBuddy entry in a temporary project, then the SDK
launches that exact entry. Paths contain spaces and Unicode. Checks cover
external root binding, receipts, skipped Nodes, missing Completion, illegal
routes, exhausted Cycles, recovery and package identity. All data is synthetic.

The Linux full suite additionally runs `test/laptop.test.ts` against the real
service and an immutable publication, comparing the complete committed event
stream and projection, including artifact receipts. That test needs the service's
Linux evaluation sandbox; the portable suite uses a synthetic HTTP service and
does not invoke that sandbox. These checks do not replace the application Run
below. The optional macOS/Windows CI job also runs the portable suite when
`BADGER_CI_CROSS_PLATFORM` is enabled; see [CI setup](self-hosted-ci.md).

## Measure optional MCP features in each application

The separate `badger-mcp-host-check` executable provides synthetic tools, a
prompt, a resource, and URL elicitation. It uses no deployment, token or local
files. The production Badger MCP does not advertise prompts.

Find Node's absolute executable with `node -p 'process.execPath'`. In the host's
MCP settings, add a temporary server named `badger-host-check`. Merge only that
entry into existing configuration. For JSON hosts:

```json
{
  "mcpServers": {
    "badger-host-check": {
      "type": "stdio",
      "command": "/absolute/path/to/node",
      "args": ["/absolute/Badger/packages/mcp/dist/src/host-check-cli.js"]
    }
  }
}
```

On Windows, use the real `node.exe` path and escape backslashes as JSON requires,
or use forward slashes. Keep paths as individual arguments, even with spaces.
For Codex, use its active configuration's TOML form:

```toml
[mcp_servers.badger-host-check]
command = "/absolute/path/to/node"
args = ["/absolute/Badger/packages/mcp/dist/src/host-check-cli.js"]
```

Reload the server in the named application and perform these checks:

| Feature         | Action and evidence                                                                                                                                                                                                      |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Stdio tools     | Call `host_check_report` from the application's Agent. Record its client name/version and the actual app version from its About/version screen.                                                                          |
| Prompts         | Select `host_check_prompt` using the application's prompt interface. Confirm `Badger host prompt check: BLUE-17` is visible and the next report has `promptRequested: true`. Record an unavailable interface explicitly. |
| Resources       | Open `badger-host-check://example` using the application's MCP resource interface. Confirm `Badger host resource check: ORANGE-42` is visible and the next report has `resourceRead: true`.                              |
| URL elicitation | Call `host_check_url`. Observe whether the app offers the URL interaction and can open the public MCP documentation. Decline or cancel a second request and confirm the same URL remains in the tool result.             |

Call `host_check_report` again and save its JSON with the record below. A
`not_advertised` outcome means this client did not advertise URL mode. `failed`
means the advertised request failed or timed out after 30 seconds; record the
observed error. An `accept` result alone does not prove that a browser opened.
Prompt/resource lists alone do not prove that the application can use them.
Missing optional features do not prevent Runs: ordinary links and private local
result files remain available. Remove the temporary probe entry afterwards.

## Install and run a publication in WorkBuddy

Use a validation deployment and a published workflow over synthetic inputs.
Keep its Workflow ID, publication ID and package hash fixed across the Linux,
macOS and Windows checks. The person needs Operator access and an
Operator-scoped personal access token. Set `BADGER_TOKEN` through a local masked
prompt or the machine's credential helper; keep it out of commands and files.

Fully quit WorkBuddy and launch its installed executable from the environment
holding `BADGER_TOKEN`. A desktop launcher or an already running app may not
inherit that environment. Verify expansion in the app with `whoami` below.

Create an empty project with spaces and Unicode in its path, such as
`Badger laptop check 运行`. From the built Badger checkout, preview installation
with absolute paths. On macOS (Bash/zsh):

```sh
node packages/hosts/dist/src/cli.js preview-install \
  --url https://badger.example/team \
  --workflow WORKFLOW_ID --publication PUBLICATION_ID --package-hash SHA256 \
  --host workbuddy --scope project \
  --project "/absolute/Badger laptop check 运行" \
  --command "$(node -p 'process.execPath')" \
  --arg "/absolute/Badger/packages/mcp/dist/src/cli.js"
```

On Windows (PowerShell):

```powershell
$badgerNode = node -p 'process.execPath'
& $badgerNode .\packages\hosts\dist\src\cli.js preview-install `
  --url https://badger.example/team `
  --workflow WORKFLOW_ID --publication PUBLICATION_ID --package-hash SHA256 `
  --host workbuddy --scope project `
  --project 'C:\absolute\Badger laptop check 运行' `
  --command $badgerNode `
  --arg 'C:\absolute\Badger\packages\mcp\dist\src\cli.js'
```

Inspect the preview and confirm its exact digest in a separate command:

```sh
node packages/hosts/dist/src/cli.js commit --plan PLAN_FILE --digest PREVIEW_DIGEST --confirm
```

The same `node ... commit` form works in PowerShell; quote the returned plan
path. The printed `commitCommand` uses POSIX shell quoting, so use the explicit
Node form above in PowerShell. Do not add a shell around the MCP entry itself.

Open the project in WorkBuddy. Check the app's MCP settings and record:

- The configuration path the app actually reads. Compare it to the installer's
  `.mcp.json` at project scope or `~/.codebuddy/.mcp.json` at user scope.
- Local/stdio transport, the absolute Node command, the separate CLI argument,
  `BADGER_MCP_PROFILE=operator`, deployment URL and `${BADGER_TOKEN}` reference.
- The installed `.codebuddy/skills/badger-WORKFLOW_ID` is discoverable.

If the app uses a different path, schema, transport or environment expansion,
record the mismatch and keep that acceptance item failing. Editing files by
hand would not validate what the installer writes. Repeat at user scope with
`--scope user`, previewing each change. Use the same target scope for removal.

Drive the real Badger MCP from WorkBuddy and save the observed results:

| Check                                         | Expected result                                                                                                                                                                                        |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `whoami`, `inbox`, `list_published_workflows` | Correct person, Operator token scope and the selected immutable publication; no human approval tools.                                                                                                  |
| `status` before `start`                       | The runtime's external root requirements. Missing required bindings refuse start without registering a Run.                                                                                            |
| `start` after explicit local confirmation     | The exact publication starts with a unique Run ID, a machine label and fixed root bindings.                                                                                                            |
| `next` and `submit`                           | Read the current Node Skill and Completion plan. A skipped Node is refused; missing required evidence or output blocks progress. Read the current revision again before retrying.                      |
| Routes and Cycles                             | If the published workflow declares them, an illegal route and an exhausted repeat are refused. The portable certification also checks both on every tested OS.                                         |
| Completion                                    | Produce the synthetic required outputs and submit only observed evidence until disposition is `done`. People answer any human gates in the dashboard.                                                  |
| `status`, `my_runs` and dashboard Run page    | The same package hash, person, host label, Agent host, Node, Attempts, findings, artifact receipts and ordered event sequence. Reporting catches up without gaps or duplicate transitions.             |
| Restart and recovery                          | Quit/reopen the app, reconnect to the same deployment/person, and inspect the same Run. `recover` preserves committed state; it does not answer a human gate.                                          |
| Uninstall                                     | Preview and separately confirm `preview-uninstall --workflow WORKFLOW_ID --host workbuddy --scope project --project PROJECT_PATH`. The owned package/entry are removed and unrelated settings survive. |

Do not infer Completion evidence or gate answers to finish a check. Runs that
wait for unsupported gate delivery remain pending, with their dashboard link
and the blocking issue recorded.

## Acceptance record

Copy this record once per host/OS, with separate WorkBuddy records for macOS and
Windows. Keep credentials and unrelated MCP entries out of evidence.

```text
Date / tester:
Badger commit / Node version / OS version and architecture:
Host application / actual app version:
Probe-reported client name and version:
Portable suite command and result:
Project and user configuration paths observed in the app:
Transport / command / args / token reference matches installer:
Stdio tools result:
Prompt result and observed marker:
Resource result and observed marker:
URL advertised / accept / decline or cancel / link fallback / browser observation:
host_check_report JSON:
Workflow ID / publication ID / package hash:
Local Run ID / service Run ID / host label / Agent host:
Run completion, refusal, recovery and reporting observations:
Dashboard event/Attempt/finding/receipt comparison:
Install and uninstall preservation results:
Evidence links and remaining failures:
```

Update the compatibility table with the measured result, app/OS version and a
link to the completed record. Issue #68 remains open until both WorkBuddy Runs,
the installer/app comparison and all three hosts' feature records exist.
