-- Keep the dashboard destination with the sign-in transaction, never in a
-- browser cookie or the provider's state. Existing transactions use My work,
-- and a longer destination falls back to it before it is stored.
alter table oidc_transactions add column return_path text
  check (octet_length(return_path) <= 2048);
