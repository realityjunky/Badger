# Authoring Handoffs

Badger authoring uses six responsibility-specific lanes. The main Badger
process owns the plan, dispatch order, validation, persistence, assembly, and
readiness decision. A lane worker returns a bounded file-handoff report; it
does not write Badger state or the package directly.

## Common handoff

Every handoff contains the confirmed goal, workflow name, normalized
`WorkflowProtocol`, resolved source summary, the lane's role brief, and the
hashes needed to identify those inputs. A worker receives only the paths and
bounded context required for its lane. It returns one JSON envelope with:

- `lane` and one of `DONE`, `DONE_WITH_CONCERNS`, `BLOCKED`, or
  `NEEDS_CONTEXT`;
- bounded artifact references, with content only for declared authored leaves;
- claims that explain what the report guarantees;
- findings with a severity, problem, and optional safe relative path or fix;
- review data only when the lane is `skill-review`.

Workers must not write Creator or authoring state, execute candidate Skills,
publish or distribute packages, access credentials, or invent WorkflowProtocol
routes. A `BLOCKED` or `NEEDS_CONTEXT` report stops dependent lanes while its
evidence remains available for repair.

## Lane order

The six lanes preserve the upstream-compatible identities and dependency
waves:

| Lane             | Wave              | Responsibility                                                                        | Authored leaves                                         |
| ---------------- | ----------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `script`         | 1                 | Describe the generated adapter contract and its six control-plane claims.             | None                                                    |
| `reference`      | 1                 | Record normalized protocol, resolved Skills, composition evidence, and lane metadata. | None                                                    |
| `pause-points`   | 1                 | Classify decisions, automatic handling, stop conditions, and manual handoffs.         | `reference/decision-points.md`, `reference/recovery.md` |
| `workflow-entry` | 2, after `script` | Write the entry Skill's substantive Decision Core.                                    | `SKILL.md`                                              |
| `skill-core`     | 2, after `script` | Write substantive Guidance for every active internal Node.                            | `../<node-skill>/SKILL.md`                              |
| `skill-review`   | Barrier           | Review all preceding claims, artifacts, and authored leaves.                          | `reference/skill-review.md`                             |

Wave one runs `script`, `reference`, and `pause-points` independently. Wave two
can run `workflow-entry` and `skill-core` together after the script contract is
accepted. `skill-review` runs only after every other lane has a complete report.
The lane order is a dependency graph, not a second WorkflowRuntime state
machine.

## Role briefs

The corresponding briefs are package references:

1. `reference/subagents/script-author.md`
2. `reference/subagents/reference-author.md`
3. `reference/subagents/pause-points-author.md`
4. `reference/subagents/workflow-entry-author.md`
5. `reference/subagents/skill-core-author.md`
6. `reference/subagents/skill-reviewer.md`

The brief path is part of the handoff evidence. The worker may read the
declared brief and referenced artifacts, but it may not use conversation
history as an authority for current state.

## Review barrier

Quick review records one voter and one round. Full review records three
independent voters, all four lenses (`contract-fit`, `usability`,
`evidence-trace`, and `self-consistency`), a two-round dry threshold, and at
most four rounds. Provider findings and deterministic self-consistency findings
remain separate. Passing the barrier does not replace deterministic package
evaluation, WorkflowRuntime certification, or human publication approval.
