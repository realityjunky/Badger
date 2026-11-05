create table personal_robots (
  id text primary key,
  person_id text not null references people (id),
  label text not null,
  language text not null check (language in ('en', 'zh')),
  enabled boolean not null default true,
  suspended boolean not null default false,
  replies_enabled boolean not null default false,
  target_ciphertext text not null,
  bot_key text not null unique,
  robot_key text not null,
  revision integer not null check (revision > 0),
  verified_at timestamptz,
  verification_hash text,
  verification_expires_at timestamptz,
  connection_state text not null default 'disconnected'
    check (connection_state in ('connecting', 'connected', 'disconnected', 'error')),
  connection_checked_at timestamptz,
  created_at timestamptz not null,
  updated_at timestamptz not null
);

create table personal_robot_routes (
  id text primary key,
  person_id text not null references people (id),
  event text not null check (event in ('gate-ready', 'gate-invalidated', 'question-assigned', 'answer-submitted', 'restatement-ready', 'question-reopened', 'concern-raised', 'job-submitted', 'evaluation-finished', 'script-effect-review')),
  scope_type text not null check (scope_type in ('all', 'group', 'workflow')),
  scope_id text not null,
  robot_id text references personal_robots (id) on delete set null,
  revision integer not null check (revision > 0),
  check ((scope_type = 'all' and scope_id = '') or (scope_type <> 'all' and scope_id <> '')),
  unique (person_id, event, scope_type, scope_id)
);

alter table notification_deliveries add column person_id text references people (id);
alter table notification_deliveries add column personal_robot_id text references personal_robots (id) on delete set null;
create index notification_deliveries_person_idx on notification_deliveries (person_id, created_at desc);
