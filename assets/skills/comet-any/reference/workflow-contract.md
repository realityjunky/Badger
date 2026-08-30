# Workflow Contract Reference

The plan file is JSON with this shape:

```json
{
  "schemaVersion": 1,
  "goal": "Create a primer workflow.",
  "skillCreatorIntent": "new-skill",
  "preferredSkills": ["primer-design", "genome-download"],
  "defaultLocale": "en",
  "workflow": {
    "kind": "workflow-kernel",
    "name": "primer-workflow",
    "goal": "Design and validate primers.",
    "customNodes": [],
    "outputSchemas": []
  }
}
```

`upgrade-existing` additionally requires `sourceRoot`, an existing Skill directory containing `SKILL.md`. The factory copies that package into the draft before writing the generated control plane.

Each custom Node declares:

- `id`, `label`, `kind`, and a substantive `responsibility`;
- `implementation` with `skill`, `operation`, and `scope`;
- `operations` supported by the Node;
- `outputSchemas` attached to the Node;
- optional `requiredSkillCalls`, `augmentations`, and `guardrails`.

The normalizer emits success, failure self-loop, and pause self-loop edges for every Node. A workflow-kernel uses `.comet/runs/<name>/state.json` with `currentNode`, `completedNodes`, and `evidence` fields.

An opted-in revisioned workflow adds `routing.fields` (or a field map) with
allowed scalar values and uses structured `when` predicates on success edges.
Predicates support exact equality and conjunction. The runtime selects one
matching edge or one edge without `when` as the fallback; it rejects ambiguity,
unknown values, graph cycles, and unreachable required Nodes before Run
creation. Machine submissions provide route values in a separate `routing`
object. Attempt identity, revision, retry ordinal, and append-only visit
outcomes are persisted by WorkflowRuntime. Human decisions, declared Cycles,
artifact versions, and Decision Receipts are separate follow-up capabilities.
