# Bundle Source Skills by Their Content Identity

Status: accepted. Generated workflow packages carry their declared source
Skills under `sources/<Skill identity hash>/` ([#33](https://github.com/realityjunky/Badger/issues/33)).
The source roots in `reference/resolved-skills.json` and the packaged
`reference/authoring-plan.json` are relative to the package root. They never
refer to the build host's source directories. Identical inputs produce the
same package hash when generated in different directories.

The bundle contains every identity file, including configuration, references,
scripts, and binary assets. It excludes the fixed environment-noise list from
[ADR 0008](0008-skill-identity-and-registered-roots.md). Each copied tree must
match its approved Skill identity before the staged package replaces the
destination. Bundled files have `source` inventory ownership; they are not
authored leaves, and assembly compares their bytes without interpreting them
as generated guidance. Copying a source never executes its scripts.

Creator records continue to identify the original sources, so edits to an
available original still invalidate authoring evidence. After assembly, if an
original source is absent, authoring readiness may use the corresponding
bundled tree, confined to the package, and must verify its identity. This lets
evaluation and runtime certification work after the package and its Creator
records move to a host without the original Skills. Missing or altered
bundles remain blockers. Publication approval retains its original-source
checks.

## Consequences

- A package carries the source files its Operators need, including relative
  references inside each source Skill.
- The same source identity has one bundled location, even if referenced more
  than once.
- Existing scaffolds must be regenerated and authored again to gain bundles;
  adding files to an already assembled package changes its approved hash.

## Considered Options

- Keep absolute source locations or point outside the package. Rejected:
  another host cannot resolve those sources, and build locations leak into
  package identity.
- Copy entire source directories without filtering or verification. Rejected:
  environment noise changes the package hash, and source edits could escape
  the approved identity.
- Replace original-source checks during authoring with bundled snapshots.
  Rejected: a still-available source must continue to detect drift before
  authoring work is accepted.
