alter table skill_question_resolution_outcomes
  drop constraint skill_question_resolution_outcomes_check,
  add check (kind = 'change' or successor_version_hash is null),
  add unique (resolution_id, skill_id, version_hash, kind);

create table skill_question_successor_links (
  id text primary key,
  resolution_id text not null unique,
  skill_id text not null,
  version_hash text not null,
  kind text generated always as ('change'::text) stored,
  successor_version_hash text not null check (successor_version_hash <> version_hash),
  actor_id text not null references people(id),
  confirmation_hash text not null,
  request_id text not null,
  created_at timestamptz not null,
  foreign key (resolution_id, skill_id, version_hash, kind)
    references skill_question_resolution_outcomes(resolution_id, skill_id, version_hash, kind),
  foreign key (skill_id, successor_version_hash) references skill_versions(skill_id, hash),
  unique (actor_id, request_id)
);
create index skill_question_successor_links_version_idx
  on skill_question_successor_links(skill_id, successor_version_hash);
create trigger skill_question_successor_links_immutable
  before update or delete or truncate on skill_question_successor_links
  for each statement execute function refuse_questionnaire_revision_change();

create view effective_skill_question_outcomes as
  select o.resolution_id, o.question_id, o.skill_id, o.version_hash, o.kind,
    coalesce(o.successor_version_hash, l.successor_version_hash) as successor_version_hash,
    case when o.kind = 'clarification' then o.version_hash
      else coalesce(o.successor_version_hash, l.successor_version_hash) end as applicability_version_hash,
    l.id as successor_link_id
  from skill_question_resolution_outcomes o
  left join skill_question_successor_links l on l.resolution_id = o.resolution_id;

alter function skill_version_is_referenced(text, text) rename to skill_version_has_questionnaire_references;
create function skill_version_is_referenced(text, text) returns boolean as $$
  select skill_version_has_questionnaire_references($1, $2) or exists (
    select 1 from skill_question_successor_links l where l.skill_id = $1 and l.successor_version_hash = $2
  );
$$ language sql stable;
