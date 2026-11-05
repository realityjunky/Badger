create table prompt_template_heads (
  template_id text primary key,
  revision integer not null check (revision >= 0)
);

create table prompt_template_revisions (
  template_id text not null references prompt_template_heads(template_id),
  revision integer not null check (revision > 0),
  body text not null check (length(body) between 1 and 30000),
  content_hash text not null check (content_hash ~ '^[a-f0-9]{64}$'),
  person_id text not null references people(id),
  created_at timestamptz not null,
  primary key (template_id, revision)
);

create trigger prompt_template_revisions_immutable
  before update or delete on prompt_template_revisions
  for each row execute function refuse_questionnaire_revision_change();
create trigger prompt_template_revisions_no_truncate
  before truncate on prompt_template_revisions
  for each statement execute function refuse_questionnaire_revision_change();
