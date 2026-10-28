# Badger

This repository holds Badger, a workflow Skill factory, as an npm workspace.
The workflow kernel is delivered, and the collaborative service planned in
[#24](https://github.com/realityjunky/Badger/issues/24) has its walking
skeleton in `packages/server/`.

| Path               | Holds                                                                                                                                                                               | Status                 |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| `packages/kernel/` | The workflow kernel, published as `@realityjunky/badger`: the Creator, WorkflowRuntime, and the `badger` CLI. See its [README](packages/kernel/README.md).                          | Delivered              |
| `packages/server/` | The collaborative service's server role: reviewed SQL migrations, Postgres or PGlite, local single-user mode, audited writes, the health endpoint, and the in-process test harness. | Walking skeleton (#36) |
| `packages/web/`    | The dashboard shell: navigation rail, top bar, three-pane registry layout, design tokens, URL routing, zh/en catalogs, light and dark themes, and personal appearance settings.       | Dashboard shell (#37)  |
| `packages/<name>/` | One package each for the collaborative service's remaining surfaces: the Badger MCP and the host installer.                                                                           | Planned (#24)          |

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
`packages/kernel/assets/runtime/` and the dashboard in `packages/web/dist/`.
Run one kernel test file with
`npm test -w packages/kernel -- test/<file>.test.ts`, and the CLI with
`node packages/kernel/bin/badger.js`.

The dashboard's browser journeys run against the real service in local
single-user mode, with the built dashboard served by the server. Build first,
then run them:

```bash
npm run build
npm run test:e2e -w packages/web
```

Playwright's Chromium is a one-time download: `npx playwright install chromium`.

The server package's suite runs on PGlite by default and on Postgres 17 when
`BADGER_TEST_DATABASE_URL` points at one; CI runs both. To try the container
against Postgres:

```bash
docker compose up --build
# health report: http://localhost:8787/health
```

The image also carries the built dashboard. The compose file runs the server
role without a people-facing identity adapter, because this build ships none;
it reports health and serves the signed-out page, and person routes answer
401. For local single-user mode, with the implicit Administrator, the
dashboard, and PGlite on disk:

```bash
npm run build
npm start -w packages/server
# then open http://127.0.0.1:8787
```

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
