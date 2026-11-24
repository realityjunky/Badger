alter table skill_versions
  add column label text,
  add column label_revision integer not null default 0 check (label_revision >= 0),
  add column retired_at timestamptz,
  add constraint skill_versions_label_format check (
    label is null or (
      length(label) <= 64 and
      label ~ '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'
    )
  ),
  add constraint skill_versions_label_unique unique (skill_id, label);

drop trigger skill_versions_immutable on skill_versions;
create trigger skill_versions_immutable
  before update of skill_id, hash, description, inventory, scripts, origin, uploaded_by, created_at
  on skill_versions for each row execute function refuse_skill_version_change();

alter table skill_versions drop constraint skill_versions_origin_check;
alter table skill_versions add constraint skill_versions_origin_check
  check (origin in ('upload', 'git', 'edit'));

create table skill_version_edit_origins (
  skill_id text not null,
  hash text not null,
  base_hash text not null check (base_hash <> hash),
  method text not null check (method in ('browser', 'upload')),
  edited_by text not null references people (id),
  created_at timestamptz not null,
  primary key (skill_id, hash, base_hash, method, edited_by),
  foreign key (skill_id, hash) references skill_versions (skill_id, hash) on delete cascade,
  foreign key (skill_id, base_hash) references skill_versions (skill_id, hash)
);
create index skill_version_edit_origins_base_idx on skill_version_edit_origins (skill_id, base_hash);

alter table skill_version_git_origins drop constraint skill_version_git_origins_skill_id_hash_fkey;
alter table skill_version_git_origins add foreign key (skill_id, hash)
  references skill_versions (skill_id, hash) on delete cascade;
drop trigger skill_version_git_origins_immutable on skill_version_git_origins;

create function guard_skill_origin_change() returns trigger as $$
begin
  if TG_OP <> 'DELETE' or exists (
    select 1 from skill_versions v where v.skill_id = OLD.skill_id and v.hash = OLD.hash
  ) then
    raise exception 'Skill version origins are immutable';
  end if;
  return OLD;
end;
$$ language plpgsql;

create trigger skill_version_git_origins_immutable
  before update or delete on skill_version_git_origins
  for each row execute function guard_skill_origin_change();
create trigger skill_version_edit_origins_immutable
  before update or delete on skill_version_edit_origins
  for each row execute function guard_skill_origin_change();
create trigger skill_version_edit_origins_no_truncate
  before truncate on skill_version_edit_origins
  for each statement execute function refuse_skill_version_change();

create table workflow_skill_pin_history (
  workflow_version_id text not null references workflow_versions (id),
  skill_id text not null,
  skill_version_hash text not null,
  primary key (workflow_version_id, skill_id, skill_version_hash),
  foreign key (skill_id, skill_version_hash) references skill_versions (skill_id, hash)
);
create index workflow_skill_pin_history_skill_version_idx
  on workflow_skill_pin_history (skill_id, skill_version_hash);

insert into workflow_skill_pin_history (workflow_version_id, skill_id, skill_version_hash)
select p.workflow_version_id, p.skill_id, p.skill_version_hash from workflow_skill_pins p
union
select w.id, v.skill_id, v.hash
from audit_events a
join workflow_versions w on w.id = split_part(a.target_id, ':', 1)
join skill_versions v on v.skill_id = split_part(a.target_id, ':', 2)
  and v.hash in (a.hash_before, a.hash_after)
where a.target_type = 'workflow_skill_pin'
  and a.action in ('workflow_skill_pin.created', 'workflow_skill_pin.updated', 'workflow_skill_pin.removed');

create trigger workflow_skill_pin_history_immutable
  before update or delete or truncate on workflow_skill_pin_history
  for each statement execute function refuse_skill_version_change();

create function skill_version_is_referenced(entry_id text, version_hash text)
returns boolean language sql stable as $$
  select exists (
    select 1 from workflow_skill_pin_history p where p.skill_id = $1 and p.skill_version_hash = $2
  ) or exists (
    select 1 from workflow_skill_pins p where p.skill_id = $1 and p.skill_version_hash = $2
  ) or exists (
    select 1 from skill_version_edit_origins o where o.skill_id = $1 and o.base_hash = $2
  ) or exists (
    select 1 from script_effect_revisions r where r.skill_id = $1 and r.source_hash = $2
  ) or exists (
    select 1 from inbox_items i where i.effect_skill_id = $1 and i.effect_source_hash = $2
  ) or exists (
    select 1 from question_imports q where q.skill_id = $1 and q.skill_version_hash = $2
  ) or exists (
    select 1 from working_dossier_revisions d
    where d.pins @> jsonb_build_array(jsonb_build_object('skillId', $1, 'hash', $2))
  ) or exists (
    select 1 from source_study_revisions r
    where r.content->'evidence' @> jsonb_build_array(jsonb_build_object('skillId', $1, 'hash', $2))
       or r.content->'producer' @> jsonb_build_object('skillId', $1, 'hash', $2)
       or r.content->'consumer' @> jsonb_build_object('skillId', $1, 'hash', $2)
  ) or exists (
    select 1 from question_revisions q
    where q.content->'evidence' @> jsonb_build_array(jsonb_build_object('skillId', $1, 'versionHash', $2))
  ) or exists (
    select 1 from dossier_versions d
    where d.canonical_json::jsonb #> '{dossier,sources}'
      @> jsonb_build_array(jsonb_build_object('id', $1, 'contentHash', $2))
  );
$$;

create function guard_skill_version_delete() returns trigger as $$
begin
  if skill_version_is_referenced(OLD.skill_id, OLD.hash) then
    raise exception 'Referenced Skill versions are immutable' using errcode = '23503';
  end if;
  return OLD;
end;
$$ language plpgsql;

create trigger skill_versions_referenced_delete
  before delete on skill_versions for each row execute function guard_skill_version_delete();
