-- Questionnaire text is immutable by revision; the current records point to it.
create table questionnaires (
  workflow_version_id text primary key references workflow_versions (id),
  revision integer not null default 1 check (revision >= 1)
);

create table questionnaire_settings (
  workflow_id text primary key references workflows (id),
  round_size_limit integer check (round_size_limit > 0),
  revision integer not null default 1 check (revision >= 1)
);

create table question_rounds (
  id text primary key,
  workflow_version_id text not null references workflow_versions (id),
  number integer not null check (number > 0),
  title text not null,
  state text not null default 'draft' check (state in ('draft', 'published')),
  revision integer not null default 1 check (revision >= 1),
  created_by text not null references people (id),
  created_at timestamptz not null,
  published_at timestamptz,
  publication_hash text,
  unique (workflow_version_id, number)
);

create table questions (
  id text primary key,
  workflow_version_id text not null references workflow_versions (id),
  round_id text not null references question_rounds (id),
  revision integer not null default 1 check (revision >= 1),
  state text not null default 'draft' check (state in ('draft', 'open', 'answered')),
  position integer,
  -- Resolution is supplied by the subsequent resolutions feature. Answer
  -- writes already refuse a record the Engineer has resolved.
  resolved_at timestamptz,
  created_at timestamptz not null
);
create index questions_version_idx on questions (workflow_version_id, round_id);

create table question_revisions (
  question_id text not null references questions (id),
  revision integer not null check (revision >= 1),
  content jsonb not null check (jsonb_typeof(content) = 'object'),
  actor_id text not null references people (id),
  created_at timestamptz not null,
  primary key (question_id, revision)
);

-- Binding identity carries pending invitations through verified sign-in.
create table question_recipients (
  question_id text not null references questions (id),
  binding_id text not null references role_bindings (id) on delete cascade,
  primary key (question_id, binding_id)
);

alter table inbox_items drop constraint inbox_items_kind_check;
alter table inbox_items add constraint inbox_items_kind_check
  check (kind in ('gate-ready', 'gate-invalidated', 'question-assigned'));
alter table inbox_items add column question_id text references questions (id);

create table question_answers (
  question_id text not null references questions (id),
  person_id text not null references people (id),
  revision integer not null check (revision >= 1),
  primary key (question_id, person_id)
);
create table answer_revisions (
  question_id text not null,
  person_id text not null,
  revision integer not null check (revision >= 1),
  question_revision integer not null,
  text text not null,
  state text not null check (state in ('draft', 'submitted')),
  channel text not null check (channel in ('web', 'mcp')),
  agent_host text,
  created_at timestamptz not null,
  primary key (question_id, person_id, revision),
  foreign key (question_id, person_id) references question_answers (question_id, person_id),
  foreign key (question_id, question_revision) references question_revisions (question_id, revision),
  check ((channel = 'web' and agent_host is null) or (channel = 'mcp' and agent_host is not null))
);

create function refuse_questionnaire_revision_change() returns trigger as $$
begin
  raise exception 'Questionnaire revisions are immutable';
end;
$$ language plpgsql;

create trigger question_revisions_immutable before update or delete on question_revisions
  for each row execute function refuse_questionnaire_revision_change();
create trigger question_revisions_no_truncate before truncate on question_revisions
  for each statement execute function refuse_questionnaire_revision_change();
create trigger answer_revisions_immutable before update or delete on answer_revisions
  for each row execute function refuse_questionnaire_revision_change();
create trigger answer_revisions_no_truncate before truncate on answer_revisions
  for each statement execute function refuse_questionnaire_revision_change();
