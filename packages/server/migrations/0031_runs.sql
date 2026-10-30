-- Runs remain authoritative on the executing host. These are bounded observer
-- snapshots and immutable trajectory events received idempotently by sequence.
create table workflow_runs (
  id text primary key,
  workflow_id text not null references workflows(id),
  publication_id text not null references published_packages(id),
  package_hash text not null check (package_hash ~ '^[a-f0-9]{64}$'),
  person_id text not null references people(id),
  person_name text not null,
  local_run_id text not null,
  host_label text not null check (length(host_label) between 1 and 200),
  agent_host text not null check (length(agent_host) between 1 and 200),
  test_run boolean not null,
  execution jsonb not null,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  last_sequence integer not null default 0 check (last_sequence >= 0),
  projection jsonb,
  continuation jsonb
);
create table workflow_run_events (
  run_id text not null references workflow_runs(id),
  sequence integer not null check (sequence > 0),
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  payload_hash text not null check (payload_hash ~ '^[a-f0-9]{64}$'),
  received_at timestamptz not null,
  primary key(run_id, sequence)
);
create trigger workflow_run_events_immutable before update or delete or truncate on workflow_run_events
  for each statement execute function refuse_publication_evidence_change();
create index workflow_runs_workflow_idx on workflow_runs(workflow_id, created_at desc, id desc);
create index workflow_runs_person_idx on workflow_runs(person_id, created_at desc, id desc);
