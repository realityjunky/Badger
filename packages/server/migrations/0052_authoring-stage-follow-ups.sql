alter table authoring_follow_ups
  add column target_stage text,
  add column target_id text,
  add column target_hash text,
  add column plan_draft_job_id text references drafting_jobs (id),
  drop constraint authoring_follow_ups_check;

alter table authoring_follow_ups add constraint authoring_follow_ups_target_check
  check (case
    when target_stage is null then
      (question_id is null) <> (repair_job_id is null)
      and plan_draft_job_id is null and target_id is null and target_hash is null
    when target_stage in ('plan','sources','dossier','proposal') then
      question_id is null and repair_job_id is null
      and (plan_draft_job_id is not null) = (target_stage = 'plan')
      and (target_id is not null) = (target_stage <> 'proposal')
      and target_hash is not null and target_hash ~ '^[a-f0-9]{64}$'
    else false
  end);
