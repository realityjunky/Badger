create table working_dossier_revisions (
  workflow_version_id text not null references workflow_versions(id),
  revision integer not null check (revision > 0),
  edit_id text not null,
  edit_hash text not null check (edit_hash ~ '^[a-f0-9]{64}$'),
  pins_hash text not null check (pins_hash ~ '^[a-f0-9]{64}$'),
  pins jsonb not null check (jsonb_typeof(pins) = 'array'),
  content jsonb not null check (jsonb_typeof(content) = 'object'),
  saved_by text not null references people(id),
  saved_at timestamptz not null,
  primary key (workflow_version_id, revision),
  unique (workflow_version_id, edit_id)
);
create trigger working_dossier_revisions_immutable
  before update or delete or truncate on working_dossier_revisions
  for each statement execute function refuse_questionnaire_revision_change();
