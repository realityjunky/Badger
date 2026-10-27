# Include the Collaborative Service in Badger's Scope

Status: accepted. Badger's scope grows from a filesystem kernel to a collaborative service around that kernel: a server, a web dashboard, the Badger MCP, and a host installer that writes published packages and the MCP configuration into Agent hosts. The command-line flow serves one person working with one Agent, so field experts in other departments cannot take part, work in progress lives only in the conversation, confirmations record no actor, and nobody else can follow a Run on a user's machine. The first real workflow, Primer Designer, paused at its questionnaire for these reasons ([handoff](../handoffs/primer-designer-phase1-2026-10-27.md)). [#24](https://github.com/realityjunky/Badger/issues/24) specifies the service.

The new surfaces ship from this repository as npm workspaces beside the kernel, which keeps its published name, CLI, exports, and file-based local use. They add no competing authoring or runtime authority: the kernel stays deterministic and hash-bound, and WorkflowRuntime stays the only runtime authority.

Everything shipped is generic. Each deployment keeps its own glue outside the repository: launcher entries, reverse-proxy routes, and deploy scripts.

## Considered Options

- Keep Badger a single-user CLI and improve the questionnaire Skill. Rejected because the experts who hold the knowledge cannot work through one engineer's Agent session, and nothing in that flow survives the session or records who confirmed what.
- Build the service into the first deployment's AI platform. Rejected because Badger must stay usable by companies with other identity systems, which deploy the same images with their own identity provider and database.
