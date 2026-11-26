alter table authoring_follow_ups drop constraint authoring_follow_ups_target_check;
alter table authoring_follow_ups add constraint authoring_follow_ups_target_check
  check (case
    when target_stage is null then
      (question_id is null) <> (repair_job_id is null)
      and plan_draft_job_id is null and target_id is null and target_hash is null
    when target_stage in ('plan','sources','dossier','proposal') then
      question_id is null and repair_job_id is null
      and (plan_draft_job_id is null or target_stage = 'plan')
      and (target_id is not null) = (target_stage <> 'proposal')
      and target_hash is not null and target_hash ~ '^[a-f0-9]{64}$'
    else false
  end);

alter table drafting_jobs add column repair_feedback jsonb;
create table pending_plan_repairs (
  workflow_version_id text not null references workflow_versions(id),
  package_id text not null references workflow_packages(id),
  wave text not null check (wave in ('wave1','wave2','barrier')),
  planning_input_hash text not null,
  reports jsonb not null,
  source_draft_ids text[] not null,
  requested_at timestamptz not null,
  primary key (workflow_version_id,package_id,wave)
);
create index drafting_jobs_plan_repair_basis on drafting_jobs (workflow_version_id, (context_bundle->'planRepair'->>'basisHash'))
  where kind = 'draft-plan' and context_bundle ? 'planRepair';
create unique index drafting_jobs_one_active_plan_repair on drafting_jobs (workflow_version_id)
  where kind = 'draft-plan' and context_bundle ? 'planRepair' and deleted_at is null
    and status in ('queued','claimed','submitted');
