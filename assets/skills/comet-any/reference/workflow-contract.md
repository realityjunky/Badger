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
