# Use One Semantic Dossier With Separate Wave One Lenses

Status: accepted. The questionnaire produces one confirmed semantic dossier, and Wave 1 keeps `script`, `reference`, and `pause-points` as separate bounded lenses over that dossier. This preserves independent responsibilities and clearer claims while preventing three agents from repeating discovery; `NEEDS_CONTEXT` or `BLOCKED` results become targeted follow-up questions or repair work for the main session. The dossier supplies workflow meaning, while the authoring protocol and deterministic runtime continue to own package encoding and execution semantics.

## Considered Options

- Have one main agent perform all Wave 1 classification. Rejected because the three responsibilities become harder to inspect and validate independently.
- Let each Wave 1 agent rediscover the workflow from source files and conversation history. Rejected because it duplicates the questionnaire and increases disagreement about confirmed facts.
