-- A workflow belongs to one Group. Each iteration keeps the frame it began
-- with, so editing the catalog never rewrites an earlier version's meaning.
create table workflows (
  id text primary key,
  group_id text not null references groups (id),
  name text not null,
  goal text not null check (char_length(btrim(goal)) between 1 and 4000),
  intent text not null check (intent in ('new-skill', 'upgrade-existing')),
  locale text not null,
  revision integer not null default 1 check (revision >= 1),
  created_at timestamptz not null,
  updated_at timestamptz not null,
  unique (group_id, name)
);

create table workflow_versions (
  id text primary key,
  workflow_id text not null references workflows (id),
  number integer not null check (number >= 1),
  name text not null,
  goal text not null,
  intent text not null check (intent in ('new-skill', 'upgrade-existing')),
  locale text not null,
  -- Stage states belong to this revision of the version. Later features
  -- derive them from their records and kernel results, never a client PATCH.
  stages jsonb not null check (jsonb_typeof(stages) = 'object'),
  revision integer not null default 1 check (revision >= 1),
  created_at timestamptz not null,
  updated_at timestamptz not null,
  unique (workflow_id, number)
);

-- Keep the existing invitation lifecycle for workflow roles, including
-- verified-email resolution, stable person identities, revisions, and audit.
alter table role_bindings add column workflow_id text references workflows (id);
alter table role_bindings drop constraint role_bindings_scope_type_check;
alter table role_bindings drop constraint role_bindings_role_check;
alter table role_bindings drop constraint role_bindings_scope_role_check;
alter table role_bindings add constraint role_bindings_scope_role_check check (
  (scope_type = 'organization' and scope_id is null and workflow_id is null
    and role in ('Administrator', 'Auditor'))
  or (scope_type = 'group' and scope_id is not null and workflow_id is null
    and role in ('Group lead', 'Member'))
  or (scope_type = 'workflow' and scope_id is null and workflow_id is not null
    and role in ('Workflow owner', 'Engineer', 'Field expert', 'Reviewer', 'Operator', 'Observer'))
);

drop index role_bindings_pending_unique;
drop index role_bindings_person_unique;
create unique index role_bindings_pending_unique
  on role_bindings (scope_type, coalesce(scope_id, workflow_id, ''), lower(email), role)
  where person_id is null;
create unique index role_bindings_person_unique
  on role_bindings (scope_type, coalesce(scope_id, workflow_id, ''), person_id, role)
  where person_id is not null;
create index role_bindings_workflow_idx on role_bindings (workflow_id);
