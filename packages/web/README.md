# `@realityjunky/badger-web`

The collaborative service's dashboard, built with React, Ant Design, and
Vite. The server role serves the build from `dist/` and injects the
deployment's base path into the document, so one build works under any
prefix. Every library the dashboard uses is a devDependency: the build bundles
them into `dist/`, so the server image carries the build and none of them.

## Layout

| Path                    | Holds                                                                                                                                                                   |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/theme/tokens.ts`   | The one token source: colors, layout sizes, type scale, radii, and the Ant Design theme.                                                                                |
| `src/styles/global.css` | Layout only; every color and the shared layout sizes come from the CSS variables `tokens.ts` writes.                                                                    |
| `src/i18n/catalog.ts`   | zh and en message catalogs, keyed by the same message IDs.                                                                                                              |
| `src/app/navigation.ts` | The URL routes, the rail's sections, and the page-title lookup.                                                                                                         |
| `src/app/paths.ts`      | Base-path normalisation, API URLs, and reading the injected base path.                                                                                                  |
| `src/preferences/`      | The person's choices: model, API client, the saver that stores each change, and the provider.                                                                           |
| `src/api/`              | The API clients for every page: scoped records, writes, revision conflicts, and filters.                                                                                |
| `src/shell/`            | The rail, top bar, and application frame.                                                                                                                               |
| `src/documentation/`    | The guide overlay, stable help topics, and section navigation. Its English and Chinese copy lives in `src/i18n/documentation.ts`.                                       |
| `src/pages/`            | The pages. My work is the landing page; Workflows, Questionnaire, Skills, Runs, Evaluations, Activity, Admin, and Settings read live records, and every page has a URL. |
| `test/`                 | Pure-helper tests: tokens, contrast, catalogs, routes, preferences, saving, and base paths.                                                                             |
| `e2e/`                  | Playwright journeys against the real service, including separate Engineer and expert sessions.                                                                          |

## Behavior

- **Documentation** (#94) sits in the left sidebar's System section on every
  page and opens the current section's guide. The nine stable `help` query values
  are `my-work`, `workflows`, `questionnaire`, `skills`, `runs`, `evaluations`, `activity`,
  `admin`, and `settings`; for example `/skills?help=skills`. The
  `help=script-side-effects` guide contains definitions
  and synthetic examples for all five declarations. Links retain the current
  page, scope, filters, and anchor, including deployment and demo prefixes.
  The guide overlays the page so folder/zip selections, preview hashes, and
  declaration edits survive navigation within help and dismissal. Escape or
  Return to dashboard closes it and restores focus to its trigger. Help uses
  the dashboard language, theme, and text scale, including in read-only demo
  mode. Sharing or reloading a help URL opens that topic; file selections and
  other unsaved edits remain local to the current page session.

- **Demo mode** (#71) is available at `/demo/` under the deployment's base
  path, for example `/badger/demo/`. It uses the same dashboard with fixed
  synthetic records on My work, Workflows, Questionnaire, Skills, Runs,
  Evaluations, and Activity. Follow inbox items, inspect a Skill's files,
  read an answer thread and a Run gate, or inspect a passing evaluation.
  The persistent banner identifies the read-only demo. Sign-offs, uploads,
  inbox state changes, tokens, and administrative writes are unavailable.
  Appearance and language changes last only for the current page session.
  The account menu and signed-out page link to the demo.

  The server handles the entire demo namespace before authentication or
  live API dispatch. Only fixture GET/HEAD requests succeed; other methods
  are refused and unknown records never fall back to live records. Browser
  journeys run over that HTTP boundary without request interception or
  database seeding. Run just the demo journeys after building with
  `npm run test:e2e -w packages/web -- e2e/demo.spec.ts`.

- Personal access token settings include **Connect your Agent**, with copyable
  stdio configurations for Claude Code, Codex, and WorkBuddy from the host
  installer's renderer (#64). The deployment's origin and base path are filled
  in, and the person chooses the local executable. No configuration holds a
  token: Claude Code's and WorkBuddy's JSON reads `${BADGER_TOKEN}` from the
  environment, and Codex's `config.toml` forwards `BADGER_TOKEN` with
  `env_vars`, so the person sets `BADGER_TOKEN` where the Agent host starts.
  The panel names each host's project and user configuration files. The
  person also picks a work profile, written as `BADGER_MCP_PROFILE`: all
  permitted work (`auto`, the default), Engineer (`engineer`), Field expert
  (`expert`), or Operator (`operator`); a profile only narrows what the
  person's roles and token scopes allow. The configuration never stores a
  token secret in dashboard preferences.
  When the deployment URL or executable cannot be used, such as a plain-HTTP
  origin that is not loopback, the reason replaces the configuration; a
  publication's local install command does the same.

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
  and retire inference and assumption drafts; Retire asks first, naming the
  draft's kind and saying that a retired draft cannot be revised and leaves
  the ledger and readiness (#76). The service's kernel handoff supplies all
  membership and readiness decisions. The view and comparison round have URLs
  and retain the deployment base path.
- Workflow versions include a **Dossier versions** panel (#50). Engineers
  author topic summaries, supporting fact links, and Node responsibilities,
  review kernel findings and the canonical snapshot, then compose an immutable
  version. Workflow owners review and approve its exact hash in a separate
  dialog. The panel opens on the current version, which may be an earlier one
  the Engineer composed again. Version selection has a URL; superseded
  artifacts remain readable, and the inbox links directly to pending or
  superseded dossier approvals.
- Every question has an ordered comment thread with the author's edit history.
  Current workflow roles control posting and editing; Observers read threads.
  Field experts raise concerns from the questionnaire. Engineers open each
  concern from their inbox and review a hash-bound resolution: a new draft
  question, an accepted Fact source, or a decline with a reason. The question
  composer and round publication flow handle converted concerns. All records
  keep direct links and refresh through the existing live updates.
- Workflow versions include **Plan versions** (#58). The approved dossier
  supplies a skeleton and pins. Engineers edit FactoryPlan JSON with live
  kernel findings, review the resulting canonical version, and save it, or
  request an Agent draft and review, edit, accept, or discard its suggestion.
  Workflow owners approve the exact plan and dossier hashes separately.
  The panel opens on, and edits start from, the current version; saving an
  earlier version's content selects it again. Historical versions have URLs;
  stale edits and approvals conflict, and a superseded dossier invalidates
  dependent approvals and notifies both roles.
- Workflow versions include **Proposal and initialization** (#59). Once the
  current plan is approved, the pane shows the kernel's proposal: its hash,
  the plan version hash, the pinned sources, any blockers, and the current
  Creator state's hash when the project has one. Workflow owners approve the
  exact proposal in a review dialog. Engineers then queue initialization in a
  second dialog, which also names the Creator state's hash when it would
  replace that state, and the pane shows each initialization job's status. A
  superseded approval shows a warning.
- Workflow version changes (#52) appear on the records they affect.
  **Start new version** asks first, naming what the new version takes: the
  current frame and the latest version's Skill pins, facts, answers, and
  resolutions; pending questionnaire work moves to it, flagged items stay
  open, and approvals need a new review. An inherited version links to its
  predecessor. Inherited questions and source-study records link to their
  originals in the earlier version, and inherited facts and ledger items to
  that version's ledger. A question, fact, or source-study record whose cited
  evidence changed shows a warning and each changed file before and after,
  side by side, loaded only when expanded. The Sources, dossier, plan, and
  proposal panes list every approval of their gate, with the approver, time,
  and reason, and mark the ones a later change superseded, so a re-pin never
  hides an earlier approval.

- Every page has a URL. The root redirects to `/my-work`; deep links, refresh,
  and history all restore the page.
- Edits and refreshes of the current record keep its panels mounted while
  updated records load, preserving scroll position, expanded sections, and
  form state. Selecting another record resets its data, and access refusals
  remove records the person can no longer read.
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
  Groups tab opens each group's members at `/admin/groups/:groupId`.
  Administrators and the group's leads change an accepted Member or Group lead
  role in a confirmation dialog, against the revision they reviewed. The same
  binding keeps its person even after their email changes. Inherited roles are
  labeled with their granting group and are edited there. Member rows link to
  group role management. Group and text filters are retained in the URL.
  Integrations shows deployment configuration status for sign-in, invitation
  email, and WeCom delivery, with links to group and workflow settings.
  Administrators and Auditors read this status; credentials are never returned.
  Personal token management remains in Personal settings; the former
  `/admin/tokens` URL redirects to `/settings/tokens`.
  The Admin header identifies organization administration and uses these local
  filters instead of workflow controls.
  The top bar's Group selector filters the workflow catalog or Skill library;
  Workflow and Version open the corresponding record and preserve Questionnaire
  or Evaluations context. Runs select a workflow, and Skills select a group.
  Selection restores from deep links and browser history. Search returns
  permitted workflows, questions, and Skills in that context, including draft
  questions only for their Engineers and Administrators, and links to each
  record. Typing cancels older requests; failed searches offer Enter to retry.
  The version selector has room for its full placeholder.
  The Activity page shows every recorded action with its actor, time, target,
  channel, and reason, filtered by actor, action, target type, and channel.
  Auditors and Administrators read all of it.
- Questionnaire's **Drafting jobs and suggestions** panel (#55) has a URL and
  is open to Engineers and Administrators. They request Agent drafts of
  questions, or of follow-ups to a parent question, for a draft round, and
  see each job's state; a job whose inputs changed shows as cancelled. They
  review a submitted result, edit or remove each suggested question, and
  accept the rest into that round, which they still review and publish, or
  discard the result with a reason; both decisions take a hash-bound
  confirmation.
- Source drafting (#56) extends the job panel with source study, answer
  restatement, question translation, and numbered open-question imports.
  Engineers review and edit each result before a hash-bound confirmation.
  Restatements still await expert acknowledgement, and question history shows
  translation revisions and immutable import provenance. Source study links
  directly to the drafting panel.
- Each panel on a Workflow's detail page has its own Collapse/Expand button
  beside the title. Panels start expanded, preserve form edits while collapsed,
  and reopen when a direct link targets their content.
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
  selection starts a preview; effects stay pending while a person confirms
  before the version is stored. A selected folder that holds a `.git` folder,
  by the server's rule, is refused before anything is read or sent, with the
  server's message, even when it is also over the upload limits. Uploads
  warn against real data. Every version
  and file selection has a deep link, and any two versions can be compared
  with source previews. Uploaded markup is rendered as text. The server's
  capability response controls which create and upload actions are offered.
- **Import from Git** (#70) sits beside Upload version. It picks a registered
  repository or registers a new URL, takes a full commit hash, and previews
  the committed tree like an upload: the person confirms its exact hash
  before the version is stored. Fetched content never runs, and a
  version lists each repository and commit it was imported from.
- Script effects are reviewed inside Source study. The Engineer requests the
  existing per-Skill Agent job and separately sends its effect draft to the
  original uploader. The typed shared panel and `/source-reviews/:skillId/:hash`
  Inbox link offer narrow review access, citations, corrections, uncertainty
  answers, clarification, history, and explicit personal hash confirmation.
  Complete confirmed coverage gates study completion. Other workflows reuse
  the same entry/version's confirmation; corrections reopen dependent work.
  See [the review flow](../../docs/script-effect-review.md).
- One token source feeds both the CSS variables and Ant Design's theme.
  Contrast is checked at AA in both themes; reduced motion stops the stage
  marker's animation.
- The Workflows catalog reads live, scoped workflows. Creation asks for a
  Group, kernel-valid name, goal, intent, and locale. A workflow's version URL
  selects its saved frame and eight stage states. Its team panel shows one
  table row per person with their workflow roles together, and groups pending
  invitations by email. Capable people assign roles there, resend an email per
  person, and remove each role with its own labeled confirmation button.
  Its email field suggests registered members of the workflow's Group,
  including members inherited from ancestor Groups. Search by name or email
  and select a person to fill their address, or enter an address manually.
  Suggestions are available only to people who may manage workflow roles;
  selecting a person saves nothing until **Assign role** is pressed.
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

- Workflow versions include **Package** (#60). After initialization, Engineers
  review and confirm generation against the exact proposal, plan, and Creator
  state hashes. The panel follows worker progress and lists the scaffold hash,
  each file's owner and SHA-256, and the kernel's lanes, Waves, and dependencies.
  Files open in a read-only preview. Superseded packages remain visible with a
  warning; regeneration requires a fresh confirmation. Owners and other readers
  inspect the same inventory without the Engineer's generation controls.
- The Package panel also offers **Authoring lanes** (#61): request only ready
  lanes, inspect submitted claims and authored content, preview and confirm an
  acceptance or a rejection with a reason, follow linked questions and repair
  jobs, and confirm assembly once every lane is current. Lane results are
  refreshed while Agents work. Read-only people see status and history.
- The **Evaluations** page (#62) selects a workflow version and shows its
  current assembled package, with a link to its Package panel and whether a
  passing evaluation exists for it. Engineers confirm an evaluation of that
  exact package hash in a dialog that says domain scripts never run and the
  report is kept; the page follows the worker's phases, and the starter gets an
  inbox item when it finishes. Report history lists every report with its
  package hash, result, duration, and starter, marks reports of earlier
  packages, and opens each report's package checks, Authoring
  cross-validation, certification phases with their negative cases, and
  artifact receipts.
- Workflow versions include **Review and publication** (#63). For the current
  package the panel shows Authoring, runtime, and publication readiness with
  any blockers, and the review history. The Workflow owner or Administrator
  previews and confirms approval of the exact package hash, then previews and
  confirms publication using the same capability, even if they accepted
  Authoring lane outputs. Historical override reasons remain in review history.
  **Published versions** lists every
  published package with its publisher and time, and keeps its exact bytes
  after later Authoring or regeneration; inspecting one verifies its bytes and
  inventory before listing its files.
- Each published version offers **Install locally** (#64): the person picks
  install or uninstall, an Agent host, and project or user scope, sees where
  the Skills and the MCP configuration go, and copies a `badger-hosts` command
  bound to that publication and package hash. The command runs on their
  computer with `BADGER_TOKEN` set for an Operator token and only previews;
  a separate commit command must quote the preview's digest. The browser never
  writes local files.
- The **Runs** page (#65) lists the person's own Runs, or a chosen workflow's,
  with status, current Node, recovery state, who started each, its computer,
  and when it last reported; test Runs are marked. Each Run's page shows its
  publication, package hash, Agent host, pending action, and events received,
  then its Attempts, artifact receipts, findings, and original events a page
  at a time. When the outcome history is cut to the latest entries, the page
  says how many it shows and that the rest remain in Events.
- When a Run waits for a person (#66), its page shows the gate: the
  decision's choices with any inputs and a rationale, the manual stop, or the
  finalization's planned operations, with the evidence it binds and the
  authority it needs. A person who holds that authority reviews the answer in
  a dialog that says their signed-in identity and current authorities are
  recorded with it, at the shown Run revision, and confirms it; the Agent
  receives the answer on its next `next` or `status` call.
- A Run that needs recovery (#67) is marked in the Runs list and on its page,
  which asks the Operator's Agent to use `recover` on the Run's computer. The
  page then shows the latest recovery outcome, settled or still needing
  attention, with the time, Run revision, and event it was reported at.
  Findings list the service's integrity findings first, each with its
  evidence: a decision with no matching gate answer, an event sequence gap, or
  an execution that differs from the published package. Auditors see the
  same.

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
