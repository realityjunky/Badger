alter table workflow_jobs drop constraint workflow_jobs_kind_check;
alter table workflow_jobs add constraint workflow_jobs_kind_check
  check (kind in ('source-check', 'init', 'generate'));
alter table workflow_jobs
  add column generation_confirmation_id text references gate_confirmations (id),
  add column creator_state_hash text check (creator_state_hash ~ '^[a-f0-9]{64}$');
alter table workflow_jobs drop constraint workflow_jobs_init_inputs_check;
alter table workflow_jobs add constraint workflow_jobs_init_inputs_check check (
  (kind in ('init', 'generate') and plan_version_hash is not null and proposal_hash is not null
    and proposal_confirmation_id is not null and request_id is not null
    and (kind = 'init' or (generation_confirmation_id is not null and creator_state_hash is not null)))
  or (kind = 'source-check' and plan_version_hash is null and proposal_hash is null
    and proposal_confirmation_id is null and replace_state_hash is null and request_id is null
    and generation_confirmation_id is null and creator_state_hash is null)
);

-- Each generation runs the Creator in a private namespace. Its exact state
-- bytes and package location become current in one transaction.
create table workflow_packages (
  id text primary key,
  workflow_version_id text not null references workflow_versions (id),
  generation_job_id text not null unique references workflow_jobs (id),
  generation_confirmation_id text not null references gate_confirmations (id),
  plan_version_hash text not null,
  proposal_hash text not null check (proposal_hash ~ '^[a-f0-9]{64}$'),
  state_hash text not null check (state_hash ~ '^[a-f0-9]{64}$'),
  scaffold_hash text not null check (scaffold_hash ~ '^[a-f0-9]{64}$'),
  package_path text not null,
  inventory jsonb not null check (jsonb_typeof(inventory) = 'array'),
  authoring_plan jsonb not null check (jsonb_typeof(authoring_plan) = 'object'),
  generated_at timestamptz not null,
  invalidated_at timestamptz,
  invalidation_reason text,
  foreign key (workflow_version_id, plan_version_hash)
    references plan_versions (workflow_version_id, hash)
);
create unique index workflow_packages_current on workflow_packages (workflow_version_id)
  where invalidated_at is null;
