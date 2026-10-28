# Keep Version Frames and Scope Roles to Their Workflow

Status: accepted. A workflow belongs to one Group, and its creator becomes its initial Workflow owner. Workflow roles use the existing binding and verified-email invitation lifecycle, with a workflow foreign key separate from the Group foreign key. Roles are additive, but a workflow binding grants nothing on its Group or other workflows. Administrators, inherited Group leads, and Workflow owners assign and remove these roles; an Engineer starts a new version.

Each version snapshots the workflow's name, goal, intent, and locale. Editing the workflow changes the frame for future versions without rewriting earlier versions. Starting a version quotes and advances the workflow's revision under a row lock, serializing it with frame edits and other version starts; a stale write returns the current workflow and revision. Stage states belong to the version's revision and are read-only through the API. They begin at Sources; the features that own later stage records will derive changes from those records and the kernel's results. A generic stage PATCH would let clients claim gates had passed without the records that prove it.

## Considered Options

- A second invitation and role table just for workflows. Rejected because it would duplicate identity resolution, email verification, revisions, removal, and audit behavior.
- Refer to the workflow's current frame from every version. Rejected because an edit would silently change the meaning of work already started under a different frame.
