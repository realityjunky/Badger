# Project-Relative Creator Records

Status: accepted. Creator records store project-owned paths relative to the project root with `/` separators and resolve them against that root on read. The records are the Creator state, the authoring session summary, plan, and lane records, the evaluation report, and the publication record. A project-owned path that escapes the root is refused when the record is written and when it is read.

Source identities are the exception. A Skill or upgrade source inside the project is stored relative and moves with it; one declared at an absolute location outside the project stays absolute, because the source model already permits that ([handoff](../handoffs/primer-designer-phase1-2026-10-27.md), F22 confines those separately). The semantic dossier's canonical source paths stay normalized and absolute, as dossier version 2 requires.

The authoring session identity hashes the project-relative session location instead of the absolute one, so moving a project no longer changes the identity. Session identities written with the earlier absolute hash are accepted once and rewritten on the next persist.

## Consequences

- `.badger/` is portable. A project copied or renamed to another directory passes guide, authoring status, evaluation, and review without regeneration.
- Publication approval readiness hashes use project-relative evidence paths, so a move does not stale an approval.
- Existing states that hold absolute paths still load where they were written, and are rewritten relative on their next write.
- A state or record whose stored path escapes its project root is refused rather than resolved, which also blocks a tampered record from reading outside the project.
- Committing `.badger/` becomes possible; whether a deployment should commit it stays a per-deployment decision.

## Considered Options

- Keep absolute paths and rewrite them when reading a moved project. Rejected because the records still move as text: every reader would need to know which fields to repair, and two checkouts of the same project would disagree.
- Store every path relative, including external Skill and upgrade sources. Rejected because the source model accepts absolute locations outside the project, and refusing them would break existing plans for a concern F22 owns.
