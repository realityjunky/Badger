-- Keep the dashboard destination with the sign-in transaction, never in a
-- browser cookie or the provider's state. Existing transactions use My work,
-- and a longer destination falls back to it before it is stored.
alter table oidc_transactions add column return_path text
  check (octet_length(return_path) <= 2048);

-- Number sign-in starts in order. Each start evicts the pending sign-ins more
-- than BADGER_OIDC_MAX_PENDING_SIGN_INS starts older than itself through this
-- index, so its cost does not grow with the table and no start waits for
-- another.
alter table oidc_transactions add column sequence bigint generated always as identity;
create unique index oidc_transactions_sequence_idx on oidc_transactions (sequence);
