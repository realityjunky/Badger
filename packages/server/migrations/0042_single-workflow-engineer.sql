do $$
begin
  if exists (
    select workflow_id from role_bindings
    where scope_type = 'workflow' and role = 'Engineer'
    group by workflow_id having count(*) > 1
  ) then
    raise exception 'A workflow has more than one Engineer assignment'
      using hint = 'Remove extra Engineer role bindings, including pending invitations, before applying this migration.';
  end if;
end;
$$;

create unique index role_bindings_one_workflow_engineer_idx
  on role_bindings (workflow_id)
  where scope_type = 'workflow' and role = 'Engineer';
