# Changelog

## What's Changed [Unreleased]

### Added

- **Authoring preview**: Added a read-only six-lane AuthoringPlan preview with
  pinned upstream protocol evidence and separate authoring and workflow
  protocol hashes.
- **Resumable authoring scaffold**: Confirmed generation now creates an
  authoring-pending scaffold, durable lane-session state, hash-bound record
  storage, and an explicit assembly command.

## What's Changed [0.1.2] - 2026-09-03

### Changed

- **Differential fixtures**: Added an explicit fixture Skill root so the Badger core can validate domain harnesses stored in separate repositories.

## What's Changed [0.1.1] - 2026-09-03

### Changed

- **Package identity**: Rebranded the standalone workflow Creator and Engine as Badger, including its CLI, Skill asset, persistence namespaces, generated package layout, and runtime environment variables.
