# Store Creator Records With Project-Relative Paths

Status: accepted. Creator records store project-owned paths relative to the project root, with `/` separators, and resolve them against that root on read, so a project can move between checkouts, hosts, and containers ([handoff](../handoffs/primer-designer-phase1-2026-10-27.md), F4). The records are the Creator state, the authoring session summary, plan, and lane records, the evaluation report, and the publication record. A project-owned path that escapes the root is refused when the record is written and when it is read.

A Skill or upgrade source inside the project is stored the same way, relative to the real path of the project root, because discovery records real paths; the rule therefore holds when the project path contains a symbolic link. A source declared at an absolute location outside the project stays absolute, and which external locations are allowed is the source check's concern (F22). The semantic dossier keeps its canonical source paths absolute until dossier version 2 ([ADR 0006](0006-questionnaire-records-and-dossier-version-2.md)).

The hashes that bind authoring work describe what the sources contain, not where they live. The authoring plan and source evidence hashes leave source roots out, and the generated package records its sources the way the records do. A move therefore changes no hash, and the scaffold that assembly regenerates matches the one the session recorded. The authoring session identity hashes the project-relative session location.

## Consequences

- `.badger/` is portable. A copied or renamed project passes guide, authoring, assembly, evaluation, review, and publication without regeneration, whether it moved mid-authoring or after release.
- Publication approval readiness uses project-relative evidence paths, so a move does not stale an approval.
- Proposing again after a move needs the dossier's canonical source paths updated, because the proposal checks them against the discovered sources.
- Authoring sessions created before this decision hold hashes that bound absolute source roots, and must be regenerated. States that hold absolute paths still load where they were written, and are rewritten relative on their next write.
- Committing `.badger/` becomes possible; whether a deployment should commit it stays a per-deployment decision.

## Considered Options

- Keep absolute paths and rewrite them when reading a moved project. Rejected because the records still move as text: every reader would need to know which fields to repair, and two checkouts of the same project would disagree.
- Store every path relative, including external Skill and upgrade sources. Rejected because the source model accepts absolute locations outside the project, and confining those belongs to the source check.
- Keep source roots in the authoring hashes. Rejected because every move would stale the session and the package, although a source's identity is its content.
