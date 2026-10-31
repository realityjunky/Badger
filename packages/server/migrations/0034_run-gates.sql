-- Human answers bind the exact local runtime context. The mirror remains an observer.
-- A binding can recur, so it can have several gates; only a Run's most recent
-- gate can be open or deliver its answer.
create table run_gates (
  id text primary key,
  run_id text not null references workflow_runs(id),
  workflow_version_id text not null references workflow_versions(id),
  binding_hash text not null check (binding_hash ~ '^[a-f0-9]{64}$'),
  context jsonb not null,
  policy jsonb not null,
  state text not null check (state in ('open', 'answered', 'superseded')),
  created_at timestamptz not null
);
create index run_gates_binding_idx on run_gates(run_id, binding_hash);
create unique index run_gates_open_idx on run_gates(run_id) where state = 'open';
create table run_gate_answers (
  gate_id text primary key references run_gates(id),
  actor_id text not null references people(id),
  request_id text not null,
  confirmation_hash text not null check (confirmation_hash ~ '^[a-f0-9]{64}$'),
  answer jsonb not null,
  answered_at timestamptz not null,
  unique(actor_id, request_id)
);
create trigger run_gate_answers_immutable before update or delete or truncate on run_gate_answers
  for each statement execute function refuse_publication_evidence_change();
alter table inbox_items add column run_gate_id text references run_gates(id);
create index inbox_run_gate_idx on inbox_items(run_gate_id);
