alter table drafting_jobs
  add column review_result jsonb,
  add column review_hash text check (review_hash ~ '^[a-f0-9]{64}$'),
  add column review_person_id text references people (id),
  add column review_updated_at timestamptz,
  add column review_revision integer not null default 0,
  add constraint drafting_jobs_review_check check (
    (review_revision = 0 and review_result is null and review_hash is null
      and review_person_id is null and review_updated_at is null)
    or
    (review_revision > 0 and review_revision <= revision and review_result is not null
      and review_hash is not null and review_person_id is not null and review_updated_at is not null)
  );

create table drafting_job_review_revisions (
  job_id text not null references drafting_jobs (id),
  revision integer not null check (revision > 0),
  result jsonb not null,
  result_hash text not null check (result_hash ~ '^[a-f0-9]{64}$'),
  person_id text not null references people (id),
  created_at timestamptz not null,
  primary key (job_id, revision)
);

create trigger drafting_job_review_revisions_immutable
  before update or delete on drafting_job_review_revisions
  for each row execute function refuse_questionnaire_revision_change();
create trigger drafting_job_review_revisions_no_truncate
  before truncate on drafting_job_review_revisions
  for each statement execute function refuse_questionnaire_revision_change();
