-- The canonical text is the artifact. JSONB must never reserialize its identity.
create table dossier_versions (
  id text primary key,
  workflow_version_id text not null references workflow_versions (id),
  number integer not null check (number > 0),
  hash text not null check (hash ~ '^[a-f0-9]{64}$'),
  canonical_json text not null check (jsonb_typeof(canonical_json::jsonb) = 'object'),
  created_by text not null references people (id),
  created_at timestamptz not null,
  unique (workflow_version_id, number),
  unique (workflow_version_id, hash)
);
create trigger dossier_versions_immutable
  before update or delete or truncate on dossier_versions
  for each statement execute function refuse_questionnaire_revision_change();

-- The latest head names the current version. A composition that changes it
-- appends a head, so returning to an earlier version selects it again without
-- rewriting history.
create table dossier_heads (
  id text primary key,
  workflow_version_id text not null references workflow_versions (id),
  sequence integer not null check (sequence > 0),
  dossier_hash text not null,
  selected_by text not null references people (id),
  selected_at timestamptz not null,
  unique (workflow_version_id, sequence),
  foreign key (workflow_version_id, dossier_hash)
    references dossier_versions (workflow_version_id, hash)
);
create trigger dossier_heads_immutable
  before update or delete or truncate on dossier_heads
  for each statement execute function refuse_questionnaire_revision_change();
