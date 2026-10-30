# Bind Immutable Plan Versions to Approved Dossier Versions

Status: accepted. A Plan version stores a canonical kernel snapshot of its
FactoryPlan and Dossier version hash. Its identity binds the complete dossier
snapshot, including ledger provenance, rather than only the embedded Semantic
dossier. The kernel derives the frame, ordered Node identities, and pinned
source declarations, and validates edited candidates. The service stores
canonical text once; approval stays in the shared human gate history, as in
ADRs 0016 and 0023. A mutable plan row would lose the artifact an owner reviewed.

An Engineer's direct save quotes its preview hash and the plan version editing
began from. A `draft-plan` job carries the same dossier, skeleton, pins, and
base plan identity in its context. Human acceptance validates and saves through
the same kernel and service path. Concurrent edits conflict; an Agent's result
never creates a plan until a signed-in Engineer accepts it. Dossier replacement
or record changes invalidate plan approvals in the writer's transaction while
preserving artifacts, audit history, and original confirmation retry responses.
Plan approval keeps Plan and proposal active because proposal approval is a
separate gate before package authoring.
