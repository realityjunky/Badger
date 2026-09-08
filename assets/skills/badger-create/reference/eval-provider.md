# Evaluation and Review Evidence

Badger keeps package-content review, deterministic package evaluation,
WorkflowRuntime certification, and publication approval as separate evidence
classes. A passing result in one class never satisfies another class's gate.

## Authoring review

The `skill-review` lane reviews the complete current authoring session. Quick
mode records one voter and one round. Full mode records three independent
voters, all four review lenses, a two-round dry threshold, and at most four
rounds. Provider findings must identify their voter and the evidence they
reviewed; full-mode findings count only after the required independent voter
agreement. Deterministic self-consistency findings are recorded separately.

Review checks include:

- the six-lane dependency graph, claims, and artifact paths;
- substantive entry Decision Core and internal Node Guidance;
- declared decisions, choices, routes, Required Skill Calls, Output Schemas,
  guardrails, and recovery references;
- Auto-zone ownership, package inventory, command paths, and package identity;
- stale or missing input, authored-material, and assembled-package evidence.

`DONE_WITH_CONCERNS`, Critical findings, Important findings, missing evidence,
and stale hashes keep authoring readiness blocked until resolved.

## Deterministic evaluation

`badger eval <name>` evaluates the current assembled tree. It verifies the
generated package contract and runs the declared WorkflowRuntime certification
checks, including the synthetic decision-and-cycle coverage used by the
standalone release gate. It does not run source Skills or domain side effects.

The evaluation record must bind the exact package tree and executable
`WorkflowProtocol`. A later change requires a new evaluation even when the
directory name is unchanged.

## Approval and publication

`badger review <name> --json` reports authoring, runtime, and publication
sections separately. `badger approve <name> --reviewer <id> --confirm` records
only the human publication decision after the earlier sections are ready.
`badger publish <name> --confirm` copies the approved current-hash package to
the local publication area. `badger distribute` remains a file-list preview;
it does not install into an Agent platform directory.

## Provider boundary

Badger's provider-neutral handoff accepts bounded reports and declared
artifacts. It does not authenticate provider accounts, expose credentials,
execute candidate Skills, grant filesystem authority, or let a provider write
Creator, authoring, Run, or publication state. A local manual file provider is
enough to exercise the same validation and persistence seam.
