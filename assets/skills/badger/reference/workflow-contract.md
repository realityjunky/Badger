# Workflow Contract Reference

The plan file is JSON with this shape:

```json
{
  "schemaVersion": 1,
  "goal": "Create a primer workflow.",
  "skillCreatorIntent": "new-skill",
  "skillSources": [
    { "name": "primer-design", "location": "skills/primer-design" },
    {
      "name": "genome-download",
      "location": "/workspace/skills/genome-download"
    }
  ],
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

The normalizer emits success, failure self-loop, and pause self-loop edges for every Node. A workflow-kernel uses `.badger/runs/<name>/state.json` with `currentNode`, `completedNodes`, and `evidence` fields.

An opted-in revisioned workflow adds `routing.fields` (or a field map) with
allowed scalar values and uses structured `when` predicates on success edges.
Predicates support exact equality and conjunction. The runtime selects one
matching edge or one edge without `when` as the fallback; it rejects ambiguity,
unknown values, undeclared graph cycles, and unreachable required Nodes before
Run creation. Machine submissions provide route values in a separate `routing`
object. Attempt identity, revision, retry ordinal, and append-only visit
outcomes are persisted by WorkflowRuntime. Declared Cycles name a stable key,
entry Node, explicit repeat transitions, and a finite `maxInstances` budget.
First entry and accepted repeat transitions allocate stable Cycle identities;
an exhausted budget blocks without mutation. An explicit decision Node uses
`kind: "decision"` and declares a stable id, question, choices with stable
ids, human labels, and one transition target per choice. It may also declare
an object input schema with scalar fields and enumerated values, a rationale
requirement, and reviewer subjects or authorities. Executable validators,
remote references, and arbitrary nested values are rejected before Run
creation. A decision may also declare `scope.artifacts` and
`scope.evidence` entries by schema-qualified logical id, with `required`
defaulting to false. WorkflowRuntime captures only accepted version ids,
content hashes, and producer identities for those entries. Optional captured
references may be omitted from a response; required references may not.

A versioned workflow may add `versioned-artifacts`. Each Output Schema artifact
keeps its stable schema-qualified logical id and may declare `lifetime` as
`attempt`, `cycle`, or `run`; omitted lifetime defaults to `attempt`. Physical
paths remain declarations, not identities. A successful producer update creates
one immutable content-bound version with its producer Run, Node, Cycle, Attempt,
action, accepted revision, and runtime timestamp. Later actions consume only an
explicit accepted version supplied under `artifactVersions`; the runtime never
resolves an implicit latest value. `artifacts` may select one physical path that
matches the declaration. Every required versioned output must provide one of
those two explicit forms. Attempt-lifetime update paths contain the current
Attempt id as a path segment to isolate repeated visits. Undeclared updates,
incompatible lifetime scopes,
unknown versions, link traversal, oversized reads, and content drift fail before
Run mutation.

Decision Nodes compile to Engine `ask_user` actions. The continuation reports
`await-user` and exposes the pending question, choices, required inputs,
rationale policy, reviewer requirement summary, revision, and Attempt identity.
Hosts submit a typed response through WorkflowRuntime with the current
revision, action, Node, Cycle, Attempt, choice, reviewer attestation, inputs,
and rationale. WorkflowRuntime validates the response, selects the declared
choice transition, and writes one identity-bound Decision Receipt with a
runtime timestamp. Generated adapters render and forward this contract but do
not perform policy validation, Cycle allocation, route selection, or receipt
writes. Generated state and handoff output projects the bounded decision
scope, receipt references, artifact versions, and current selections, while
allocation, hashing, carry-forward, scope validation, and authoritative
storage remain inside WorkflowRuntime.

## Findings and continuations

Every WorkflowRuntime continuation includes a versioned `findings` array and a
`findingSummary`. Findings have stable catalog codes, severity, bounded
redacted messages, optional safe relative paths, required actions, and
registered runtime operations represented by argument arrays. A finding also
declares whether it requires a real user decision.

The dispositions have one meaning: `continue` exposes executable machine work,
`await-user` exposes a persisted first-class decision, `blocked` exposes an
unresolved repair or stop condition, and `done` exposes terminal state. The
legacy `blockers` array is derived from blocked finding messages and is not a
runtime authority. Use JSON output for machine consumers so truncation summary,
omitted-code counts, and registered operations remain visible.
