# Verify External and Large Artifacts by Receipt

Status: accepted. Output Schema artifacts may opt into receipt verification
([#31](https://github.com/realityjunky/Badger/issues/31)) and name an external
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
particular process wrote a file. The cost is that a fresh output copied with its
old modification time kept, or written to a network file system whose clock
lags the host's, is refused as stale; such a workflow writes its outputs afresh
within the Attempt.

An external root is a name and a description in the workflow, never a
directory. The host binds each declared root to a directory when a Run starts:
the kernel API takes an `externalRoots` start option, and a generated package's
script adapter takes `--external-root <name>=<directory>` on `init`, once per
root. A Run does not start while a declared root is unbound, or when a binding
names an undeclared root or a directory that is relative, missing, a file, or
itself a link, the rule the Run root follows. Run state stores the binding, fixed
for the Run; each receipt records the root's name and bound directory, and a Run
whose receipts disagree with its binding is refused on load. Output Schemas that
share a root name share its directory, so they must describe it alike. This
follows [ADR 0008](0008-skill-identity-and-registered-roots.md): whoever writes
a declaration does not choose the boundary that confines it. A package that
names no host directory also keeps one hash on every host and in every Run.

External roots grant read access only for the declared receipt paths. Verifying
an artifact never creates, modifies, copies, publishes, or distributes it.

## Considered Options

- Absolute directories in the Output Schema, as #31 was first built. Rejected:
  the workflow's author would choose the boundary that confines its reads, and
  a host path inside the protocol enters the package hash, so a package would
  run on one host only.
- Directories relative to the project or the Run root. Rejected: the outputs
  that need a receipt are the ones too large or too shared to live there, such
  as a shared drive or a scheduler's scratch space.
- A binding that may change during a Run. Rejected: a receipt is comparable only
  with a later check of the same directory, so carried versions and recovery
  would lose their meaning.
