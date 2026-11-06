# Keep submitted questionnaire suggestion review with people

Status: accepted. Supersedes ADR 0045's Agent-assisted suggestion-review
exception and restores ADR 0043's browser-only editing boundary.

[ADR 0047](0047-exclusive-drafting-sessions.md) supersedes the Agent-editing
restriction for an explicitly claimed drafting session. The standalone review
endpoint and sign-offs remain reserved for signed-in people.

Agents draft questionnaire suggestions from dispatched jobs. Once submitted,
those suggestions are reviewed and edited personally by authorized Engineers
and Field experts in the dashboard. This review is human work even before the
Engineer's separate acceptance or rejection decision.

Remove the Copy review prompt control, its assembled-context endpoint, the
suggestion-review Agent-assistance template, and the suggestion-review MCP
tools. The server rejects review writes authenticated with personal access
tokens regardless of the token owner's role or scopes. MCP capabilities never
advertise suggestion review as available to Agents.

Manual dashboard editing retains its existing permissions, revision checks,
immutable review history and original Agent submission. The Engineer's
hash-bound decision remains separate. Existing saved reviews and historical
template revisions are retained; retired template revisions are no longer
available through the active catalog or template endpoints.

Agent drafting and assistance with a person's own assigned answers keep their
existing staged prompts and MCP transport. This decision concerns submitted
questionnaire suggestion review; other workflow stages retain their own
documented review boundaries.
