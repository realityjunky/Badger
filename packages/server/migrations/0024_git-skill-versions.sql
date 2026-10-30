alter table skill_versions drop constraint skill_versions_origin_check;
alter table skill_versions add constraint skill_versions_origin_check check (origin in ('upload', 'git'));

create table skill_repositories (
  id text primary key,
  skill_id text not null references skills (id),
  url text not null,
  registered_by text not null references people (id),
  created_at timestamptz not null,
  unique (skill_id, url),
  unique (skill_id, id)
);

-- Import receipts may be appended to an existing content identity. Its files,
-- declarations, and first origin remain immutable even when uploaded first.
create table skill_version_git_origins (
  skill_id text not null,
  hash text not null,
  repository_id text not null,
  repository text not null,
  commit_hash text not null check (commit_hash ~ '^([a-f0-9]{40}|[a-f0-9]{64})$'),
  imported_by text not null references people (id),
  created_at timestamptz not null,
  primary key (skill_id, hash, repository_id, commit_hash),
  foreign key (skill_id, hash) references skill_versions (skill_id, hash),
  foreign key (skill_id, repository_id) references skill_repositories (skill_id, id)
);

create trigger skill_repositories_immutable
  before update or delete on skill_repositories
  for each row execute function refuse_skill_version_change();
create trigger skill_repositories_no_truncate
  before truncate on skill_repositories
  for each statement execute function refuse_skill_version_change();
create trigger skill_version_git_origins_immutable
  before update or delete on skill_version_git_origins
  for each row execute function refuse_skill_version_change();
create trigger skill_version_git_origins_no_truncate
  before truncate on skill_version_git_origins
  for each statement execute function refuse_skill_version_change();
