# Standalone Comet-any

This repository extracts the Comet-any Creator seam from the upstream Comet checkout. It provides a focused, filesystem-based factory for creating new `workflow-kernel` Skills and upgrading existing Skill packages.

## Scope

The package includes:

- a shared workflow-kernel foundation behind the standalone Creator adapters;
- real local Skill discovery with stable source hashes, strict preferences, and ambiguity reporting;
- deterministic Workflow Contract normalization and validation;
- confirmed plan/state lifecycle in the standalone `.comet-any` namespace;
- complete local `SkillBundle` generation with an entry Skill, internal Node Skills, rules, hooks, scripts, references, guardrails, checks, and Eval declarations;
- an explicit authoring-lane DAG with hash-bound authoring records, review output, and fail-closed readiness;
- current-hash evaluation, review approval, publication, and distribution preview.

It intentionally excludes Comet Classic, Comet Native, Comet Entry, host platform installers, ambient resume routing, and external Engine adapters.

## Development

```bash
npm install
npm test
npm run build
npm run format:check
```

The CLI is `comet-any` after `npm run build`:

```bash
node bin/comet-any.js guide --project . --json
```

See `assets/skills/comet-any/SKILL.md` for the user-facing confirmation protocol and `docs/extraction-map.md` for upstream provenance.

The pinned three-Skill differential harness is documented in `docs/differential-harness.md`. It runs both Creators only in disposable temporary projects and rejects protected raw-data paths.
