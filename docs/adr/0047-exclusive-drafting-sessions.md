# Keep drafting claims until the session finishes

Status: accepted. Supersedes ADR 0046's prohibition on Agent edits only when
the Agent holds the job's current exclusive drafting claim. Human sign-offs
and the browser-only suggestion-review endpoint retain their authority.

Submitting suggestions through MCP saves a draft without ending the claim.
The same session may submit follow-up changes until the person asks it to
call `finish_job`. While claimed, dashboard editing, acceptance, rejection
and competing claims conflict. Finishing makes the latest saved suggestions
available for dashboard editing or another revision-checked claim. This
applies to every drafting kind, including Source study, questions, follow-ups,
imports, restatements, translations, plans, Authoring lanes and review votes.
Accepted, rejected and cancelled jobs cannot be reclaimed.

The original submission and context remain unchanged. Later Agent submissions
and human questionnaire edits share immutable review revisions; a new claim
receives the latest saved result. Questionnaire and Authoring acceptance bind
that saved result and the current job revision. Plan review starts from the
latest saved candidate and retains the Engineer's existing editor; its edits
are bound to a fresh acceptance preview. Acceptance remains a signed-in
person's separate, explicitly confirmed decision. Standalone MCP review tools
remain unavailable.

Claims belong to one MCP connection and retain the existing person, token,
host and context checks. Only the claim response exposes its lease identifier;
ordinary reads reveal ownership and expiry without granting the claim. MCP
renews its leases every five minutes and releases them on disconnect. A crash
or prolonged outage recovers through the thirty-minute lease: jobs with saved
suggestions become submitted, and empty jobs return to the queue. Finishing,
releasing or expiring a saved draft opens one reusable review inbox item.

HTTP callers opt into iterative saves with `keepClaim: true`; omitting it
retains the previous submit-and-release behavior for existing integrations.
