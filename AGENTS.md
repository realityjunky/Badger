# Standalone Badger

- Scope: the workflow kernel and the collaborative service built around it (the server, the web dashboard, the Badger MCP, and the host installer). `docs/adr/0002-collaborative-service-in-scope.md` records the boundary; the README's delivery status says what is built.
- Ship generic code. Each deployment's launcher entries, reverse-proxy routes, and deploy scripts live with that deployment, outside this repository.
- Keep WorkflowRuntime the only runtime authority and the kernel the only authoring authority: the service, dashboard, MCP, and installer call into them and never reimplement them.
- Keep formal Skills, references, tests, and package documentation in English.
- Preserve deterministic, hash-bound state transitions and explicit confirmation before writes, publication, or distribution. In the service, Agents draft and signed-in people sign off: confirming, acknowledging, approving, publishing, and answering gates stay with people (`docs/adr/0005-agents-draft-people-sign-off.md`).
- Use the domain language in `GLOSSARY.md`, and record hard-to-reverse decisions as ADRs in `docs/adr/`.
- Run `npm run build`, `npm test`, and `npm run format:check` for delivery-sized changes.
