# Standalone Badger

- Scope: the workflow kernel and the collaborative service built around it (the server, the web dashboard, the Badger MCP, and the host installer). `docs/adr/0002-collaborative-service-in-scope.md` records the boundary; the delivery status in `packages/kernel/README.md` says what is built.
- Layout: the repository is an npm workspace, and the kernel (`@realityjunky/badger`) is its package in `packages/kernel/`. Put each new workspace package in `packages/<name>/` and list it in the root `workspaces` array after the packages it builds on (npm runs workspace scripts in that order).
- The server package (`@realityjunky/badger-server`) in `packages/server/` is the collaborative service's server role. Its schema is reviewed SQL in `packages/server/migrations/`: add a numbered migration, and never edit one that has shipped, meaning a deployment applied it or a release contains it. Its tests import only the testing entry point, `src/testing/index.ts` (`@realityjunky/badger-server/testing`), and test behavior at the HTTP seam; only migration checks run SQL, on a database from its `openTestDatabase`.
- Ship generic code. Each deployment's launcher entries, reverse-proxy routes, and deploy scripts live with that deployment, outside this repository.
- Keep WorkflowRuntime the only runtime authority and the kernel the only authoring authority: the service, dashboard, MCP, and installer call into them and never reimplement them.
- Keep formal Skills, references, tests, and package documentation in English.
- Preserve deterministic, hash-bound state transitions and explicit confirmation before writes, publication, or distribution. In the service, Agents draft and signed-in people sign off: confirming, acknowledging, approving, publishing, and answering gates stay with people (`docs/adr/0005-agents-draft-people-sign-off.md`).
- Use the domain language in `GLOSSARY.md`, and record hard-to-reverse decisions as ADRs in `docs/adr/`.
- Run `npm run build`, `npm test`, and `npm run format:check` from the repository root for delivery-sized changes; `npm test -w packages/kernel -- test/<file>.test.ts` runs one kernel test file.
