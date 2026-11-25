# Link Authoring findings to their owning stage

Status: accepted. This extends the repair action in [ADR 0031](0031-transactional-authoring-acceptance.md).

A blocked Authoring lane can name an approved input that needs revision. The
Engineer previews and confirms the lane result. Badger binds the follow-up
to that accepted result and to the exact input the package used. The finding
stays readable after the package or input is superseded.

- Plan opens one `draft-plan` job in the same transaction as lane acceptance.
  The job includes the base Plan version, approved Dossier, and the finding
  and instructions from the lane. Existing plan drafting and approval rules
  apply when the Engineer accepts its proposal.
- Sources links to the exact pinned Skill version. Adopting a replacement
  still requires a separate pin change by the Engineer.
- Dossier links to the approved Dossier version and the field that needs
  review. Dossier editing and approval stay in their existing stages.
- Proposal links to the derived proposal's hash. A revised proposal is
  derived and approved through the existing proposal gate.

The accepted result and follow-up commit together. Replaying the confirmation
returns the same link. A lane with a stage follow-up waits for a new
generation. A lane-local repair can still queue another job in that lane.

A generated hook defect is a Badger bug. A lane can record the defect and the
evidence needed to reproduce it. Badger waits for the fix without queuing
another lane job. Changes to generated code require explicit regeneration.
