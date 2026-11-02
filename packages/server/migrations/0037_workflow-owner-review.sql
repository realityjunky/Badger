create temporary table merged_workflow_reviewers on commit drop as
select reviewer.id as reviewer_id, owner.id as owner_id
from role_bindings reviewer
join role_bindings owner
  on owner.scope_type = 'workflow'
  and owner.workflow_id = reviewer.workflow_id
  and owner.role = 'Workflow owner'
  and (
    (reviewer.person_id is not null and owner.person_id = reviewer.person_id)
    or (reviewer.person_id is null and owner.person_id is null
      and lower(owner.email) = lower(reviewer.email))
  )
where reviewer.scope_type = 'workflow' and reviewer.role = 'Reviewer';

insert into question_recipients (question_id, binding_id)
select recipient.question_id, merged.owner_id
from question_recipients recipient
join merged_workflow_reviewers merged on merged.reviewer_id = recipient.binding_id
on conflict do nothing;

update inbox_items item
set binding_id = merged.owner_id, revision = item.revision + 1,
    updated_at = current_timestamp
from merged_workflow_reviewers merged
where item.binding_id = merged.reviewer_id
  and not exists (
    select 1 from inbox_items existing
    where existing.binding_id = merged.owner_id
      and existing.workflow_version_id = item.workflow_version_id
      and existing.gate = item.gate
      and existing.kind = item.kind
      and existing.event_id = item.event_id
  );

delete from role_bindings binding
using merged_workflow_reviewers merged
where binding.id = merged.reviewer_id;

update role_bindings
set role = 'Workflow owner', revision = revision + 1,
    updated_at = current_timestamp
where scope_type = 'workflow' and role = 'Reviewer';

alter table role_bindings drop constraint role_bindings_scope_role_check;
alter table role_bindings add constraint role_bindings_scope_role_check check (
  (scope_type = 'organization' and scope_id is null and workflow_id is null
    and role in ('Administrator', 'Auditor'))
  or (scope_type = 'group' and scope_id is not null and workflow_id is null
    and role in ('Group lead', 'Member'))
  or (scope_type = 'workflow' and scope_id is null and workflow_id is not null
    and role in ('Workflow owner', 'Engineer', 'Field expert', 'Operator', 'Observer'))
);
