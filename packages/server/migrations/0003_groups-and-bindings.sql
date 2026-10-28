-- Groups nest, and a binding on a group applies to the groups inside it. The
-- sibling-name index keeps two groups from sharing a name under one parent,
-- comparing names without regard to case.
create table groups (
  id text primary key,
  parent_id text references groups (id),
  name text not null check (char_length(btrim(name)) between 1 and 120),
  revision integer not null default 1 check (revision >= 1),
  created_at timestamptz not null,
  updated_at timestamptz not null,
  constraint groups_not_its_own_parent check (parent_id is null or parent_id <> id)
);

create index groups_parent_idx on groups (parent_id);
create unique index groups_sibling_name_unique
  on groups (coalesce(parent_id, ''), lower(name));

-- A binding attaches a role to a scope. Until the person has signed in, a
-- binding is an invitation: it carries the email only, and the first sign-in
-- with that address records the person. From then on the binding follows the
-- person, so an address change at the provider moves no binding.
create table role_bindings (
  id text primary key,
  scope_type text not null check (scope_type in ('organization', 'group')),
  scope_id text references groups (id),
  role text not null check (
    role in ('Administrator', 'Auditor', 'Group lead', 'Member')
  ),
  person_id text references people (id),
  email text not null,
  invited_by text not null references people (id),
  revision integer not null default 1 check (revision >= 1),
  created_at timestamptz not null,
  updated_at timestamptz not null,
  constraint role_bindings_scope_role_check check (
    (
      scope_type = 'organization'
      and scope_id is null
      and role in ('Administrator', 'Auditor')
    )
    or (
      scope_type = 'group'
      and scope_id is not null
      and role in ('Group lead', 'Member')
    )
  )
);

create index role_bindings_person_idx on role_bindings (person_id, scope_type);
create index role_bindings_scope_idx on role_bindings (scope_type, scope_id);
create unique index role_bindings_pending_unique
  on role_bindings (
    scope_type, coalesce(scope_id, ''), lower(email), role
  )
  where person_id is null;
create unique index role_bindings_person_unique
  on role_bindings (scope_type, coalesce(scope_id, ''), person_id, role)
  where person_id is not null;
