-- One accepted configuration for every server/worker. Secrets and temporary
-- drafting evidence are deliberately separate from immutable Skill versions.
create table llm_configuration (
  singleton boolean primary key default true check (singleton),
  revision integer not null check (revision > 0),
  configuration jsonb not null,
  content_hash text not null,
  updated_at timestamptz not null
);

create table llm_secrets (
  reference text primary key,
  ciphertext text not null
);

create table skill_suggestion_previews (
  id text primary key,
  skill_id text not null references skills(id),
  person_id text not null references people(id),
  source_hash text not null,
  configuration_revision integer not null,
  binding jsonb not null,
  evidence jsonb not null,
  status text not null check (status in ('ready', 'running', 'finished')),
  result jsonb,
  expires_at timestamptz not null,
  started_at timestamptz
);
create index suggestion_preview_expiry on skill_suggestion_previews(expires_at);

create table llm_call_leases (
  id text primary key,
  person_id text not null references people(id),
  expires_at timestamptz not null
);
