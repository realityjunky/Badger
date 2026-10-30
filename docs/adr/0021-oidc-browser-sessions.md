# Keep OIDC cookies Strict with a same-origin callback continuation

Status: accepted. Badger runs OIDC's authorization-code flow with PKCE, state,
nonce and signed ID token validation, then issues an opaque session. The
provider's cross-site callback serves a same-origin navigation before Badger
consumes the login transaction. Both the transaction cookie and session
cookie therefore remain Secure, HttpOnly and SameSite=Strict, as required by
#24, without weakening the transaction cookie to Lax or None. A Continue link
supports browsers without JavaScript; a hash-bound CSP permits only the
continuation script.

Transactions and sessions live in Postgres so callbacks can reach any server
process and sessions survive server restarts. Cookie credentials are stored
only as SHA-256 hashes. Transactions expire after ten minutes and are consumed
atomically once; sessions expire absolutely and carry identity alone. Provider
tokens are discarded after sign-in. Roles and email bindings remain under the
existing Badger authorization and sign-in authorities. Logout deletes the
session through a same-origin POST; provider logout and token refresh are not
part of this adapter.

Session issuance and revocation commit together with their Activity events;
issuance also resolves the person and pending email bindings in that same
transaction. Protocol validation proves identity before the service issues
the credential, keeping the identity adapter separate from Badger's records
of people and their roles.

Pending transactions are capped without serializing sign-in starts. A
database identity column numbers starts, and each start, in its own database
transaction, evicts through that column's index the pending transactions
started more than the cap's number of starts before it. A start's cost
therefore does not grow with the number pending, and a flood of anonymous
starts cannot hold the connection pool behind one lock. The table may exceed
the cap by the starts in flight, until the next start removes them. Refusing
starts at the cap was rejected in #82: a flood would block every sign-in.
