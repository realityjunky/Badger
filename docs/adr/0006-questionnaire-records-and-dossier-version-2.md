# Store the Questionnaire as Records and Compose Dossier Version 2

Status: accepted. This extends [ADR 0001](0001-semantic-dossier-and-wave-one-lenses.md), which stands: the questionnaire still yields one confirmed Semantic dossier, Wave 1 keeps its `script`, `reference`, and `pause-points` lenses separate over it, and `NEEDS_CONTEXT` or `BLOCKED` lane results return to the Engineer as follow-up questions or repair work.

Each workflow version has one questionnaire, stored as records: questions and their revisions, rounds, answers and their revisions, threads, concerns, resolutions, facts, acknowledgements, agent inferences, and assumptions. The five-part ledger and per-topic readiness are read models over those records, and the questionnaire handoff becomes a read model shared by the service and the CLI. Composing a dossier version snapshots the ledger's record IDs and revisions as canonical JSON with its hash, and the kernel validates it.

Semantic dossier schema version 2 adds an `interfaces` topic for the data contracts between Nodes, the resolution of each deferred question, provenance for each fact (the confirming person, the answer revisions, and the acknowledgement), and one goal shared by the dossier and the plan. Version 1 is retired, and its fixtures are migrated.

The Primer Designer test found each gap ([handoff](../handoffs/primer-designer-phase1-2026-10-27.md)): the CLI flow keeps no in-progress questionnaire, so a new session starts again from first use (F12); a question internal to one Skill cannot be deferred, so every unresolved item blocks completion, and an unconfirmed first triage put 33 of the 68 open audit questions in that class (G1); no topic names the hand-offs between Skills, where one column mismatch passes the receiving Skill's own Step 1 checks (G2); and the FactoryPlan carries two goals while the dossier binds only one (F15).

## Consequences

- A deferral needs a reason and never blocks readiness; a question internal to one Skill moves to that Skill's backlog.
- A changed fact supersedes the approved dossier, and a new Skill version flags the facts whose evidence changed.
- A new workflow version copies the facts and resolutions and reopens only the flagged items.

## Considered Options

- Keep the questionnaire in the conversation and store only the finished dossier. Rejected because work in progress is lost with the session, and a fact could not record who confirmed and acknowledged it.
