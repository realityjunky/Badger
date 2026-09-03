# Workspace Manifest: A Practical Introduction

## Why use one

A workspace manifest is a small, versioned inventory of related Git
repositories. It records which repositories belong together, where each local
checkout lives, which revision is expected, and what role the repository plays.
It coordinates repositories without merging their histories or copying their
source trees.

The recommended Badger workspace has three kinds of repository:

```text
/home/hugo/AI/Badger                              # Badger core
/home/hugo/AI/Badger-workflows/primer_designer_harness  # private domain harness
/home/hugo/AI/repos/comet                          # public upstream reference
```

## Current manifest

The concrete manifest is [`badger-workspace.yaml`](../../badger-workspace.yaml)
at the workspace root. Its companion JSON Schema is
[`badger-workspace.schema.json`](../../badger-workspace.schema.json). The
manifest is intentionally relative to its own directory, so the same file can
describe another checkout of the workspace without embedding a user-specific
absolute path.

## What it records

The current `badger-workspace.yaml` is:

```yaml
$schema: ./badger-workspace.schema.json
version: 1
name: badger-workspace
pathBase: manifest-directory

repositories:
  - id: badger
    role: core
    visibility: private
    path: Badger
    remote: git@github.com:realityjunky/Badger.git
    ref: main
    commit: f930d8ac864e0bf7f7b96c88726217dae0d5c132
    package:
      name: '@rpamis/badger'
      version: 0.1.2

  - id: primer-designer-harness
    role: domain-workflow
    visibility: private
    path: Badger-workflows/primer_designer_harness
    remote: git@github.com:realityjunky/Badger-workflows.git
    ref: main
    commit: a8aec3bddbf557ae3798947ae55bda60608b52b0

  - id: comet
    role: upstream-reference
    visibility: public
    path: repos/comet
    remote: git@github.com:rpamis/comet.git
    ref: master
    commit: 99fd7495f8b9217efbaae3a46d885f6fa7f4102a
    readOnly: true

integrations:
  - id: primer-designer-v1
    core: badger
    domain: primer-designer-harness
    pathBase: domain-repository
    workflow: workflows/primer-designer-v1
    fixture: differential/primer-designer-workflow.json
    fixtureSkillsRoot: skills
    badgerMinimum: 0.1.2
    upstream: comet
```

The manifest format is versioned by `version` and validated against the
companion schema. Paths under `repositories` resolve from the manifest
directory. Paths under an integration resolve from the declared domain
repository.

The important distinctions are:

- `pathBase` makes path resolution explicit;
- `remote` identifies where a repository comes from;
- `ref` is a moving development branch;
- `commit` is an immutable evidence or certification pin;
- `role` explains whether a repository is core, domain-owned, or upstream;
- `fixtureSkillsRoot` tells Badger where domain Skill evidence lives;
- `upstream` refers to the pinned upstream repository entry;
- `integrations` describes relationships without making the repositories one
  Git history.

## What it does not do

A manifest is not a replacement for Git. It does not itself fetch, merge,
commit, or publish anything. It is also not a package lock unless every
integration uses immutable commits rather than branches.

The useful workflow is explicit:

1. Read the manifest to discover the participating checkouts.
2. Verify each checkout's remote, branch, commit, and dirty state.
3. Fetch upstream changes only in the upstream checkout.
4. Compare the pinned upstream commit with the candidate commit.
5. Port selected changes into a Badger branch or worktree.
6. Update the manifest and extraction evidence after validation.

For Comet, this manifest pins the upstream commit used by the Badger
extraction. A later upstream pull can then be reviewed as a bounded change
from the old pin to the new pin, rather than as an untraceable replacement of
the entire source tree.

## Manifest versus submodules

Git submodules encode a repository relationship directly in Git and are useful
when every contributor should receive exactly the same nested checkout. They
also add recursive initialization, detached-head, and update friction.

A manifest with independent sibling checkouts is preferable for this workspace:

- Badger can develop without carrying an upstream repository inside its tree;
- private domain repositories can be unavailable to users who only need core;
- public Comet history remains independently fetchable and read-only by policy;
- one manifest can describe repositories owned by different teams or with
  different visibility;
- integration uses explicit paths and commits instead of implicit filesystem
  coupling.

Submodules remain an option for a later distribution product, but they should
be an intentional delivery choice rather than the core development layout.

## Domain repository boundary

`primer_designer_harness` should own its domain Skills, workflow plans,
domain-specific tests, differential fixtures, and domain documentation. The
Badger core should consume those as an injected fixture root. It should not
hard-code the domain repository path or import domain implementation rules.

Protected raw data remains outside the repository boundary. The domain repo may
record schemas, manifests, hashes, and sanitized fixtures, but it must not copy
or commit the protected raw-data directory.

## The mental model

Think of the manifest as a table of contents for a reproducible engineering
workspace:

```text
Git repository history     owns source and review
Manifest                   records composition and pins
Badger core                owns generic runtime semantics
Domain repository          owns domain meaning and workflows
Upstream checkout          supplies reference changes
```

The repositories stay independent. The manifest makes their relationship
visible, reviewable, and reproducible.
