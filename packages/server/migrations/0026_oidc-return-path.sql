-- Keep the dashboard destination with the sign-in transaction, never in a
-- browser cookie or the provider's state. Existing transactions use My work.
alter table oidc_transactions add column return_path text;
