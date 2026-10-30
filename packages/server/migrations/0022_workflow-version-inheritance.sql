alter table workflow_versions add column inherited_from_version_id text
  references workflow_versions (id);

-- Copying a record carries its original decision, never a new sign-off.
-- This immutable mapping also pins the source revision if that version changes.
create table workflow_record_origins (
  workflow_version_id text not null references workflow_versions (id),
  record_type text not null check (record_type in
    ('round', 'question', 'resolution', 'fact', 'acknowledgement', 'source-study', 'draft')),
  record_id text not null,
  source_workflow_version_id text not null references workflow_versions (id),
  source_record_id text not null,
  source_revision integer not null check (source_revision > 0),
  primary key (workflow_version_id, record_type, record_id),
  unique (workflow_version_id, record_type, source_record_id),
  check (workflow_version_id <> source_workflow_version_id)
);
create trigger workflow_record_origins_immutable before update or delete or truncate
  on workflow_record_origins for each statement
  execute function refuse_questionnaire_revision_change();

-- Receipts retain their immutable identity and hash in inherited answers.
create table inherited_answer_attachments (
  question_id text not null references questions (id),
  attachment_id text not null references answer_attachments (id),
  primary key (question_id, attachment_id)
);
create trigger inherited_answer_attachments_immutable before update or delete or truncate
  on inherited_answer_attachments for each statement
  execute function refuse_questionnaire_revision_change();
