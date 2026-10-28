# Badger

This repository holds Badger, a workflow Skill factory, as an npm workspace.
The workflow kernel is delivered, and the collaborative service planned in
[#24](https://github.com/realityjunky/Badger/issues/24) has its walking
skeleton in `packages/server/` and its dashboard shell in `packages/web/`.

| Path               | Holds                                                                                                                                                                                                 | Status                                         |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `packages/kernel/` | The workflow kernel, published as `@realityjunky/badger`: the Creator, WorkflowRuntime, and the `badger` CLI. See its [README](packages/kernel/README.md).                                            | Delivered                                      |
| `packages/server/` | The collaborative service's server role: reviewed SQL migrations, Postgres or PGlite, local single-user mode, platform sign-in, audited writes, the health endpoint, and the in-process test harness. | Walking skeleton (#36), platform sign-in (#38) |
| `packages/web/`    | The web dashboard shell: navigation rail, top bar, three-pane registry layout, design tokens, URL routing, zh/en catalogs, light and dark themes, and personal appearance settings.                   | Dashboard shell (#37)                          |
| `packages/<name>/` | One package each for the collaborative service's remaining surfaces: the Badger MCP and the host installer.                                                                                           | Planned (#24)                                  |

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
role with `BADGER_IDENTITY=none`, so it reports health and serves the
signed-out page, and person routes answer 401. For local single-user mode,
with the implicit Administrator, the dashboard, and PGlite on disk:

```bash
npm run build
npm start -w packages/server
# then open http://127.0.0.1:8787
```

### Platform sign-in

A service deployment that sits on an organization's AI platform sets
`BADGER_IDENTITY=platform-session`, and people arrive signed in through the
platform's own session. Badger reads the platform session cookie, checks it
against the platform's current-user endpoint over the internal network, and
maps the platform user ID to the person's external subject. Nothing about the
platform lives in code; every value below is configuration.

| Setting                             | Meaning                                                                                                                                                                  |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `BADGER_PLATFORM_URL`               | The platform's internal base URL, such as `https://platform.internal`.                                                                                                   |
| `BADGER_PLATFORM_CURRENT_USER_PATH` | The current-user endpoint, such as `/current-user`; it answers with `id`, `email`, `display_name`, `status`, and `app_access`.                                           |
| `BADGER_PLATFORM_SESSION_COOKIE`    | The cookie that carries the platform session token.                                                                                                                      |
| `BADGER_PLATFORM_CURRENT_USER_AUTH` | How Badger presents the token to the current-user endpoint: `cookie` (the default), in a cookie of the same name, or `bearer`, as an `Authorization: Bearer` header.     |
| `BADGER_PLATFORM_ISSUER`            | Required. A stable name for this platform, such as `https://platform.example`. People are matched on issuer and subject, so keep it when the platform's address changes. |
| `BADGER_PLATFORM_APP_GRANT`         | Optional app name the platform must grant the person, such as `workflow-app`.                                                                                            |
| `BADGER_PLATFORM_CACHE_SECONDS`     | How long a checked session is remembered; defaults to 30, and 0 disables the cache.                                                                                      |
| `BADGER_PLATFORM_TIMEOUT_MS`        | How long to wait for the platform; defaults to 3000.                                                                                                                     |

Set `BADGER_ALLOWED_ORIGINS` to the public origin, so a write authenticated by
a cookie is accepted only from Badger's own origin. Non-active platform users
are refused; a platform that cannot be reached yields "unavailable". This
adapter issues no Badger cookie of its own; Badger's own cookies, when a later
adapter issues one, are SameSite=Strict, HttpOnly, and Secure, and are named
apart from the platform's.

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
