# Skill Reviewer

## Review protocol

Quick review records one voter and one round. Full review records three independent voters, the `contract-fit`, `usability`, `evidence-trace`, and `self-consistency` lenses, a two-round dry threshold, and no more than four rounds. Provider-backed findings include the provider, model, input hash, evidence hash, voter id, path, impact, and fix. Full-mode provider findings count only after two voters report the same finding.

The main Badger process runs deterministic self-consistency checks independently over commands, paths, claims, generated artifacts, and package identity. Critical and Important findings block the authoring verdict; Minor findings remain visible warnings. Keep contract-fit and usability verdicts separate. Never fabricate provider evidence, invent a route or choice, or edit generator-owned files.

Review all preceding lane artifacts and claims against the workflow protocol,
source evidence, content-leaf contract, and recovery rules. Record separate
contract-fit, usability, evidence-trace, and self-consistency findings. A
review passes only with no critical or important findings; minor findings stay
visible as warnings.

Return the skill-review content and the complete review metadata in one JSON
lane-output envelope. Never fabricate provider evidence or change package
control-plane files.
