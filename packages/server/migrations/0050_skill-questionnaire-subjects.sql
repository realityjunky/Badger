-- A Skill Questionnaire is anchored to one exact, retained library version.
create table skill_questionnaires (
  id text primary key,
  skill_id text not null,
  version_hash text not null,
  revision integer not null default 1 check (revision >= 1),
  unique (skill_id, version_hash),
  unique (id, skill_id, version_hash),
  foreign key (skill_id, version_hash) references skill_versions(skill_id, hash)
);

alter table question_rounds alter column workflow_version_id drop not null;
alter table question_rounds add column skill_questionnaire_id text references skill_questionnaires(id);
alter table question_rounds add column subject_id text generated always as
  (coalesce(workflow_version_id, skill_questionnaire_id)) stored;
alter table question_rounds add check ((workflow_version_id is null) <> (skill_questionnaire_id is null));
alter table question_rounds add unique (skill_questionnaire_id, number);
alter table question_rounds add unique (id, skill_questionnaire_id);
create index question_rounds_subject_idx on question_rounds(subject_id, number);

alter table questions alter column workflow_version_id drop not null;
alter table questions add column skill_questionnaire_id text references skill_questionnaires(id);
alter table questions add column subject_id text generated always as
  (coalesce(workflow_version_id, skill_questionnaire_id)) stored;
alter table questions add check ((workflow_version_id is null) <> (skill_questionnaire_id is null));
alter table questions add foreign key (round_id, skill_questionnaire_id) references question_rounds(id, skill_questionnaire_id);
alter table questions add unique (id, skill_questionnaire_id);
create index questions_subject_idx on questions(subject_id, round_id);

-- Named Skill respondents are durable people. Current access is derived from
-- Group and workflow roles each time their assignments are used.
create table skill_question_recipients (
  question_id text not null,
  skill_questionnaire_id text not null,
  person_id text not null references people(id),
  primary key (question_id, person_id),
  foreign key (question_id, skill_questionnaire_id) references questions(id, skill_questionnaire_id)
);
create index skill_question_recipients_person_idx on skill_question_recipients(person_id, question_id);

create view skill_questionnaire_participants as
  with recursive ancestors(group_id, ancestor_id) as (
    select id, id from groups
    union
    select a.group_id, g.parent_id from ancestors a join groups g on g.id = a.ancestor_id
    where g.parent_id is not null
  ), grants as (
    select a.group_id, b.person_id, b.role from ancestors a
    join role_bindings b on b.scope_type = 'group' and b.scope_id = a.ancestor_id
    union all
    select w.group_id, b.person_id, b.role from workflows w
    join role_bindings b on b.scope_type = 'workflow' and b.workflow_id = w.id
    union all
    select g.id, b.person_id, b.role from groups g cross join role_bindings b
    where b.scope_type = 'organization' and b.role = 'Administrator'
  )
  select group_id, person_id,
    bool_or(role in ('Group lead', 'Administrator', 'Engineer', 'Field expert')) as can_coordinate
  from grants where person_id is not null group by group_id, person_id;

create view current_question_recipients as
  select r.question_id, b.person_id, b.id as binding_id, b.email
  from question_recipients r join role_bindings b on b.id = r.binding_id
  union all
  select r.question_id, r.person_id, null::text as binding_id, p.email
  from skill_question_recipients r
  join skill_questionnaires sq on sq.id = r.skill_questionnaire_id
  join skills s on s.id = sq.skill_id
  join skill_questionnaire_participants g on g.group_id = s.group_id and g.person_id = r.person_id
  join people p on p.id = r.person_id;

alter table inbox_items alter column workflow_version_id drop not null;
alter table inbox_items add column skill_questionnaire_id text references skill_questionnaires(id);
alter table inbox_items add check ((workflow_version_id is null) <> (skill_questionnaire_id is null));
alter table inbox_items add check (skill_questionnaire_id is null or (
  question_id is not null and person_id is not null and gate = 'questionnaire'
  and kind in ('question-assigned', 'answer-submitted', 'restatement-ready', 'question-reopened')
));
alter table inbox_items add foreign key (question_id, skill_questionnaire_id) references questions(id, skill_questionnaire_id);
create unique index inbox_skill_questionnaire_event_idx
  on inbox_items(person_id, skill_questionnaire_id, gate, kind, event_id)
  where skill_questionnaire_id is not null;

alter table question_resolutions add unique (id, question_id);
create table skill_question_resolution_outcomes (
  resolution_id text primary key,
  question_id text not null,
  skill_questionnaire_id text not null,
  skill_id text not null,
  version_hash text not null,
  kind text not null check (kind in ('clarification', 'change')),
  successor_version_hash text,
  foreign key (resolution_id, question_id) references question_resolutions(id, question_id),
  foreign key (question_id, skill_questionnaire_id) references questions(id, skill_questionnaire_id),
  foreign key (skill_questionnaire_id, skill_id, version_hash) references skill_questionnaires(id, skill_id, version_hash),
  foreign key (skill_id, successor_version_hash) references skill_versions(skill_id, hash),
  check ((kind = 'change') = (successor_version_hash is not null)),
  check (successor_version_hash is distinct from version_hash)
);
create index skill_question_resolution_successor_idx
  on skill_question_resolution_outcomes(skill_id, successor_version_hash);
create trigger skill_question_resolution_outcomes_immutable
  before update or delete or truncate on skill_question_resolution_outcomes
  for each statement execute function refuse_questionnaire_revision_change();

alter function skill_version_is_referenced(text, text) rename to skill_version_has_library_references;
create function skill_version_is_referenced(text, text) returns boolean as $$
  select skill_version_has_library_references($1, $2) or exists (
    select 1 from skill_questionnaires q where q.skill_id = $1 and q.version_hash = $2
  ) or exists (
    select 1 from skill_question_resolution_outcomes o where o.skill_id = $1 and o.successor_version_hash = $2
  );
$$ language sql stable;
