# Configure sign-in for a Badger deployment

Service deployments select one people-facing adapter with `BADGER_IDENTITY`.
Personal access tokens work beside any adapter; a request carrying an invalid
bearer token never falls back to browser identity. All adapters use Badger's
existing issuer-and-subject identity and role bindings. Provider identity
alone grants no permission.

Set `BADGER_MODE=service`, `BADGER_DATABASE_URL`, `BADGER_ALLOWED_HOSTNAMES`,
`BADGER_ALLOWED_ORIGINS`, and storage mounts as described in the root README.
Run the server behind HTTPS. Keep deployment-specific proxy routes and
launchers outside this repository. The server applies its bundled migrations
before opening its socket. Back up and restore the database with the existing
[procedure](backup-and-restore.md).

## OpenID Connect

Register Badger as a confidential web client at the provider, supporting the
authorization-code flow, PKCE S256, and `client_secret_basic` authentication.
Enable the `openid email profile` scopes. The signed ID token must contain a
stable `sub` and an `email`; `name` is optional. Only a verified address lets
email invitations and bootstrap Administrator bindings resolve: an
`email_verified` claim decides when the provider sends one. For a provider
that never sends it, `BADGER_OIDC_EMAILS_VERIFIED=true` declares every address
it asserts verified. Set it only when the provider lets nobody assert an
address they do not own, such as a single-organization directory whose
administrators assign addresses; a multi-tenant or self-service provider that
accepts unverified addresses would let someone claim another person's
invitation or bootstrap role. Request the needed claims in your provider's
client configuration.

Example deployment settings (supply secrets through an env file or secret
mount; do not commit them):

```dotenv
BADGER_IDENTITY=oidc
BADGER_PUBLIC_URL=https://badger.example/badger
BADGER_BASE_PATH=/badger
BADGER_ALLOWED_HOSTNAMES=badger.example
BADGER_ALLOWED_ORIGINS=https://badger.example
BADGER_OIDC_ISSUER=https://identity.example/realms/company
BADGER_OIDC_CLIENT_ID=badger
BADGER_OIDC_CLIENT_SECRET=<supply-a-secret>
BADGER_BOOTSTRAP_ADMINISTRATORS=admin@example.com
```

Register this exact redirect URI:
`https://badger.example/badger/auth/oidc/callback`. At the root base path, use
`BADGER_PUBLIC_URL=https://badger.example` and the redirect URI
`https://badger.example/auth/oidc/callback`. `BADGER_PUBLIC_URL` is the external
URL, including the base path, without a query or fragment; it must agree with
`BADGER_BASE_PATH`. Callback URLs are derived from this setting, never from
`Host` or forwarded headers. Issuer and public URLs require HTTPS, except
HTTP on loopback for local testing. Issuer strings must stay stable because
they form part of every person's identity.

| Setting                            | Default          | Meaning                                                                                                                                   |
| ---------------------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `BADGER_OIDC_ISSUER`               | Required         | Discovery issuer; must match provider metadata and ID tokens exactly.                                                                     |
| `BADGER_OIDC_CLIENT_ID`            | Required         | Registered confidential client ID.                                                                                                        |
| `BADGER_OIDC_CLIENT_SECRET`        | Required         | Client secret, used only at the token endpoint.                                                                                           |
| `BADGER_PUBLIC_URL`                | Required         | External Badger URL including its base path.                                                                                              |
| `BADGER_SESSION_COOKIE`            | `badger_session` | Badger's own cookie name; choose a name distinct from platform and other application cookies. `__Host-` names require the root base path. |
| `BADGER_SESSION_SECONDS`           | `28800`          | Absolute session lifetime (8 hours); accepts 60–604800 seconds.                                                                           |
| `BADGER_OIDC_TIMEOUT_SECONDS`      | `3`              | Timeout for each discovery, token, or signing-key request; accepts 1–60 seconds.                                                          |
| `BADGER_OIDC_MAX_PENDING_SIGN_INS` | `10000`          | Maximum pending sign-in transactions; accepts a whole number from 1–1000000.                                                              |
| `BADGER_OIDC_EMAILS_VERIFIED`      | `false`          | Treat an ID token without an `email_verified` claim as verified; a claim the provider sends still decides.                                |

Opening the signed-out dashboard offers a sign-in link carrying the requested
page and query as `returnTo`. `GET <base>/auth/oidc/login` keeps that destination
only when it is a path on Badger's own origin under the configured base path.
Absolute URLs, network-path URLs (`//host`), backslashes, and paths outside
that base path fall back to My work. The destination is stored with the
server-side sign-in transaction, never in a cookie or the provider's state,
and checked again before the completed sign-in redirects there. The login
redirect to the provider uses fresh state, nonce and PKCE values. The callback
serves a small page that continues to a same-origin completion request. This extra navigation lets the transaction cookie remain
`SameSite=Strict` even though the provider callback arrives from another site;
there is a Continue link when JavaScript is disabled. See
[ADR 0021](adr/0021-oidc-browser-sessions.md).

Both transaction and session cookies are `Secure`, `HttpOnly`,
`SameSite=Strict`, scoped to the base path, and have no `Domain`. Transactions
expire after ten minutes and can be consumed once. The database stores only
hashes of cookie credentials. It stores the short-lived PKCE verifier, state
and nonce for pending transactions, and the verified identity for sessions;
it never retains provider access, refresh or ID tokens. Multiple server
processes share transactions and sessions through the database. Expired
records are removed when a new sign-in begins.

When a start would exceed `BADGER_OIDC_MAX_PENDING_SIGN_INS`, Badger evicts
the oldest pending transactions in the same database transaction as the new
one. Starts share a database lock across server processes, keeping the cap
even when they arrive together. A start is never refused because of the cap.
During a flood, a person's pending sign-in may be evicted: completing it then
shows "Sign-in is invalid or expired", and they start again. Each server
process logs `oidc.sign-ins-evicted` with an aggregated `evictedCount` at most
once per minute, on the next sign-in start. Rate-limit `<base>/auth/oidc/login`
per client at the deployment's reverse proxy, which can identify clients
before forwarding their requests.

Issuing or revoking a session records its actor, credential hash, target,
channel, reason and request ID in Activity, in the same database transaction.
This includes sign-in by a returning person whose profile has not changed.
A sign-in also gives the person's other live sessions the profile the provider
just proved, so an older device cannot restore a name or address the provider
has since changed.

An OIDC session proves the last successful sign-in until its absolute expiry
or local logout; Badger does not introspect it at the provider on each request
and does not implement provider logout or refresh tokens. Badger still checks
current local roles and bindings on every request. Failed discovery or token
transport returns `unavailable` (503), and malformed or invalid sign-ins
return `invalid` (400), without issuing a session. Start sign-in again after a
failed callback; the failure page links to a fresh sign-in, and the server
logs `oidc.sign-in-failed` with the stage, the outcome, and the reason, such as
the provider's OAuth error or a transport code, never a token or secret.
`POST <base>/auth/logout`, with an allowed `Origin`, deletes the current
session and clears its cookies. `GET <base>/api/v1/me` reports
`signOut: true` only for these sessions, and the dashboard's user menu then
offers **Sign out**; the other adapters have no Badger session to end.
Cookie-authenticated API writes likewise require an allowed `Origin`.

Verify a deployment by signing in with a provider-verified bootstrap
Administrator email, reading `<base>/api/v1/me`, inviting a second email to a
role, and signing in as that person. The role should apply at first verified
sign-in and stay with their issuer and subject when their email changes.

## Trusted headers

Use this adapter only behind a proxy that authenticates accounts before
forwarding them. Configure exact TCP peer IP addresses, not hostnames or CIDR
ranges:

```dotenv
BADGER_IDENTITY=trusted-header
BADGER_TRUSTED_HEADER_ISSUER=https://identity.example
BADGER_TRUSTED_PROXY_ADDRESSES=192.0.2.10,2001:db8::10
BADGER_TRUSTED_HEADER_EMAILS_VERIFIED=true
BADGER_BOOTSTRAP_ADMINISTRATORS=admin@example.com
```

| Setting                                 | Default            | Meaning                                                                                  |
| --------------------------------------- | ------------------ | ---------------------------------------------------------------------------------------- |
| `BADGER_TRUSTED_HEADER_ISSUER`          | Required           | Stable identity namespace for the proxy's subjects.                                      |
| `BADGER_TRUSTED_PROXY_ADDRESSES`        | Required           | Comma-separated exact IPv4/IPv6 socket peers. IPv4-mapped IPv6 addresses are recognized. |
| `BADGER_TRUSTED_HEADER_SUBJECT`         | `x-badger-subject` | Header carrying a stable, opaque provider subject.                                       |
| `BADGER_TRUSTED_HEADER_EMAIL`           | `x-badger-email`   | Header carrying the person's email.                                                      |
| `BADGER_TRUSTED_HEADER_NAME`            | `x-badger-name`    | Optional display name; defaults to email when absent.                                    |
| `BADGER_TRUSTED_HEADER_EMAILS_VERIFIED` | `false`            | Set true only if the proxy guarantees verification of every asserted email.              |

The proxy must strip every incoming identity header and replace it with its
own authenticated values, including on unauthenticated and error paths. Use
the provider's stable ID as the subject. Email addresses are mutable and
should not serve as subjects. Headers are singular: repeated subject/email
headers, missing values, invalid email, and commas in either identifying value
are refused. A display-name header sent once may contain commas, such as
`Ng, Alice`; a repeated display-name header is refused and the email is shown
instead. Badger checks header occurrences before Node joins their values.
Send values as UTF-8: a value whose bytes are valid UTF-8 is read as UTF-8,
so a name such as 张三 arrives intact.

The Badger MCP and the CLI send personal access tokens as
`Authorization: Bearer` and cannot complete the proxy's interactive login.
Let requests that carry a bearer token reach Badger without that login, for
example by exempting `<base>/api/` requests with an `Authorization` header,
and keep stripping identity headers from them. Badger authenticates the token
itself, and an invalid token never falls back to identity headers.

Restrict network access so only the authenticating proxy can reach Badger.
When another proxy or container bridge sits between them, the configured peer
is that final hop: it must enforce the same header replacement and must not
forward arbitrary client identity. `Forwarded`, `X-Forwarded-For` and
`X-Real-IP` never establish proxy trust. Requests from an unconfigured peer
ignore all identity headers and remain signed out. This adapter creates no
Badger session cookie; the proxy supplies its authenticated identity on every
request. Unsafe requests still need an allowed `Origin`.

Verified email bindings resolve through the same sign-in path as OIDC.
Unverified emails cannot claim invitations or bootstrap Administrator rights.
Neither adapter uses `BADGER_PLATFORM_ADMIN_MAPPING`, which remains exclusive
to `platform-session` and off by default.

Verify both paths: a request forwarded by the configured proxy should resolve
`<base>/api/v1/me`, while a direct client with identical identity headers and
forged forwarding headers must get 401. Then check a pending email binding by
signing in through the proxy for the first time.
