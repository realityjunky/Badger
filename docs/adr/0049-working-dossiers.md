# Approve a Workflow Version's Working Dossier

Status: accepted. [ADR 0052](0052-advisory-skill-script-effect-reviews.md)
updates the approval requirements for script effect declarations.

The kernel defines fields for the Workflow, pins, occurrences, and handoffs. The service opens a working dossier for the exact checked pin set. Source study reads its graph and pinned evidence. Questionnaire edits the same revision and uses its existing Questions, reviews, and acknowledgements. A Required Skill Call contributes evidence to its parent Node. An independently resumable action has its own Node or a visit in a bounded Cycle.

Each saved edit appends a revision while holding the Workflow version lock. Edits name the base revision and checked pin set. Replaying an edit ID and body returns its original saved revision. Citations resolve against the service's immutable file inventories, including when an Agent reads a matching workstation copy. Version-scoped readers can inspect the saved lines after repinning.

Drafting through an Engineer token applies a decision only with a reviewed Answer for the affected field. The signed-in Engineer can record a direct workflow decision. The signed-in Workflow owner approves one exact snapshot after the Sources gate, required fields, linked decisions, and applicable script-effect confirmations pass. Approval stores the artifact in the existing Dossier version history. The FactoryPlan and authoring handoffs bind its hash. Changed inputs invalidate the approval and preserve the artifact. The original uploader still confirms script effects through [ADR 0041](0041-source-study-script-effect-confirmations.md).

Earlier Source study and composed Dossier records retain their existing authoring and approval history. A new Workflow version starts its own working dossier. Existing Questionnaire record inheritance follows [ADR 0028](0028-workflow-version-inheritance.md).
