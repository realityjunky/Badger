# Badger Workflow Questionnaire: Source Study

## Sources reviewed

- [`to-questionnaire` at commit `dadd0c00d6a350acaa15bb9ca1b96b20ead684ca`](https://github.com/mattpocock/skills/blob/dadd0c00d6a350acaa15bb9ca1b96b20ead684ca/skills/productivity/to-questionnaire/SKILL.md)
- [Official Comet `/comet-any` Skill](https://github.com/rpamis/comet/blob/eeb2a685dab0ca492f8ccc266e21657c828bdf38/assets/skills/comet-any/SKILL.md)
- [Official Comet Skill-creation guide](https://github.com/rpamis/comet/blob/eeb2a685dab0ca492f8ccc266e21657c828bdf38/docs/operations/SKILL-CREATION.md)
- Badger's explicit source resolver in `src/workflow-kernel/discovery.ts` and FactoryPlan contract in `src/types.ts`.

## Reusable questionnaire pattern

The reference questionnaire first establishes the recipient and the information needed for a
useful handoff. Its useful properties are:

- clarify purpose before drafting questions;
- ask the highest-value questions first;
- keep each question about one idea;
- make partial and uncertain answers useful; and
- produce a concrete artifact from the discovery exchange.

## Badger adaptation

Badger keeps the conversational elicitation pattern but makes source identity explicit. The Agent
asks the workflow owner for Skill names and locations, then the CLI reads only those locations and
returns evidence-backed metadata. The questionnaire fills semantic workflow gaps that cannot be
derived from source files; it does not search default roots or persist an intermediate preference
document. Proposal construction remains a separate read-only validation step followed by explicit
Creator confirmation.
