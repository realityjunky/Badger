# Workflow owners approve and publish packages

Status: accepted. Supersedes [ADR 0033](0033-immutable-package-publication.md).

The Workflow owner is accountable for a Workflow's package approval and
publication. A separate Reviewer role made that accountability require an extra
assignment and prevented owners who also accepted Authoring outputs from signing
off. Merge Reviewer into Workflow owner and use one `publish` capability for both
approval and publication. Administrators retain the same access. The five
Workflow roles are Workflow owner, Engineer, Field expert, Operator, and Observer.

Approval and publication remain separate, explicitly confirmed, hash-bound gates
performed by signed-in people. Accepting an Authoring lane no longer disqualifies
an owner or Administrator from package approval, and the service no longer accepts
independence overrides. This gives up enforced separation between the person
accepting Authoring work and the person approving publication in favor of owner
accountability. Kernel Authoring review, evaluation, exact-hash approval,
concurrency checks, and the ban on personal-token sign-off remain in force.
The kernel's distinction between an Authoring review voter and the human package
approver remains; a workflow role is not an Authoring review identity.

Migration `0037` converts existing Reviewer bindings, including pending
invitations, to Workflow owner. This intentionally grants former Reviewers the
owner's other capabilities. When the same person already owns that Workflow,
or the same pending email already has an owner invitation, retain the owner
binding and merge the duplicate. Resolved bindings match stable person IDs;
pending invitations match email without regard to case. Repoint question
recipients and invitation inbox items before removing duplicate bindings, keeping
one item when the same inbox event already exists. Converted bindings increment
their revision, and the database rejects new Reviewer bindings.

Published protocols and Run evidence are immutable. Workflow owners therefore
attest both `workflow-owner` and the legacy `reviewer` authority, so earlier
published gates remain answerable without rewriting their policies or hashes.
Administrator status alone still grants no Run authority. Earlier package reviews
retain their approver identities and any historical override reasons.

ADR 0033's storage and integrity design continues unchanged: the kernel checks
cloned Creator state, passing evaluation and exact package bytes; service sign-off
and publication commit atomically; immutable snapshots survive regeneration;
retrieval verifies their bytes; invalidated gates retain their original replay
responses. Review approval and publication never modify committed Authoring files.
