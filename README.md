# Badger

This repository holds Badger, a workflow Skill factory, as an npm workspace.
The workflow kernel is delivered; the collaborative service built around it is
planned in [#24](https://github.com/realityjunky/Badger/issues/24).

| Path               | Holds                                                                                                                                                      | Status        |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| `packages/kernel/` | The workflow kernel, published as `@realityjunky/badger`: the Creator, WorkflowRuntime, and the `badger` CLI. See its [README](packages/kernel/README.md). | Delivered     |
| `packages/<name>/` | One package each for the collaborative service's server, web dashboard, Badger MCP, and host installer.                                                    | Planned (#24) |

Everything shipped is generic: each deployment keeps its own launcher entries,
reverse-proxy routes, and deploy scripts outside this repository.

## Development

Run these commands from the repository root:

```bash
npm install
npm run build
npm test
npm run format:check
```

`npm run build` also rebuilds the bundled WorkflowRuntime in
`packages/kernel/assets/runtime/`. Run one kernel test file with
`npm test -w packages/kernel -- test/<file>.test.ts`, and the CLI with
`node packages/kernel/bin/badger.js`.

## Adding a workspace package

Each workspace package lives in `packages/<name>/` with its own `package.json`.
Add the directory to the root `workspaces` array after the packages it builds
on, because npm runs workspace scripts in that order; the kernel in
`packages/kernel/` stays first.

## Documentation

- `AGENTS.md`: rules for contributors and Agents.
- [`docs/release-artifacts.md`](docs/release-artifacts.md): release-facing
  artifacts and the release gate.
- [`docs/badger-workflow-manual.html`](docs/badger-workflow-manual.html): the
  bilingual workflow manual.
- [`docs/adr/`](docs/adr/): architecture decisions.
- [`GLOSSARY.md`](GLOSSARY.md): the domain language.
