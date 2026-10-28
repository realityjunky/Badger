create table skills (
  id text primary key,
  group_id text not null references groups (id),
  name text not null check (char_length(btrim(name)) between 1 and 120),
  created_by text not null references people (id),
  created_at timestamptz not null,
  unique (group_id, name)
);

create table skill_versions (
  skill_id text not null references skills (id),
  hash text not null check (hash ~ '^[a-f0-9]{64}$'),
  description text not null,
  inventory jsonb not null,
  scripts jsonb not null,
  origin text not null check (origin = 'upload'),
  uploaded_by text not null references people (id),
  created_at timestamptz not null,
  primary key (skill_id, hash)
);

create index skills_group_idx on skills (group_id);

create function refuse_skill_version_change() returns trigger as $$
begin
  raise exception 'Skill versions are immutable';
end;
$$ language plpgsql;

create trigger skill_versions_immutable
  before update or delete on skill_versions
  for each row execute function refuse_skill_version_change();

create trigger skill_versions_no_truncate
  before truncate on skill_versions
  for each statement execute function refuse_skill_version_change();
