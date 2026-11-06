alter table drafting_jobs
  add column lease_kind text check (lease_kind in ('agent', 'dashboard')),
  add column lease_activity_at timestamptz;

update drafting_jobs
  set lease_kind = 'agent', lease_activity_at = updated_at
  where status = 'claimed';

alter table drafting_jobs
  add constraint drafting_jobs_session_check check (
    (status = 'claimed' and lease_kind is not null and lease_activity_at is not null)
    or
    (status <> 'claimed' and lease_kind is null and lease_activity_at is null)
  );
