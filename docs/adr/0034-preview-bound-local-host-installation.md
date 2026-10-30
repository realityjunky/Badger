# Bind local host writes to verified publications and reviewed previews

Status: accepted. `packages/hosts` adapts immutable published snapshots to local
Claude Code, Codex and WorkBuddy files at project or user scope. The kernel owns
package verification; the installer never derives packages from mutable current
Authoring state or reimplements authoring/runtime authority.

The service and browser cannot access the browser person's host filesystem.
Dashboard actions instead produce local preview commands bound to publication
ID and package hash. The local CLI/MCP downloads and verifies the immutable
snapshot, then previews every persistent write/delete with exact expected and
proposed hashes. Only a separate explicit confirmation quoting that digest may
commit. The selected root's identity and current file contents are checked again.
An exclusive local lock serializes commits and the existing contained atomic
filesystem writer protects each write. This is not a cross-file transaction;
interrupted installations remain visible conflicts requiring review and repair.

An ownership registry records only managed packages and the managed MCP entry.
Uninstall refuses changed packages or unowned files and removes a shared MCP
entry only when the last managed package is removed. Unknown same-name entries
are never adopted implicitly. Other JSON fields and unrelated TOML text are
preserved. Symlink ancestors, special files, hard links and unsafe package paths
are refused.

Token values never enter generated host configuration or private preview files.
Codex forwards `BADGER_TOKEN` with `env_vars`; Claude Code and WorkBuddy use
their documented environment-variable expansion. A browser-safe renderer is
shared with dashboard MCP setup. Local installation confirmation does not grant
Agents any service sign-off authority; review, publication and all other human
gates retain their existing signed-in-person checks.
