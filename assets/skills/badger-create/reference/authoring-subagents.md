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

## Common dossier and coordinator actions

Read the confirmed proposal from `confirmedProposal.path` in the handoff or common input. Check its byte length against `confirmedProposal.limitBytes` and its SHA-256 content hash against `confirmedProposal.hash` before using it. The coordinator writes a separate bounded proposal snapshot whose derived authoring-plan identity matches the current session; all Wave 1 lenses receive the same proposal content hash. Proposal content stays outside the common-input envelope. Dispatch rejects symbolic links in output and companion-file paths, including existing ancestors above directories that have not been created yet.

For dossier-backed sessions, use the handoff's `semanticDossier.path` and `/semanticDossier` pointer to read the confirmed dossier. All three Wave 1 lenses consume the same dossier, confirmed proposal, normalized protocol, resolved source evidence, and input hashes. Use supplied evidence instead of repeating source discovery or interviewing the user. Return `semanticDossierHash` from the handoff with each lane output; missing or stale identity is rejected before recording. Legacy sessions without a dossier retain their existing envelope.

Keep claims, artifacts, and status in separate lane envelopes, whether workers run concurrently or one main Agent applies all three lenses. Workers write only their designated output files. They cannot execute supplied Skills, write Creator or authoring state, or modify generated package files. The coordinator validates and records output, then the assembler applies declared content leaves. The file handoff describes these permissions; the host must enforce worker tool access.

Wave 1 `NEEDS_CONTEXT` outputs require an `action` with `kind: "question"`, a targeted `prompt`, and `requirement` identifying an existing dossier field with a JSON pointer such as `/topics/recoveryPolicy`. Explain the missing or ambiguous detail in the summary. The main session asks that question, obtains confirmation of the repaired dossier, regenerates the session, and reauthors invalidated lanes. Resolved facts remain authoritative.

Wave 1 `BLOCKED` outputs require an `action` with `kind: "repair"`, a concrete `requirement` naming the missing dependency or repair, and a `prompt` explaining the next main-session action. Both statuses persist their actions in lane readiness and prevent dependent lanes from dispatching. Independent lanes may continue. Retry against the current input identity and revision after repair.

## Lane responsibilities

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
