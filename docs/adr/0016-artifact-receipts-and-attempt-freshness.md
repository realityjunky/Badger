# Verify External and Large Artifacts by Receipt

Output Schema artifacts may opt into receipt verification and name an external
root declared by that schema. Paths remain relative to the selected root;
traversal, symbolic links, junctions, and special filesystem objects are refused.
Artifacts without this opt-in retain the Run-root boundary and existing read
limits. The runtime streams receipt artifacts through SHA-256 verification and
records their path, size, modification time, and producer identity in accepted
Completion evidence, without storing their content.

Receipt declarations enable revisioned Attempts. When an artifact requires the
current Attempt, its modification time must be at least the timestamp of that
Attempt's first persisted action. Retrying within the Attempt retains that
boundary; entering a Node again establishes a new one. A caller's assertion that
an artifact is fresh cannot replace this check. This detects outputs left by
skipped work; filesystem timestamps are evidence of freshness, not proof that a
particular process wrote a file.

External roots grant read access only for the declared receipt paths. Verifying
an artifact never creates, modifies, copies, publishes, or distributes it.
