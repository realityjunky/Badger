-- Findings describe discrepancies in the observer's records; they never change
-- local execution. Keep one current finding per class and its history in audit.
alter table workflow_runs add column integrity_findings jsonb not null default '[]'
  check (jsonb_typeof(integrity_findings) = 'array');
alter table workflow_runs add column recovery_required boolean not null default false;
alter table workflow_runs add column recovery jsonb;
create table run_recoveries (
  run_id text not null references workflow_runs(id),
  request_id text not null,
  result jsonb not null,
  primary key (run_id, request_id)
);
create trigger run_recoveries_immutable before update or delete or truncate on run_recoveries
  for each statement execute function refuse_publication_evidence_change();
create table run_recovery_notices (
  run_id text not null references workflow_runs(id),
  request_id text not null,
  primary key (run_id, request_id)
);
create trigger run_recovery_notices_immutable before update or delete or truncate on run_recovery_notices
  for each statement execute function refuse_publication_evidence_change();
