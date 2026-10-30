alter table workflow_jobs drop constraint workflow_jobs_kind_check;
alter table workflow_jobs add constraint workflow_jobs_kind_check
  check (kind in ('source-check', 'init'));
alter table workflow_jobs
  add column plan_version_hash text,
  add column proposal_hash text check (proposal_hash ~ '^[a-f0-9]{64}$'),
  add column proposal_confirmation_id text references gate_confirmations (id),
  add column replace_state_hash text check (replace_state_hash ~ '^[a-f0-9]{64}$'),
  add column request_id text,
  add foreign key (workflow_version_id, plan_version_hash)
    references plan_versions (workflow_version_id, hash),
  add constraint workflow_jobs_init_inputs_check check (
    (kind = 'init' and plan_version_hash is not null and proposal_hash is not null
      and proposal_confirmation_id is not null and request_id is not null)
    or (kind = 'source-check' and plan_version_hash is null and proposal_hash is null
      and proposal_confirmation_id is null and replace_state_hash is null and request_id is null)
  ),
  add unique (requester_id, request_id);

-- Kernel state bytes are authoritative in the database. A job writes a private
-- kernel namespace, then commits its bytes and the job outcome together. Failed
-- transactions leave only a disposable workspace, never a new current state.
create table workflow_kernel_states (
  workflow_version_id text primary key references workflow_versions (id),
  plan_version_hash text not null,
  proposal_hash text not null check (proposal_hash ~ '^[a-f0-9]{64}$'),
  proposal_confirmation_id text not null references gate_confirmations (id),
  initialized_job_id text not null references workflow_jobs (id),
  state_namespace text not null,
  state_json text not null check (jsonb_typeof(state_json::jsonb) = 'object'),
  hash text not null check (hash ~ '^[a-f0-9]{64}$'),
  revision integer not null default 1 check (revision >= 1),
  initialized_at timestamptz not null,
  foreign key (workflow_version_id, plan_version_hash)
    references plan_versions (workflow_version_id, hash)
);
