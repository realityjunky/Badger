-- Existing immutable revisions keep their original content and default to
-- free text. New structured payloads and attachment receipts are revisioned.
alter table answer_revisions add column value jsonb;
alter table answer_revisions add column attachments jsonb not null default '[]'
  check (jsonb_typeof(attachments) = 'array');

create table answer_attachments (
  id text primary key,
  question_id text not null references questions (id),
  person_id text not null references people (id),
  name text not null,
  media_type text not null,
  size integer not null check (size > 0 and size <= 5242880),
  hash text not null check (hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null
);
create index answer_attachments_question_idx on answer_attachments (question_id, person_id);
create trigger answer_attachments_immutable before update or delete on answer_attachments
  for each row execute function refuse_questionnaire_revision_change();
create trigger answer_attachments_no_truncate before truncate on answer_attachments
  for each statement execute function refuse_questionnaire_revision_change();
