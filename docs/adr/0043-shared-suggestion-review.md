# Shared suggestion edits precede Engineer decisions

A workflow has at most one Engineer role binding, including pending invitations. A partial unique database index enforces this across concurrent assignments. Existing workflows with multiple bindings must have the extra assignments explicitly removed before migration; migration never selects or removes an Engineer automatically. Administrators retain their existing override capabilities.

Signed-in workflow Engineers and Field experts can read questionnaire drafting suggestions and save a shared review result. Saving validates the result, preserves the original Agent submission and hash, appends an immutable review revision, and advances the job revision under the existing workflow and version locks. It does not create accepted records, complete an inbox item, or change an Agent's input context. Stale saves return a conflict instead of overwriting another person's edits. Personal access tokens cannot edit human reviews.

The dashboard separates Review suggestions, which edits and saves, from Review decisions, which previews the latest persisted result for the Engineer's explicit hash-bound acceptance. When a saved review exists, acceptance must match it. Every save invalidates older decision previews through the job revision. Existing acceptance rules, including source evidence validation and expert acknowledgement of restated Answers, still apply. Field experts gain no job management, questionnaire composition, or sign-off capability.

Workflow detail panels use full-width tabs. Panel hashes remain navigation targets, browser history restores tab selection, and visited tabs retain their local state. Expand and Collapse controls are removed from these panels.
