alter table workflow_jobs drop constraint workflow_jobs_kind_check;
alter table workflow_jobs add constraint workflow_jobs_kind_check
  check (kind in ('source-check', 'init', 'generate', 'evaluate'));
alter table workflow_jobs
  add column evaluation_package_id text references workflow_packages (id),
  add column evaluation_package_hash text check (evaluation_package_hash ~ '^[a-f0-9]{64}$'),
  add column progress jsonb;
alter table workflow_jobs drop constraint workflow_jobs_init_inputs_check;
alter table workflow_jobs add constraint workflow_jobs_init_inputs_check check (
  (kind in ('init', 'generate') and plan_version_hash is not null and proposal_hash is not null
    and proposal_confirmation_id is not null and request_id is not null
    and (kind = 'init' or (generation_confirmation_id is not null and creator_state_hash is not null)))
  or (kind = 'source-check' and plan_version_hash is null and proposal_hash is null
    and proposal_confirmation_id is null and replace_state_hash is null and request_id is null
    and generation_confirmation_id is null and creator_state_hash is null)
  or (kind = 'evaluate' and evaluation_package_id is not null and evaluation_package_hash is not null
    and creator_state_hash is not null and request_id is not null)
);

-- Append-only service records. The immutable report file remains under the
-- Project root so public kernel readiness verifies the same evidence bytes.
create table evaluation_reports (
  id text primary key,
  workflow_version_id text not null references workflow_versions (id),
  job_id text not null unique references workflow_jobs (id),
  package_id text not null references workflow_packages (id),
  package_hash text not null check (package_hash ~ '^[a-f0-9]{64}$'),
  creator_state_hash text not null,
  starter_id text not null references people (id),
  starter_name text not null,
  started_at timestamptz not null,
  finished_at timestamptz not null,
  duration_milliseconds integer not null check (duration_milliseconds >= 0),
  report jsonb not null,
  report_path text not null unique,
  sandbox jsonb not null
);
create function refuse_evaluation_report_change() returns trigger as $$
begin
  raise exception 'Evaluation reports are immutable';
end;
$$ language plpgsql;
create trigger evaluation_reports_immutable before update or delete on evaluation_reports
  for each row execute function refuse_evaluation_report_change();
create index evaluation_reports_version_idx on evaluation_reports (workflow_version_id, finished_at desc, id desc);

alter table inbox_items drop constraint inbox_items_kind_check;
alter table inbox_items add constraint inbox_items_kind_check
  check (kind in ('gate-ready', 'gate-invalidated', 'question-assigned', 'answer-submitted', 'restatement-ready', 'question-reopened', 'concern-raised', 'job-submitted', 'evaluation-finished'));
alter table inbox_items add column evaluation_report_id text references evaluation_reports (id);
