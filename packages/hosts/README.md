# `@realityjunky/badger-hosts`

The local filesystem adapter installs immutable published Badger packages and
Badger MCP configuration. It never approves, publishes, or changes Authoring or
WorkflowRuntime state. The dashboard supplies a publication-bound local command;
the browser and service do not write a person's computer.

Build from the repository root with `npm ci && npm run build`. Make both commands
available with `npm link -w packages/hosts -w packages/mcp`, or launch each built
`dist/src/cli.js` with Node 22+. Linking is a local setup action, separate from
package installation. The installer does not download or execute an MCP binary.

## Local preview and confirmation

Set `BADGER_TOKEN` outside configuration files, in the shell used by the CLI and
the environment that starts the Agent host. Use an Operator-scoped token whose
person holds Operator, Engineer, or Administrator access to the workflow.
Never put the token in a command argument, a preview, a plan, or source control.

Run from the target project. The dashboard's **Install locally** action provides
the exact Workflow, publication ID and package hash. For example:

```sh
badger-hosts preview-install --url https://badger.example/team \
  --workflow WORKFLOW_ID --publication PUBLICATION_ID --package-hash SHA256 \
  --host codex --scope project
```

`--project /absolute/project` and `--home /absolute/home` override the current
directory and operating-system home. Project and user scopes always target their
respective root. `--command /absolute/path/to/badger-mcp` selects an executable
with no shell interpretation; repeat `--arg VALUE` for each executable argument.
For example, `--command /absolute/path/to/node --arg /absolute/Badger/packages/mcp/dist/src/cli.js`
launches the built MCP directly on laptops, including Windows, without a global
npm command shim. Paths with spaces must be one quoted argument. Arguments are
part of the reviewed digest and preserved in uninstall previews.
`--profile operator` is the default.

Preview downloads through the publication API, refuses redirects, verifies the
selected publication identity and bytes using the kernel's snapshot verifier,
then reads local ownership and every destination. It prints all persistent file
writes/deletes and directory creations/removals, expected current hashes, new
content hashes and sizes, the new MCP entry, the package hash, and one digest.
Existing unrelated configuration values never appear in the preview.

The private preview plan uses a `0700` temporary directory and a `0600` file. It
contains published bytes and paths, never the token or copies of pre-existing
configuration. Review the operations before running the printed commit command:

```sh
badger-hosts commit --plan /private/temporary/plan.json --digest PREVIEW_DIGEST --confirm
```

Commit requires both confirmation and the exact digest, takes the selected root's
exclusive lock, `.badger-install.lock`, which every host's commits share,
recalculates the complete preview, and refuses stale content, changed root
identity or unsafe paths before any persistent write. Individual file writes use
the kernel's contained atomic writer and recheck the expected hash. A replaced
file keeps its permission bits, so a private `0600` configuration stays private
after install and uninstall; new files get the default mode. It verifies
the installed directory against the published hash. Successful CLI commits remove
the private plan. Temporary locks and atomic staging files are transient adapter
bookkeeping. A process killed while committing may leave its lock or a partial
installation; inspect the preview and files before manually removing a stale
lock or repairing files. The installer never automatically deletes unknown files
to recover from interruption.

```sh
badger-hosts preview-uninstall --workflow WORKFLOW_ID --host codex --scope project
# Review, then run the returned separate commit command with its digest.
```

Uninstall verifies the entire owned package first. It removes the MCP entry only
after the final managed workflow for this host/scope is removed, retaining every
unrelated setting and other server. Empty parent directories may remain. Modified
packages, extra files, unowned destinations, malformed configurations and
unowned same-name MCP entries are conflicts; review and repair them yourself,
then preview again. There is no force/overwrite switch. JSON is edited without
reformatting unrelated properties; Codex's managed TOML block is appended and
removed while retaining unrelated text, and text added after the block keeps its
own line. A removal whose result does not parse, or still has a Badger entry, is
refused. Unsafe inline TOML layouts are refused.
Claude Code and WorkBuddy project scope share `.mcp.json`, and one host at a time
manages its Badger entry. While one has Badger workflows installed there, the
other refuses and names it rather than silently acquiring ownership; uninstall
them from that host first, or use user scope.

## Host locations and token forwarding

| Host        | Project Skills                         | User Skills                              | Project MCP          | User MCP                 |
| ----------- | -------------------------------------- | ---------------------------------------- | -------------------- | ------------------------ |
| Claude Code | `.claude/skills/badger-WORKFLOW_ID`    | `~/.claude/skills/badger-WORKFLOW_ID`    | `.mcp.json`          | `~/.claude.json`         |
| Codex       | `.agents/skills/badger-WORKFLOW_ID`    | `~/.agents/skills/badger-WORKFLOW_ID`    | `.codex/config.toml` | `~/.codex/config.toml`   |
| WorkBuddy   | `.codebuddy/skills/badger-WORKFLOW_ID` | `~/.codebuddy/skills/badger-WORKFLOW_ID` | `.mcp.json`          | `~/.codebuddy/.mcp.json` |

Codex uses `env_vars = ["BADGER_TOKEN"]`; its environment table holds only the
deployment URL and profile. Claude Code and WorkBuddy use `${BADGER_TOKEN}`
environment expansion. The renderer is also used by dashboard setup, including
escaping executable paths. WorkBuddy's documented CodeBuddy-compatible project
mode and preferred `.mcp.json` locations are used; deprecated `mcp.json` files are
not modified. Codex project MCP configuration requires a trusted project.

References: [Codex MCP](https://developers.openai.com/codex/mcp/),
[Codex Skills](https://developers.openai.com/codex/skills/),
[Claude MCP](https://code.claude.com/docs/en/mcp),
[WorkBuddy project mode](https://www.codebuddy.cn/docs/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/Project),
[CodeBuddy MCP](https://www.codebuddy.cn/docs/cli/mcp).
The filesystem, SDK and browser checks establish adapter/protocol behavior;
they do not claim manual validation in those three host applications.
The [laptop validation procedure](../../docs/laptop-host-validation.md) covers
macOS and PowerShell commands, app configuration checks, actual Runs and a
separate MCP feature probe.

## Public adapter and MCP seam

`previewInstall({target, publication, snapshot, deploymentUrl, command?, args?, profile?})`
and `previewUninstall({target, workflowId})` return a serializable `HostPlan` with
its `preview`. Every `target` supplies explicit absolute `projectRoot` and
`homeRoot`, a `host` (`claude`, `codex`, `workbuddy`) and `scope` (`project`, `user`).
The publication identity is `{workflowId, publicationId, packageHash}`.
`commitHostPlan(plan, {confirmed:true, digest})` returns the verified
`{packageDirectory, packageHash, action}`. Snapshot hashing remains the kernel's
authority. Ownership is stored under `<selected-root>/.badger/hosts/<host>.json`;
it is not a service record or an authoring state.

The `./configuration` export is browser-safe: `renderMcpConfiguration`,
`hostPaths`, `localInstallCommand` and `localUninstallCommand` share the host
contract without importing Node filesystem or kernel modules.

The Operator MCP profile adds `list_published_workflows`, `install_workflow` and
`uninstall_workflow`. A preview requires exact publication identity and local
target; commits quote the connection's `previewId` and digest after the person's
confirmation. It rechecks current service access and the immutable publication
before committing. Private plans last for that connection. See
[`packages/mcp/README.md`](../mcp/README.md) for tool arguments.

Tests use temporary homes/projects only. `npm test -w packages/hosts` runs the
public filesystem/CLI cases after the root build; the MCP suite drives real
publication and installation through the service and an SDK client.
