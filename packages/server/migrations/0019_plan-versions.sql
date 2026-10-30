-- Canonical artifacts are immutable; approval lives in gate history.
create table plan_versions (
  id text primary key,
  workflow_version_id text not null references workflow_versions (id),
  dossier_hash text not null check (dossier_hash ~ '^[a-f0-9]{64}$'),
  number integer not null check (number > 0),
  hash text not null check (hash ~ '^[a-f0-9]{64}$'),
  canonical_json text not null check (jsonb_typeof(canonical_json::jsonb) = 'object'),
  created_by text not null references people (id),
  created_at timestamptz not null,
  unique (workflow_version_id, number),
  unique (workflow_version_id, hash),
  foreign key (workflow_version_id, dossier_hash) references dossier_versions (workflow_version_id, hash)
);
create trigger plan_versions_immutable
  before update or delete or truncate on plan_versions
  for each statement execute function refuse_questionnaire_revision_change();

-- As with dossiers, the latest head names the current plan version.
create table plan_heads (
  id text primary key,
  workflow_version_id text not null references workflow_versions (id),
  sequence integer not null check (sequence > 0),
  plan_hash text not null,
  selected_by text not null references people (id),
  selected_at timestamptz not null,
  unique (workflow_version_id, sequence),
  foreign key (workflow_version_id, plan_hash)
    references plan_versions (workflow_version_id, hash)
);
create trigger plan_heads_immutable
  before update or delete or truncate on plan_heads
  for each statement execute function refuse_questionnaire_revision_change();

alter table drafting_jobs drop constraint drafting_jobs_kind_check;
alter table drafting_jobs add constraint drafting_jobs_kind_check
  check (kind in ('draft-questions', 'draft-follow-ups', 'draft-plan'));
alter table drafting_jobs alter column round_id drop not null;
alter table drafting_jobs add constraint drafting_jobs_round_check
  check ((kind = 'draft-plan') = (round_id is null));
