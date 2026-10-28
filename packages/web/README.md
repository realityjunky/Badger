# `@realityjunky/badger-web`

The collaborative service's dashboard, built with React, Ant Design, and
Vite. The server role serves the build from `dist/` and injects the
deployment's base path into the document, so one build works under any
prefix.

## Layout

| Path                    | Holds                                                                                                |
| ----------------------- | ---------------------------------------------------------------------------------------------------- |
| `src/theme/tokens.ts`   | The one token source: colors, layout sizes, type scale, radii, and the Ant Design theme.             |
| `src/styles/global.css` | Layout only; every color and the shared layout sizes come from the CSS variables `tokens.ts` writes. |
| `src/i18n/catalog.ts`   | zh and en message catalogs, keyed by the same message IDs.                                           |
| `src/app/navigation.ts` | The URL routes, the rail's sections, and the page-title lookup.                                      |
| `src/app/paths.ts`      | Base-path normalisation, API URLs, and reading the injected base path.                               |
| `src/preferences/`      | The person's choices: model, API client, and the provider that saves them and applies them.          |
| `src/shell/`            | The rail, top bar, and application frame.                                                            |
| `src/pages/`            | The pages. My work is the landing page at `/my-work`.                                                |
| `test/`                 | Pure-helper tests: tokens, contrast, catalogs, routes, preferences, and base paths.                  |
| `e2e/`                  | Playwright journeys and visual checks against the real service in local single-user mode.            |

## Behavior

- Every page has a URL. The root redirects to `/my-work`; deep links, refresh,
  and history all restore the page.
- Appearance and language are saved per person through
  `/api/v1/me/preferences`, with the revision the client read. A stale write
  is a conflict, not a silent overwrite.
- The rail is 228 px, or 64 px collapsed, and becomes a drawer below
  1024 px. The three-pane registry layout stacks below 1180 px.
- One token source feeds both the CSS variables and Ant Design's theme.
  Contrast is checked at AA in both themes; reduced motion stops the stage
  marker's animation.

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
root, and the implicit local Administrator.
