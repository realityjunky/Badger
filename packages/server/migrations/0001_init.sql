-- People who can act in Badger. A person records one external identity; roles,
-- invitations, and profile addresses arrive in later reviewed migrations.
create table people (
  id text primary key,
  issuer text not null,
  subject text not null,
  email text not null,
  display_name text not null,
  status text not null default 'active' check (status in ('active', 'disabled')),
  revision integer not null default 1 check (revision >= 1),
  created_at timestamptz not null,
  updated_at timestamptz not null,
  constraint people_identity_unique unique (issuer, subject)
);

-- The append-only audit trail. Every write records its actor, the session or
-- token that acted, the channel, the target, the revisions or hashes before
-- and after, the reason, and the request that caused it. The worker may act
-- on its own; then no person is recorded, and the credential is the worker's.
create table audit_events (
  id text primary key,
  occurred_at timestamptz not null,
  actor_person_id text references people (id),
  credential_kind text not null check (credential_kind in ('session', 'token', 'local-implicit', 'worker')),
  credential_id text,
  channel text not null check (channel in ('web', 'mcp', 'worker')),
  action text not null,
  target_type text not null,
  target_id text,
  revision_before integer check (revision_before >= 1),
  hash_before text,
  revision_after integer check (revision_after >= 1),
  hash_after text,
  reason text,
  request_id text not null,
  constraint audit_events_actor_check check (
    actor_person_id is not null
    or (channel = 'worker' and credential_kind = 'worker')
  ),
  constraint audit_events_worker_credential_check check (
    credential_kind <> 'worker' or channel = 'worker'
  )
);

create index audit_events_occurred_at_idx
  on audit_events (occurred_at desc, id desc);
create index audit_events_actor_idx
  on audit_events (actor_person_id, occurred_at desc);

create function reject_audit_event_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'audit_events are append-only';
end;
$$;

create trigger audit_events_append_only
before update or delete on audit_events
for each row execute function reject_audit_event_mutation();

create trigger audit_events_no_truncate
before truncate on audit_events
for each statement execute function reject_audit_event_mutation();
