# `@realityjunky/badger-web`

The collaborative service's dashboard, built with React, Ant Design, and
Vite. The server role serves the build from `dist/` and injects the
deployment's base path into the document, so one build works under any
prefix. Every library the dashboard uses is a devDependency: the build bundles
them into `dist/`, so the server image carries the build and none of them.

## Layout

| Path                    | Holds                                                                                                        |
| ----------------------- | ------------------------------------------------------------------------------------------------------------ |
| `src/theme/tokens.ts`   | The one token source: colors, layout sizes, type scale, radii, and the Ant Design theme.                     |
| `src/styles/global.css` | Layout only; every color and the shared layout sizes come from the CSS variables `tokens.ts` writes.         |
| `src/i18n/catalog.ts`   | zh and en message catalogs, keyed by the same message IDs.                                                   |
| `src/app/navigation.ts` | The URL routes, the rail's sections, and the page-title lookup.                                              |
| `src/app/paths.ts`      | Base-path normalisation, API URLs, and reading the injected base path.                                       |
| `src/preferences/`      | The person's choices: model, API client, the saver that stores each change, and the provider.                |
| `src/api/`              | The Workflows, Skills, Admin, and Activity clients: scoped records, writes, revision conflicts, and filters. |
| `src/shell/`            | The rail, top bar, and application frame.                                                                    |
| `src/pages/`            | The pages. My work is the landing page; Workflows, Skills, Admin, and Activity read live records.            |
| `test/`                 | Pure-helper tests: tokens, contrast, catalogs, routes, preferences, saving, and base paths.                  |
| `e2e/`                  | Playwright journeys against the real service, including separate Engineer and expert sessions.               |

## Behavior

- Personal access token settings include **Connect your Agent**, with copyable
  stdio configurations for Claude Code, Codex, and WorkBuddy. The deployment's
  origin and base path are filled in, and the person chooses the local
  executable. Claude Code's `.mcp.json` reads `${BADGER_TOKEN}` from the
  environment, so the token stays out of a file teams often commit; for Codex
  and WorkBuddy the person replaces the token placeholder. The configuration
  connects the expert profile and never stores a token secret in dashboard
  preferences.

- The Questionnaire page has rounds and questions, the answer thread, and an
  evidence/history inspector. Engineers compose questions, retain revisions,
  and review a whole round before publishing it in priority order. Workflow
  versions have independent questionnaires; an optional workflow round limit
  defaults to unlimited. Named experts, all Field experts, and Workflow owners
  can be assigned, including pending invitations.
- Assigned questions link from My work. Answers accept any language, autosave
  private drafts one request at a time, and submit per question or per round.
  Typing during a save is retained. Conflicts retain local text and offer
  retry or an explicit reload; another device's revision is never overwritten
  automatically. Submitted answer revisions and their channels remain visible
  in history. A new question revision requires the expert to review it again.
- Questions support free text, single and multiple choice, yes/no, numbers
  with a fixed unit, tables, and files. Each type has composer settings and
  matching answer controls, backed by server validation. Every answer type
  can carry attachments; selection starts uploading and successful files
  join the autosaved draft. Limits and the examples-only warning appear next
  to the upload control. Submitted answers, their revision history, resolution
  reviews, and facts retain downloadable evidence. Files in private drafts
  remain visible only to their author.
- Engineers resolve answers into one or more formal facts, a published child
  question, a reasoned deferral, or withdrawal. Fact text uses the workflow
  locale and links to selected submitted answer revisions. The answering
  person acknowledges or disputes each restatement after reviewing it;
  disputes reopen the question and notify the Engineer. Answer or evidence
  changes require re-confirmation and preserve the earlier facts as history.
  Skill-internal deferrals appear on the Skills page with questionnaire links.
  Sign-offs require dashboard sessions and hash-bound review dialogs.
- One per-person event stream refreshes inboxes and open questionnaire and
  workflow records. Reconnects reload a current snapshot; polling every ten
  seconds and focus refresh recover when streaming is unavailable.
- Questionnaire's **Ledger and readiness** view shows all five ledger parts,
  expandable per-topic blockers, linked record histories, deferred resolutions,
  and changes since a chosen published round. Engineers create, revise, link,
  and retire inference and assumption drafts. The service's kernel handoff
  supplies all membership and readiness decisions. The view and comparison
  round have URLs and retain the deployment base path.
- Workflow versions include a **Dossier versions** panel (#50). Engineers
  author topic summaries, supporting fact links, and Node responsibilities,
  review kernel findings and the canonical snapshot, then compose an immutable
  version. Workflow owners review and approve its exact hash in a separate
  dialog. The panel opens on the current version, which may be an earlier one
  the Engineer composed again. Version selection has a URL; superseded
  artifacts remain readable, and the inbox links directly to pending or
  superseded dossier approvals.
- Every question has an ordered comment thread with the author's edit history.
- Workflow versions include **Plan versions** (#58). The approved dossier
  supplies a skeleton and pins. Engineers edit FactoryPlan JSON with live
  kernel findings, review the resulting canonical version, and save it, or
  request an Agent draft and review, edit, accept, or discard its suggestion.
  Workflow owners approve the exact plan and dossier hashes separately.
  The panel opens on, and edits start from, the current version; saving an
  earlier version's content selects it again. Historical versions have URLs;
  stale edits and approvals conflict, and a superseded dossier invalidates
  dependent approvals and notifies both roles. The Sources, dossier, plan, and
  proposal panes list every approval of their gate, with the approver, time,
  and reason, and mark the ones a later change superseded, so a re-pin never
  hides an earlier approval.
  Current workflow roles control posting and editing; Observers read threads.
  Field experts raise concerns from the questionnaire. Engineers open each
  concern from their inbox and review a hash-bound resolution: a new draft
  question, an accepted Fact source, or a decline with a reason. The question
  composer and round publication flow handle converted concerns. All records
  keep direct links and refresh through the existing live updates.

- Every page has a URL. The root redirects to `/my-work`; deep links, refresh,
  and history all restore the page.
- Appearance and language are saved per person through
  `/api/v1/me/preferences`, with the revision the client read. A stale write
  is a conflict, not a silent overwrite.
- Personal settings at `/settings/tokens` create, list, and revoke personal
  access tokens for Agents and the CLI. Creation asks for a name, profile
  scopes, and a lifetime (90 days by default). The secret is displayed once
  in a copy dialog and is cleared when closed or when leaving the tab; it is
  never saved to browser storage. Listed records show only the visible
  prefix, scopes, expiration, last use and channel, and status. Revocation
  requires confirmation and quotes the record's revision.
- The Admin page lists members, roles, groups, and pending invitations, and
  lets an Administrator create nested groups and invite people by email. The
  Activity page shows every recorded action with its actor, time, target,
  channel, and reason, filtered by actor, action, target type, and channel.
  Auditors and Administrators read all of it.
- Source drafting (#56) extends the job panel with source study, answer
  restatement, question translation, and numbered open-question imports.
  Engineers review and edit each result before a hash-bound confirmation.
  Restatements still await expert acknowledgement, and question history shows
  translation revisions and immutable import provenance. Source study links
  directly to the drafting panel.
- Workflow versions include Source study (#45): per-pin progress, fact and
  interface editors, retirement confirmation, and immutable record history.
  Evidence links open the exact record revision's cited, numbered lines in
  an inspector and survive refresh under the configured base path. Engineers
  review and mark each pinned version studied through the shared gate
  protocol; the server advances stages and invalidates changed studies.
- The rail is 228 px, or 64 px collapsed, and becomes a drawer below
  1024 px. The three-pane registry layout stacks below 1180 px.
- The Skills registry reads live group-owned entries, immutable versions,
  source inventories, and script side-effect declarations. Folder and zip
  selection starts a preview; a person declares script effects and confirms
  before the version is stored. Uploads warn against real data. Every version
  and file selection has a deep link, and any two versions can be compared
  with source previews. Uploaded markup is rendered as text. The server's
  capability response controls which create and upload actions are offered.
- One token source feeds both the CSS variables and Ant Design's theme.
  Contrast is checked at AA in both themes; reduced motion stops the stage
  marker's animation.
- The Workflows catalog reads live, scoped workflows. Creation asks for a
  Group, kernel-valid name, goal, intent, and locale. A workflow's version URL
  selects its saved frame and eight stage states. Its team panel shows role
  holders and invitations, and capable people assign or remove roles there.
  Workflow edits and version starts quote the revision the person reviewed;
  a conflict keeps the failed write visible until they reload and review.
- Workflows include **Notifications and reminders** (#57): waiting items with
  Remind, and for Workflow owners the team chat's robot settings and its
  Delivery log. Each logged post shows its robot, status, attempts, text, and
  recipients with how the post mentioned them, never their userids or mobile
  numbers. Under **Settings → Channel addresses**, Group leads and
  Administrators set a Group's default robot; its own Delivery log, polled
  like the workflow's, shows the default's test posts and failures. A refused
  robot change or Remind shows the server's reason, such as a setting the
  deployment still lacks. Copy reminder's text is written in the viewer's
  language from the parts Remind returns, with an absolute link from the
  page's origin and base path.

## Commands

```bash
npm run build            # typecheck and build to dist/
npm test                 # pure-helper tests (vitest)
npm run test:e2e         # Playwright journeys (build and install Chromium first)
npm run lint             # tsc --noEmit
npm run format:check     # prettier
```

The journeys start the service themselves through
`@realityjunky/badger-server/testing`, using PGlite, a temporary storage
root, and the implicit local Administrator. A second instance serves under
the base path `/badger`, the way a deployment behind a reverse proxy does,
and `e2e/base-path.spec.ts` loads the dashboard there.
