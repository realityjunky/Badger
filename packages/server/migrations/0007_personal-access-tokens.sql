create table personal_access_tokens (
  id text primary key,
  person_id text not null references people (id),
  name text not null check (char_length(btrim(name)) between 1 and 120),
  prefix text not null unique,
  secret_hash text not null unique check (secret_hash ~ '^[a-f0-9]{64}$'),
  scopes text[] not null check (
    cardinality(scopes) between 1 and 3
    and scopes <@ array['engineer', 'expert', 'operator']::text[]
    and array_position(scopes, null) is null
  ),
  revision integer not null default 1 check (revision >= 1),
  created_at timestamptz not null,
  expires_at timestamptz not null check (expires_at > created_at),
  revoked_at timestamptz,
  last_used_at timestamptz,
  last_used_channel text check (last_used_channel in ('mcp')),
  rate_window_started_at timestamptz,
  rate_window_count integer not null default 0 check (rate_window_count >= 0)
);

create index personal_access_tokens_person_idx
  on personal_access_tokens (person_id, created_at desc, id desc);
