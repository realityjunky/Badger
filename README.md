# Badger

This repository holds Badger, a workflow Skill factory, as an npm workspace.
The workflow kernel is delivered, and the collaborative service planned in
[#24](https://github.com/realityjunky/Badger/issues/24) has its server in
`packages/server/`, its dashboard in `packages/web/`, and its local Badger MCP expert profile
in [`packages/mcp/`](packages/mcp/README.md).

| Path               | Holds                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Status                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/kernel/` | The workflow kernel, published as `@realityjunky/badger`: the Creator, WorkflowRuntime, and the `badger` CLI. See its [README](packages/kernel/README.md).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Delivered                                                                                                                                                                                                                                                                                                                                                                                 |
| `packages/server/` | The collaborative service's server role: reviewed SQL migrations, Postgres or PGlite, local single-user mode, platform sign-in, groups and role bindings by email, workflows and version frames, immutable Skill versions in a content-addressed store, scoped personal access tokens, workflow Skill pins, durable source-check jobs and workers, the Sources gate with replayable confirmations, the in-app inbox, OpenID Connect and trusted-header sign-in, Source study records, questionnaire rounds, answers, resolutions, threads, concerns, and the ledger with readiness, capability checks with recorded overrides, audited writes, the activity log, health, and the test harness. | Walking skeleton (#36), platform sign-in (#38), groups and roles (#40), workflows and versions (#41), Skill versions (#42), personal access tokens (#53), pins and source checks (#43), Sources gate and inbox (#44), source study (#45), questionnaire (#46), resolutions (#48), threads and concerns (#47), ledger and readiness (#49), OpenID Connect and trusted-header sign-in (#69) |
| `packages/web/`    | The web dashboard: navigation, design tokens, URL routing, zh/en catalogs, themes, personal settings with access tokens, Admin and Activity pages, the Workflows catalog with version stage tracks, pinned source controls and source-check inventories, the Sources gate, Source study, the Questionnaire page with resolutions, threads, concerns, and the ledger, the inbox on My work and the top-bar badge, MCP setup configurations, sign out, workflow role controls, and the Skills registry with uploads, previews, and version comparison.                                                                                                                                           | Shell (#37), admin and activity (#40), workflows (#41), Skills (#42), token settings (#53), pins and source checks (#43), Sources gate and inbox (#44), Source study (#45), Questionnaire (#46), resolutions (#48), threads and concerns (#47), ledger (#49), MCP setup (#54), sign out (#69)                                                                                             |
| `packages/mcp/`    | The local stdio MCP: the expert profile, with role- and scope-filtered tools and dashboard setup configurations. See its [README](packages/mcp/README.md).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Delivered (#54)                                                                                                                                                                                                                                                                                                                                                                           |
| `packages/<name>/` | One package each for the collaborative service's remaining surfaces: the host installer.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Planned (#24)                                                                                                                                                                                                                                                                                                                                                                             |

Everything shipped is generic: each deployment keeps its own launcher entries,
reverse-proxy routes, and deploy scripts outside this repository.

The Skills library (#42) now supports immutable folder and zip uploads,
kernel source identities and inventories, script side-effect declarations,
file previews, and version comparisons. An Engineer or Field expert on a
workflow uploads to that workflow's Group. See
[the server package](packages/server/README.md) for the API, permissions,
storage, and configurable upload limits.

Workflow versions can pin immutable Skill hashes from their Group. Pin changes
queue a durable source-check job for the worker; the Sources stage shows each
source's inventory, ignored files, script effects, and blockers. See
[ADR 0015](docs/adr/0015-pinned-skill-versions-and-source-check-jobs.md) for
the queue and workspace contract. After a passed check, the Engineer previews
the source set and confirms it at the Sources gate; a pin change invalidates
the confirmation and tells the Engineer and the Workflow owner through the
in-app inbox. See
[ADR 0016](docs/adr/0016-gate-confirmations-and-inbox.md).

Source study records source-derived facts with immutable file evidence and
independent interfaces between Skills. Engineers add, edit, and retire these
revisioned records, open the cited lines, and confirm each pinned version
studied. All writes are audited; changed records or pins reopen study. The
last study completion opens Questionnaire. See
[ADR 0019](docs/adr/0019-source-study-records-and-completion.md).

Deployments follow the [backup and restore procedure](docs/backup-and-restore.md)
and rehearse recovery before the first real workflow. Nightly scheduling belongs
to the deployment.

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
`BADGER_TEST_DATABASE_URL` points at one; CI runs both. CI uses self-hosted
GitHub Actions runners. Linux checks run automatically; Windows and macOS
run-storage checks are opt-in once their runners are available. See the
[runner setup and operations guide](docs/self-hosted-ci.md).

To try the container against Postgres:

```bash
docker compose up --build
# health report: http://localhost:8787/health
```

The image also carries the built dashboard. The compose file runs the server
role with `BADGER_IDENTITY=none`, so it reports health and serves the
signed-out page, and person routes answer 401. The image creates the storage
root, `/app/.badger`, with its `blob`, `workspaces`, and `runs` directories,
all owned by the server's user, so a deployment can mount one volume on the
root or give stored files and workspaces volumes of their own. For local single-user mode,
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

| Setting                             | Meaning                                                                                                                                                                    |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BADGER_PLATFORM_URL`               | The platform's internal base URL, such as `https://platform.internal`.                                                                                                     |
| `BADGER_PLATFORM_CURRENT_USER_PATH` | The current-user endpoint, such as `/current-user`; it answers with `id`, `email`, `display_name`, `status`, `app_access`, and optionally `email_verified` and `is_admin`. |
| `BADGER_PLATFORM_SESSION_COOKIE`    | The cookie that carries the platform session token.                                                                                                                        |
| `BADGER_PLATFORM_CURRENT_USER_AUTH` | How Badger presents the token to the current-user endpoint: `cookie` (the default), in a cookie of the same name, or `bearer`, as an `Authorization: Bearer` header.       |
| `BADGER_PLATFORM_ISSUER`            | Required. A stable name for this platform, such as `https://platform.example`. People are matched on issuer and subject, so keep it when the platform's address changes.   |
| `BADGER_PLATFORM_APP_GRANT`         | Optional app name the platform must grant the person, such as `workflow-app`.                                                                                              |
| `BADGER_PLATFORM_EMAILS_VERIFIED`   | Optional, off by default. Set it to `true` only if the platform verifies every address it returns; an answer's own `email_verified` still decides when present.            |
| `BADGER_PLATFORM_ADMIN_MAPPING`     | Optional, off by default. When `true`, a person the platform marks with `is_admin: true` becomes a Badger Administrator.                                                   |
| `BADGER_PLATFORM_CACHE_SECONDS`     | How long a checked session is remembered; defaults to 30, and 0 disables the cache.                                                                                        |
| `BADGER_PLATFORM_TIMEOUT_MS`        | How long to wait for the platform; defaults to 3000.                                                                                                                       |

Set `BADGER_ALLOWED_ORIGINS` to the public origin, so a write authenticated by
a cookie is accepted only from Badger's own origin. Non-active platform users
are refused; a platform that cannot be reached yields "unavailable". This
adapter issues no Badger cookie of its own. OIDC's Badger cookies are
SameSite=Strict, HttpOnly, and Secure, and are named apart from the platform's.

Platform administration grants no Badger role unless
`BADGER_PLATFORM_ADMIN_MAPPING` is on; then it maps to Administrator, and the
mapping is refused with an identity adapter that is not the platform.

Bindings by email and bootstrap Administrator addresses apply only to an
address the platform has verified. Without `email_verified` in its answer and
without `BADGER_PLATFORM_EMAILS_VERIFIED=true`, no address counts as verified,
so no invitation applies and no bootstrap Administrator is recognized. Do not
declare it for a platform that lets people register an address without proving
they own it.

### OpenID Connect and trusted headers

Other companies can select `BADGER_IDENTITY=oidc` for Badger's authorization-code
flow and its own Strict browser session, or `BADGER_IDENTITY=trusted-header`
behind an authenticating proxy. Trusted headers are accepted only from configured
TCP peers; forwarding headers never establish trust. Both adapters resolve
verified email bindings through the existing sign-in path. See
[identity adapter deployment settings](docs/identity-adapters.md) for client
registration, callback URLs, cookies, logout, proxy configuration, and checks.

### Groups, roles, and bindings

Badger decides authorization itself (ADR 0003). An Administrator creates
nested groups and binds people by email; a Group lead manages the members and
bindings of their group and the groups inside it, and a binding inherits
downward. A binding for an address no signed-in person has verified waits as
an invitation, and applies at the first sign-in that presents that address as
verified. An applied binding follows the person's issuer and subject, so an
address change at the provider moves no binding. A bootstrap Administrator
address, too, counts only once verified. Administrators and Auditors read the
Activity log; every request is checked on the server.

Badger refuses a person granting themselves an organization role. An
Administrator may override that block by giving a reason, from the Admin page
or as `overrideReason`, and the reason is recorded in the Activity log.

### Workflows and versions

Group leads create workflows in their Group or a Group inside it, with a
kernel-valid name, goal, intent (`new-skill` or `upgrade-existing`), and locale
(a language tag such as `en` or `zh-CN`). Creation records version 1 and makes
the creator a Workflow owner. Owners, Group leads, and Administrators assign
the workflow's six roles by email; one person may hold several. All workflow
roles read the workflow, while a Group's Members read its workflows through
Group inheritance. Workflow roles apply only to their workflow and its versions.

The Workflows page shows the catalog, links to workflow and version URLs, and
renders each version's eight stage states from the service. An Engineer or
Administrator starts another version. Version frames preserve the name, goal,
intent, and locale they began with; edits to the workflow affect future versions.
Stale edits, version starts, and binding removals return conflicts with the
current record and revision. The dashboard asks people to reload and review.

The API serves `/api/v1/workflows`, `/workflows/:id`, and
`/workflows/:id/versions[/:versionId]`. Create with `POST /workflows`, edit
the future frame with `PATCH /workflows/:id`, and quote the workflow's
`revision` in both edits and `POST /workflows/:id/versions`. Workflow roles use
`POST /api/v1/bindings` with `scopeType: "workflow"` and the workflow ID as
`scopeId`; removal quotes the binding's revision. Every write is audited.
Sources and Source study advance through their records and human gates;
clients cannot set stage states directly. The Questionnaire page stores
free-text questions, reviewed publication rounds, private answer drafts,
and submitted revisions (#46). Assigned people answer from My work; inboxes
and open records update through a per-person event stream with polling as
the fallback. Resolutions (#48), threads and concerns (#47), and the ledger
with readiness (#49) build on these records; dossier composition and the later
authoring gates follow.

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
