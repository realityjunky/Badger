-- Facts and interfaces have independent identities. Retirement retains both
-- the current record and its immutable revisions, including cited evidence.
create table source_study_records (
  id text primary key,
  workflow_version_id text not null references workflow_versions (id),
  kind text not null check (kind in ('fact', 'interface')),
  revision integer not null check (revision >= 1),
  status text not null check (status in ('active', 'retired')),
  content jsonb not null check (jsonb_typeof(content) = 'object'),
  created_at timestamptz not null,
  updated_at timestamptz not null
);
create index source_study_records_version_idx
  on source_study_records (workflow_version_id, kind, id);

create table source_study_revisions (
  record_id text not null references source_study_records (id),
  revision integer not null check (revision >= 1),
  status text not null check (status in ('active', 'retired')),
  content jsonb not null check (jsonb_typeof(content) = 'object'),
  actor_id text not null references people (id),
  recorded_at timestamptz not null,
  primary key (record_id, revision)
);

create function protect_source_study_revisions() returns trigger as $$
begin
  raise exception 'Source study revisions are append-only';
end;
$$ language plpgsql;
create trigger source_study_revisions_append_only
  before update or delete or truncate on source_study_revisions
  for each statement execute function protect_source_study_revisions();
