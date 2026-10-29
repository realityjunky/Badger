alter table questions drop constraint questions_state_check;
alter table questions add constraint questions_state_check check
  (state in ('draft', 'open', 'answered', 'confirmed', 'followed-up', 'deferred', 'withdrawn', 'needs-reconfirmation'));
alter table questions add column parent_question_id text references questions (id);
alter table questions add column resolution_revision integer not null default 0 check (resolution_revision >= 0);

create table question_resolutions (
  id text primary key,
  question_id text not null references questions (id),
  revision integer not null check (revision > 0),
  question_revision integer not null,
  kind text not null check (kind in ('confirmed', 'followed-up', 'deferred', 'withdrawn')),
  actor_id text not null references people (id),
  reason text,
  deferred_kind text check (deferred_kind in ('skill-internal', 'out-of-scope')),
  skill_id text references skills (id),
  child_question_id text references questions (id),
  confirmation_hash text not null,
  input_hash text not null,
  request_id text not null,
  created_at timestamptz not null,
  unique (question_id, revision),
  unique (actor_id, request_id),
  foreign key (question_id, question_revision) references question_revisions (question_id, revision),
  check ((kind = 'deferred' and reason is not null and length(trim(reason)) > 0 and deferred_kind is not null)
    or (kind <> 'deferred' and deferred_kind is null and skill_id is null)),
  check ((deferred_kind = 'skill-internal' and skill_id is not null) or (deferred_kind is distinct from 'skill-internal' and skill_id is null)),
  check ((kind = 'followed-up') = (child_question_id is not null))
);

create table confirmed_facts (
  id text primary key,
  resolution_id text not null references question_resolutions (id),
  content jsonb not null check (jsonb_typeof(content) = 'object'),
  hash text not null
);
create table fact_answer_revisions (
  fact_id text not null references confirmed_facts (id),
  question_id text not null,
  person_id text not null,
  revision integer not null,
  primary key (fact_id, person_id),
  foreign key (question_id, person_id, revision) references answer_revisions (question_id, person_id, revision)
);
create table fact_acknowledgements (
  id text primary key,
  fact_id text not null references confirmed_facts (id),
  person_id text not null references people (id),
  decision text not null check (decision in ('acknowledged', 'disputed')),
  reason text,
  confirmation_hash text not null,
  request_id text not null,
  created_at timestamptz not null,
  unique (fact_id, person_id),
  unique (person_id, request_id),
  check (decision <> 'disputed' or (reason is not null and length(trim(reason)) > 0))
);

alter table inbox_items drop constraint inbox_items_kind_check;
alter table inbox_items add constraint inbox_items_kind_check check
  (kind in ('gate-ready', 'gate-invalidated', 'question-assigned', 'restatement-ready', 'question-reopened'));
alter table inbox_items add column fact_id text references confirmed_facts (id);

create trigger question_resolutions_immutable before update or delete on question_resolutions
  for each row execute function refuse_questionnaire_revision_change();
create trigger question_resolutions_no_truncate before truncate on question_resolutions
  for each statement execute function refuse_questionnaire_revision_change();
create trigger confirmed_facts_immutable before update or delete on confirmed_facts
  for each row execute function refuse_questionnaire_revision_change();
create trigger confirmed_facts_no_truncate before truncate on confirmed_facts
  for each statement execute function refuse_questionnaire_revision_change();
create trigger fact_answer_revisions_immutable before update or delete on fact_answer_revisions
  for each row execute function refuse_questionnaire_revision_change();
create trigger fact_answer_revisions_no_truncate before truncate on fact_answer_revisions
  for each statement execute function refuse_questionnaire_revision_change();
create trigger fact_acknowledgements_immutable before update or delete on fact_acknowledgements
  for each row execute function refuse_questionnaire_revision_change();
create trigger fact_acknowledgements_no_truncate before truncate on fact_acknowledgements
  for each statement execute function refuse_questionnaire_revision_change();
