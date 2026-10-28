# Bind Creator State to the Approved Proposal

Status: accepted. A Creator state records the proposal a person approved, and every later write is bound to it ([handoff](../handoffs/primer-designer-phase1-2026-10-27.md), F1, F2, F18). `propose` prints a proposal hash; `init` takes that hash, rebuilds the proposal from the current plan and declared Skill sources, and refuses to initialize unless they still produce it. `generate` needs its own confirmation and rebuilds the proposal again. It refuses a plan or source set that drifted, and a state whose recorded proposal no longer hashes to the approved value, and it generates from the rebuilt proposal and the plan it checked, never from the state file's copy or a second read of the plan.

Plan and proposal hashes are SHA-256 over canonical JSON, with keys sorted by UTF-16 code unit and no dependence on locale, so reordering keys or reformatting a plan changes neither (F7). The proposal identity leaves out resolved source roots, as the authoring hashes do ([ADR 0007](0007-project-relative-creator-paths.md)), so a moved project keeps its approved proposal; the plan still binds each declared location.

Initialization never replaces a Creator state silently. A first `init` only creates the state file, so of two concurrent ones exactly one succeeds. Replacing a state requires the caller to quote its hash, which covers the state file exactly as stored. A refused `init` reports that hash, also for a state written with absolute paths and for a file that no longer parses, and the quoted hash is checked again just before the replacement.

## Consequences

- An edit to the plan or a Skill source after review is refused at `init` and at `generate`, and the person proposes and confirms again. `migrate` refuses a plan edited since initialization.
- States recorded before canonical hashing keep matching an unchanged plan through the hash form they recorded, so `guide` and in-progress authoring continue. They carry no proposal hash, so `generate` refuses them until the proposal is approved again.
- Replacing a state discards its generated, evaluation, and review records, which is why the caller must name the state being replaced.
- The service and the Badger MCP call the same kernel functions, `initializeState` and `generateFromApprovedProposal`, instead of reimplementing the checks.

## Considered Options

- Compare the proposal recorded at `init` with one rebuilt from the same plan. Rejected: that compares the plan with itself, which is how F1 went unnoticed.
- Keep hashing the plan with `JSON.stringify`. Rejected: the hash depended on key order (F7), so an unchanged plan could look edited.
- Sort keys with the locale-aware order that older Badger identities use. Rejected for these identities: that order depends on the runtime's collation data, and the hash must be the same on every host.
- Hash the state as Badger reads it instead of the file. Rejected: a file that no longer parses could not be named, and a state holding absolute paths would hash differently from the file the refusal describes.
- Let a `--force` flag replace a state. Rejected: it restores the silent overwrite that F2 describes.
