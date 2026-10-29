-- Hypotheses remain drafts; confirmation is derived from a question's facts.
create table questionnaire_drafts (
  id text primary key,
  workflow_version_id text not null references workflow_versions (id),
  kind text not null check (kind in ('inference', 'assumption')),
  revision integer not null check (revision > 0)
);
create index questionnaire_drafts_version_idx on questionnaire_drafts (workflow_version_id, id);

create table questionnaire_draft_revisions (
  draft_id text not null references questionnaire_drafts (id),
  revision integer not null check (revision > 0),
  statement text not null,
  topic text not null,
  question_id text,
  question_revision integer,
  status text not null check (status in ('active', 'retired')),
  actor_id text not null references people (id),
  created_at timestamptz not null,
  primary key (draft_id, revision),
  foreign key (question_id, question_revision) references question_revisions (question_id, revision),
  check ((question_id is null) = (question_revision is null))
);
create trigger questionnaire_draft_revisions_immutable
  before update or delete or truncate on questionnaire_draft_revisions
  for each statement execute function refuse_questionnaire_revision_change();

-- Captured in the publication transaction, never reconstructed from timestamps.
create table questionnaire_round_snapshots (
  round_id text primary key references question_rounds (id),
  items jsonb not null check (jsonb_typeof(items) = 'array')
);
create trigger questionnaire_round_snapshots_immutable
  before update or delete or truncate on questionnaire_round_snapshots
  for each statement execute function refuse_questionnaire_revision_change();
