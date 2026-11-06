# Reserve suggestion editing until its session hands over

Status: accepted. Extends ADR 0047 to dashboard questionnaire reviews. Opening
Review suggestions claims the latest job revision for that browser editor.
Saving keeps the exclusive claim; Finish editing saves and releases it. Closing
the editor releases only saved work. Other browser editors and Agents cannot
start editing, save, accept, or discard while another session owns the job.
Legacy browser review requests remain single revision-checked atomic edits
when the job is unclaimed.

Finish requires saved suggestions and hands them over for review. Release
relinquishes ownership, preserving saved suggestions or returning an empty job
to the queue. Neither action accepts suggestions. Both end that claim; neither
grants a later claim to the old browser or Agent session.

Claims expire after thirty minutes without editing activity. Background
heartbeats and dashboard status polling do not extend that deadline. Browser
input and saves count as activity; explicit MCP job reads and submissions count
as activity for that connection's owned jobs. Disconnect and browser exit
release claims immediately when possible; server expiry recovers lost clients.
This bounds forgotten claims without discarding saved work or treating a saved
intermediate draft as ready for another editor.

Every claim starts from the latest saved suggestions and gets a new lease.
All writes bind the editor, credential, claim kind, lease, input context and
revision. A stale copy cannot write or end a subsequent claim, even when the
same person or MCP connection claims again. Retried identical saves within
the same active claim are no-ops; differing stale saves conflict. The dashboard
refreshes claim status automatically and retains expired unsaved text for
reference, requiring a new editing session to load current saved suggestions.
