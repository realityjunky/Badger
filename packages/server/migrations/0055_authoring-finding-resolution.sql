alter table drafting_jobs drop constraint drafting_jobs_kind_check;
alter table drafting_jobs add constraint drafting_jobs_kind_check check(kind in
  ('draft-questions','draft-follow-ups','draft-plan','source-study','restate-answer','translate-question','import-open-questions','authoring-lane','review-vote','implement-finding','verify-finding','draft-dispositions'));
create table authoring_findings (
  id text primary key, workflow_version_id text not null references workflow_versions(id),
  subject_key text not null, problem text not null, disposition jsonb, revision integer not null default 1,
  reviewed boolean not null default false, dismissal text, adopted_hash text, verified_hash text, verified_protocol_hash text,
  work_revision integer not null default 1, candidate_source_hash text, verified_requirement_hash text,
  unique(workflow_version_id,subject_key)
);
create table finding_observations (
  id text primary key, workflow_version_id text not null references workflow_versions(id),
  job_id text not null references drafting_jobs(id), package_id text not null references workflow_packages(id),
  lane text not null, result_hash text not null, ordinal integer not null, finding jsonb not null,
  unique(job_id,result_hash,ordinal)
);
create table finding_observation_links (
  finding_id text not null references authoring_findings(id), observation_id text not null references finding_observations(id),
  primary key(finding_id,observation_id)
);
create table finding_report_versions (
  job_id text not null references drafting_jobs(id), revision_key text not null, result_hash text not null,
  primary key(job_id,revision_key)
);
create table finding_work (
  job_id text primary key references drafting_jobs(id), workflow_version_id text not null references workflow_versions(id),
  basis_hash text not null, subject_hash text, created_at timestamptz not null, source_candidate jsonb
);
create index finding_work_basis on finding_work(workflow_version_id,basis_hash);
create table finding_work_links (
  job_id text not null references finding_work(job_id), finding_id text not null references authoring_findings(id),
  primary key(job_id,finding_id)
);
create table finding_events (
  id text primary key, finding_id text not null references authoring_findings(id), kind text not null,
  person_id text not null references people(id), payload jsonb not null, created_at timestamptz not null
);
create table finding_requests (
  workflow_version_id text not null references workflow_versions(id), person_id text not null references people(id),
  request_id text not null, input_hash text not null, response jsonb not null,
  primary key(workflow_version_id,person_id,request_id)
);
create table package_implementation_files (
  workflow_version_id text not null references workflow_versions(id), path text not null,
  content text not null, hash text not null, job_id text not null references drafting_jobs(id),
  primary key(workflow_version_id,path)
);
alter table workflow_packages add column implementation_files jsonb not null default '[]';
alter table drafting_jobs add column superseded_by_findings boolean not null default false;
create index finding_observations_version on finding_observations(workflow_version_id,job_id);
create trigger finding_events_immutable before update or delete on finding_events
  for each row execute function refuse_questionnaire_revision_change();
