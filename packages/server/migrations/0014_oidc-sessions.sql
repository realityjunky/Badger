-- Browser transactions are short-lived, single-use, and bound to a random
-- browser cookie. Only hashes of cookie credentials are stored.
create table oidc_transactions (
  token_hash text primary key,
  state text not null,
  nonce text not null,
  code_verifier text not null,
  expires_at timestamptz not null
);
create index oidc_transactions_expiry_idx on oidc_transactions (expires_at);

-- Identity only: roles and bindings are always resolved by Badger on requests.
-- Provider access, refresh and ID tokens are never retained.
create table identity_sessions (
  token_hash text primary key,
  principal jsonb not null,
  created_at timestamptz not null,
  expires_at timestamptz not null
);
create index identity_sessions_expiry_idx on identity_sessions (expires_at);
