-- A confirmation retains the reviewed input and the original commit response.
-- Replaying a request returns that response even after invalidation.
create table gate_confirmations (
  id text primary key,
  workflow_version_id text not null references workflow_versions (id),
  gate text not null,
  actor_id text not null references people (id),
  confirmed_at timestamptz not null,
  bound_hashes jsonb not null check (jsonb_typeof(bound_hashes) = 'object'),
  confirmation_hash text not null check (confirmation_hash ~ '^[a-f0-9]{64}$'),
  request_id text not null,
  result jsonb not null check (jsonb_typeof(result) = 'object'),
  revision integer not null default 1 check (revision >= 1),
  invalidated_at timestamptz,
  invalidation_reason text,
  superseded_by text references gate_confirmations (id),
  unique (actor_id, request_id)
);

create unique index gate_confirmations_current_idx
  on gate_confirmations (workflow_version_id, gate) where invalidated_at is null;
create index gate_confirmations_history_idx
  on gate_confirmations (workflow_version_id, gate, confirmed_at desc, id desc);

create table inbox_items (
  id text primary key,
  person_id text references people (id),
  -- Invitations resolve through the existing binding's verified identity.
  binding_id text references role_bindings (id) on delete cascade,
  workflow_version_id text not null references workflow_versions (id),
  gate text not null,
  kind text not null check (kind in ('gate-ready', 'gate-invalidated')),
  event_id text not null,
  state text not null default 'unread' check (state in ('unread', 'read', 'done')),
  revision integer not null default 1 check (revision >= 1),
  created_at timestamptz not null,
  updated_at timestamptz not null,
  unique (person_id, workflow_version_id, gate, kind, event_id),
  check ((person_id is null) <> (binding_id is null))
);

create index inbox_items_person_idx on inbox_items (person_id, created_at desc, id desc);
create unique index inbox_items_invitation_idx
  on inbox_items (binding_id, workflow_version_id, gate, kind, event_id) where binding_id is not null;
