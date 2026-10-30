-- Webhook secrets are authenticated ciphertext, never plaintext URLs.
alter table inbox_items drop constraint inbox_items_kind_check;
alter table inbox_items add constraint inbox_items_kind_check
  check (kind in ('gate-ready', 'gate-invalidated', 'question-assigned', 'answer-submitted', 'restatement-ready', 'question-reopened', 'concern-raised', 'job-submitted'));

create table person_notification_preferences (
  person_id text primary key references people (id),
  wecom_user_id text,
  mobile text,
  mention_events jsonb not null,
  revision integer not null check (revision > 0)
);

create table notification_channels (
  id text primary key,
  scope_type text not null check (scope_type in ('group', 'workflow')),
  group_id text references groups (id),
  workflow_id text references workflows (id),
  label text not null,
  language text not null check (language in ('en', 'zh')),
  webhook_ciphertext text not null,
  robot_key text not null,
  revision integer not null check (revision > 0),
  updated_at timestamptz not null,
  check ((scope_type = 'group' and group_id is not null and workflow_id is null)
      or (scope_type = 'workflow' and workflow_id is not null and group_id is null)),
  unique (group_id),
  unique (workflow_id)
);

create table notification_deliveries (
  id text primary key,
  workflow_id text references workflows (id),
  channel_id text not null,
  robot_key text not null,
  robot_label text not null,
  webhook_ciphertext text not null,
  recipients jsonb not null,
  content jsonb not null,
  status text not null default 'queued' check (status in ('queued', 'sending', 'retry', 'sent', 'failed', 'cancelled')),
  attempts integer not null default 0,
  error text,
  available_at timestamptz not null,
  lease_until timestamptz,
  claim_id text,
  created_at timestamptz not null,
  sent_at timestamptz
);
alter table notification_deliveries add column item_ids text[] not null default '{}';
alter table notification_deliveries add column language text not null default 'en' check (language in ('en', 'zh'));
alter table notification_deliveries add column reminder boolean not null default false;
create index notification_deliveries_pending_idx on notification_deliveries (available_at, id)
  where status in ('queued', 'retry', 'sending');

-- Inbox producers remain channel-independent. One transaction is one action,
-- including a round's many questions, recipients and invalidations.
-- Legacy records have no recoverable action identity. In particular, never
-- backfill the migration transaction's identity onto unrelated old actors.
alter table audit_events add column notification_action_id text;
alter table inbox_items add column notification_action_id text;
alter table audit_events alter column notification_action_id set default txid_current()::text;
alter table inbox_items alter column notification_action_id set default txid_current()::text;
create index audit_events_notification_action_idx on audit_events (notification_action_id);
create index inbox_notification_action_idx on inbox_items (notification_action_id);

create table notification_actions (
  id text primary key,
  created_at timestamptz not null,
  processed_at timestamptz
);
create function queue_notification_action() returns trigger as $$
begin
  insert into notification_actions (id, created_at) values (new.notification_action_id, new.created_at)
    on conflict do nothing;
  return new;
end;
$$ language plpgsql;
create trigger inbox_notification_action after insert on inbox_items
  for each row execute function queue_notification_action();

alter table notification_deliveries add column action_id text references notification_actions (id);
create unique index notification_deliveries_action_robot_idx on notification_deliveries (action_id, robot_key)
  where action_id is not null;

-- The pace belongs to the webhook, shared across workflows and worker processes.
create table notification_robots (
  robot_key text primary key,
  available_at timestamptz not null
);

create table notification_reminders (
  id text primary key,
  workflow_id text not null references workflows (id),
  item_key text not null,
  actor_id text not null references people (id),
  recipients jsonb not null,
  copy_text text,
  delivery_id text references notification_deliveries (id),
  created_at timestamptz not null
);
create index notification_reminders_item_idx on notification_reminders (item_key, created_at desc);
