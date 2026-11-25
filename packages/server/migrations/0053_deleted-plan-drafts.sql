alter table drafting_jobs
  add column deleted_at timestamptz,
  add constraint drafting_jobs_deleted_plan_draft_check
    check (deleted_at is null or (kind = 'draft-plan' and status = 'cancelled'));
