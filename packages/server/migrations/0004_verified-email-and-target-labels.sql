-- Whether the identity provider vouched for the person's address at their
-- latest sign-in. Only a verified address identifies a person to a binding
-- made by email or to a bootstrap Administrator address; an address the
-- provider has not verified grants nothing.
alter table people add column email_verified boolean not null default false;

create index people_verified_email_idx
  on people (lower(email))
  where email_verified;

-- Invitations are matched by address at sign-in.
create index role_bindings_pending_email_idx
  on role_bindings (lower(email))
  where person_id is null;

-- What the target was when the action happened, in words a reader of the
-- Activity log can follow after the record itself has changed or gone, such
-- as the role, scope, and address of a removed binding.
alter table audit_events add column target_label text;
