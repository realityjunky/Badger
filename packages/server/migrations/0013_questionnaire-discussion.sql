-- Comments keep their original position in a question's thread when edited.
create table question_comments (
  id text primary key,
  question_id text not null references questions (id),
  person_id text not null references people (id),
  position integer not null check (position > 0),
  revision integer not null default 1 check (revision >= 1),
  created_at timestamptz not null,
  unique (question_id, position)
);
create table comment_revisions (
  comment_id text not null references question_comments (id),
  revision integer not null check (revision >= 1),
  text text not null check (length(btrim(text)) > 0),
  actor_id text not null references people (id),
  created_at timestamptz not null,
  primary key (comment_id, revision)
);
create trigger comment_revisions_immutable before update or delete on comment_revisions
  for each row execute function refuse_questionnaire_revision_change();
create trigger comment_revisions_no_truncate before truncate on comment_revisions
  for each statement execute function refuse_questionnaire_revision_change();

-- A concern remains evidence as written; its one resolution is a separate record.
create table questionnaire_concerns (
  id text primary key,
  workflow_version_id text not null references workflow_versions (id),
  person_id text not null references people (id),
  text text not null check (length(btrim(text)) > 0),
  created_at timestamptz not null
);
create index questionnaire_concerns_version_idx on questionnaire_concerns (workflow_version_id);
create table concern_resolutions (
  concern_id text primary key references questionnaire_concerns (id),
  outcome text not null check (outcome in ('question', 'fact-source', 'declined')),
  reason text,
  question_id text unique references questions (id),
  actor_id text not null references people (id),
  confirmation_hash text not null check (confirmation_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null,
  check ((outcome = 'question') = (question_id is not null)),
  check ((outcome = 'declined' and reason is not null and length(btrim(reason)) > 0)
    or (outcome <> 'declined' and reason is null))
);
create trigger questionnaire_concerns_immutable before update or delete on questionnaire_concerns
  for each row execute function refuse_questionnaire_revision_change();
create trigger questionnaire_concerns_no_truncate before truncate on questionnaire_concerns
  for each statement execute function refuse_questionnaire_revision_change();
create trigger concern_resolutions_immutable before update or delete on concern_resolutions
  for each row execute function refuse_questionnaire_revision_change();
create trigger concern_resolutions_no_truncate before truncate on concern_resolutions
  for each statement execute function refuse_questionnaire_revision_change();

alter table inbox_items drop constraint inbox_items_kind_check;
alter table inbox_items add constraint inbox_items_kind_check
  check (kind in ('gate-ready', 'gate-invalidated', 'question-assigned', 'restatement-ready', 'question-reopened', 'concern-raised'));
alter table inbox_items add column concern_id text references questionnaire_concerns (id);
alter table inbox_items add constraint inbox_items_concern_check
  check ((kind = 'concern-raised') = (concern_id is not null));
