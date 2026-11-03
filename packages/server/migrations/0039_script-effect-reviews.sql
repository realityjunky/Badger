create table script_effect_revisions (
  skill_id text not null,
  source_hash text not null,
  revision integer not null check (revision > 0),
  kind text not null check (kind in ('legacy', 'proposal', 'review', 'clarification', 'confirmation')),
  content jsonb not null check (jsonb_typeof(content) = 'object'),
  actor_id text not null references people(id),
  recorded_at timestamptz not null,
  primary key (skill_id, source_hash, revision),
  foreign key (skill_id, source_hash) references skill_versions(skill_id, hash)
);

insert into script_effect_revisions (skill_id, source_hash, revision, kind, content, actor_id, recorded_at)
select v.skill_id, v.hash, 1, 'legacy',
  jsonb_build_object(
    'proposalRevision', null, 'sourceJobId', null, 'workflowVersionId', null,
    'note', 'Historical upload-time declarations. No Source study personal attestation was created.',
    'scripts', (
      select jsonb_agg(jsonb_build_object(
        'skillId', v.skill_id, 'hash', v.hash, 'path', s->>'path',
        'effects', case when jsonb_typeof(s->'sideEffects') = 'array' then s->'sideEffects' else '[]'::jsonb end,
        'rationale', 'Legacy upload-time declaration; review against the immutable source.',
        'evidence', '[]'::jsonb, 'conditionalBehavior', '',
        'uncertainty', 'This historical declaration needs current uploader review.',
        'reviewed', false, 'uncertaintyAnswer', ''
      ) order by s->>'path') from jsonb_array_elements(v.scripts) s
    )
  ), v.uploaded_by, v.created_at
from skill_versions v where jsonb_array_length(v.scripts) > 0;

create table script_effect_confirmations (
  actor_id text not null references people(id),
  request_id text not null,
  skill_id text not null,
  source_hash text not null,
  revision integer not null,
  confirmation_hash text not null check (confirmation_hash ~ '^[a-f0-9]{64}$'),
  response jsonb not null,
  primary key (actor_id, request_id),
  foreign key (skill_id, source_hash, revision) references script_effect_revisions(skill_id, source_hash, revision)
);

create function protect_script_effect_history() returns trigger as $$
begin
  raise exception 'Script effect history is append-only';
end;
$$ language plpgsql;
create trigger script_effect_revisions_append_only
  before update or delete or truncate on script_effect_revisions
  for each statement execute function protect_script_effect_history();
create trigger script_effect_confirmations_append_only
  before update or delete or truncate on script_effect_confirmations
  for each statement execute function protect_script_effect_history();

alter table inbox_items add column effect_skill_id text;
alter table inbox_items add column effect_source_hash text;
alter table inbox_items add foreign key (effect_skill_id, effect_source_hash)
  references skill_versions(skill_id, hash);
alter table inbox_items drop constraint inbox_items_kind_check;
alter table inbox_items add constraint inbox_items_kind_check check (kind in (
  'gate-ready', 'gate-invalidated', 'question-assigned', 'answer-submitted',
  'restatement-ready', 'question-reopened', 'concern-raised', 'job-submitted',
  'evaluation-finished', 'script-effect-review'
));
create unique index inbox_effect_review_pending_idx
  on inbox_items(person_id, effect_skill_id, effect_source_hash)
  where effect_skill_id is not null and state <> 'done';
