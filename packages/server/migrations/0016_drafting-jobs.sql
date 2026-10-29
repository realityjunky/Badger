create table drafting_jobs (
  id text primary key,
  workflow_version_id text not null references workflow_versions (id),
  kind text not null check (kind in ('draft-questions', 'draft-follow-ups')),
  round_id text not null references question_rounds (id),
  parent_question_id text references questions (id),
  requester_id text not null references people (id),
  context_bundle jsonb not null,
  context_hash text not null check (context_hash ~ '^[a-f0-9]{64}$'),
  output_schema jsonb not null,
  status text not null default 'queued' check (status in ('queued', 'claimed', 'submitted', 'accepted', 'rejected', 'cancelled')),
  revision integer not null default 1 check (revision > 0),
  lease_id text,
  lease_person_id text references people (id),
  lease_token_id text references personal_access_tokens (id),
  lease_agent_host text,
  lease_until timestamptz,
  result jsonb,
  result_hash text,
  decision jsonb,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  check ((kind = 'draft-follow-ups') = (parent_question_id is not null)),
  check ((status = 'claimed') = (lease_id is not null and lease_person_id is not null and lease_until is not null)),
  check (status not in ('submitted', 'accepted', 'rejected') or (result is not null and result_hash is not null))
);
create index drafting_jobs_version_idx on drafting_jobs (workflow_version_id, created_at, id);

-- Sign-off replay retains the first response even after other inputs change.
create table drafting_job_decisions (
  person_id text not null references people (id),
  request_id text not null,
  job_id text not null references drafting_jobs (id),
  input_hash text not null,
  response jsonb not null,
  primary key (person_id, request_id)
);
create trigger drafting_job_decisions_immutable before update or delete on drafting_job_decisions
  for each row execute function refuse_questionnaire_revision_change();
create trigger drafting_job_decisions_no_truncate before truncate on drafting_job_decisions
  for each statement execute function refuse_questionnaire_revision_change();

alter table audit_events add column agent_host text;
alter table inbox_items drop constraint inbox_items_kind_check;
alter table inbox_items add constraint inbox_items_kind_check
  check (kind in ('gate-ready', 'gate-invalidated', 'question-assigned', 'restatement-ready', 'question-reopened', 'concern-raised', 'job-submitted'));
alter table inbox_items add column drafting_job_id text references drafting_jobs (id);
alter table inbox_items add constraint inbox_items_drafting_job_check
  check ((kind = 'job-submitted') = (drafting_job_id is not null));
