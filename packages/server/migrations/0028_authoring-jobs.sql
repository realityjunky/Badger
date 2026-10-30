alter table drafting_jobs drop constraint drafting_jobs_kind_check;
alter table drafting_jobs add constraint drafting_jobs_kind_check
  check (kind in ('draft-questions', 'draft-follow-ups', 'draft-plan', 'source-study', 'restate-answer', 'translate-question', 'import-open-questions', 'authoring-lane', 'review-vote'));
alter table drafting_jobs
  add column package_id text references workflow_packages (id),
  add column lane_id text;
alter table drafting_jobs add constraint drafting_jobs_authoring_check
  check ((kind in ('authoring-lane','review-vote')) = (package_id is not null and lane_id is not null));
create table accepted_authoring_outputs (
  job_id text primary key references drafting_jobs (id),
  package_id text not null references workflow_packages (id),
  revision integer not null check (revision > 0),
  person_id text not null references people (id),
  lane_id text not null,
  output jsonb not null,
  accepted_at timestamptz not null,
  unique (package_id, revision)
);
create trigger accepted_authoring_outputs_immutable before update or delete on accepted_authoring_outputs
  for each row execute function refuse_questionnaire_revision_change();
create trigger accepted_authoring_outputs_no_truncate before truncate on accepted_authoring_outputs
  for each statement execute function refuse_questionnaire_revision_change();
create table authoring_follow_ups (
  job_id text primary key references drafting_jobs (id),
  package_id text not null references workflow_packages (id),
  lane_id text not null,
  question_id text references questions (id),
  repair_job_id text references drafting_jobs (id),
  check ((question_id is null) <> (repair_job_id is null))
);
alter table workflow_packages add column assembled_hash text,
  add column assembled_at timestamptz,
  add column assembled_inventory jsonb;
create table package_assembly_requests (
  person_id text not null references people (id),
  request_id text not null,
  input_hash text not null,
  response jsonb not null,
  primary key (person_id, request_id)
);
create trigger package_assembly_requests_immutable before update or delete on package_assembly_requests
  for each row execute function refuse_questionnaire_revision_change();
