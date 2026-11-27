create table mapped_package_outputs (
  package_id text not null references workflow_packages(id),
  revision integer not null check(revision > 0),
  lane_id text not null,
  job_id text not null references drafting_jobs(id),
  result_hash text not null,
  output jsonb not null,
  primary key(package_id, revision),
  unique(job_id,result_hash,lane_id)
);
create trigger mapped_package_outputs_immutable before update or delete on mapped_package_outputs
  for each row execute function refuse_questionnaire_revision_change();
