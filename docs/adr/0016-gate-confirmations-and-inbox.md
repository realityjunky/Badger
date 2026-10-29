# Keep Gate Replay Separate from Invalidation

Status: accepted. A gate preview binds its workflow version, records, effects,
and input hashes with the kernel's canonical hash. A signed-in person commits
that hash; personal access tokens never sign off. Commits and pin changes
lock the workflow version so that the reviewed records cannot change during
confirmation.

Each confirmation retains its original response under the person's client
request ID. A retry returns that response even after invalidation, while a
history read shows the confirmation's current invalidation and supersession
metadata. Reusing that ID for another gate, workflow version, or hash is a
conflict. Returning current state on a retry would lose the distinction
between recovering a lost response and making a new decision.

The same transaction records the confirmation or invalidation, its Activity
log entry, and the inbox changes. Passed source checks notify Engineers;
pin changes invalidate Sources and notify Engineers and the Workflow owner.
Inbox items close automatically when their gate is confirmed. Pending role
invitations receive items through their existing binding, so notification
ownership follows verified identity resolution rather than an email match
on every read. The dashboard polls the per-person inbox and rechecks current
workflow visibility on the server.
