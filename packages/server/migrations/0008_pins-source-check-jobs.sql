-- Pins bind one workflow version to immutable Skill content. A workflow
-- version has at most one upgrade source, while ordinary sources are keyed by
-- the Skill entry so an Engineer can replace a version without changing the
-- workflow's meaning by accident.
create table workflow_skill_pins (
  workflow_version_id text not null references workflow_versions (id),
  skill_id text not null references skills (id),
  skill_version_hash text not null,
  purpose text not null default 'source'
    check (purpose in ('source', 'upgrade-source')),
  revision integer not null default 1 check (revision >= 1),
  pinned_by text not null references people (id),
  created_at timestamptz not null,
  updated_at timestamptz not null,
  primary key (workflow_version_id, skill_id),
  foreign key (skill_id, skill_version_hash)
    references skill_versions (skill_id, hash)
);

create unique index workflow_skill_pins_upgrade_source_idx
  on workflow_skill_pins (workflow_version_id)
  where purpose = 'upgrade-source';

create index workflow_skill_pins_version_idx
  on workflow_skill_pins (workflow_version_id, purpose, skill_id);

-- A worker job is durable even when the worker exits between claiming and
-- completing it. The claiming worker renews its lease while it works; once a
-- lease lapses, another worker may take the job over, and only the current
-- claimant may record the outcome. A pin change cancels a queued job of the
-- previous pin set. `outcome` is JSON so a blocked source check can retain all
-- of its inventory and finding details without a second history table.
create table workflow_jobs (
  id text primary key,
  kind text not null check (kind in ('source-check')),
  workflow_version_id text not null references workflow_versions (id),
  requester_id text not null references people (id),
  status text not null check (status in ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  requested_at timestamptz not null,
  started_at timestamptz,
  finished_at timestamptz,
  lease_until timestamptz,
  worker_id text,
  pins_hash text not null check (pins_hash ~ '^[a-f0-9]{64}$'),
  outcome jsonb check (outcome is null or jsonb_typeof(outcome) = 'object'),
  error text,
  revision integer not null default 1 check (revision >= 1)
);

create index workflow_jobs_queue_idx
  on workflow_jobs (status, requested_at, id);
create index workflow_jobs_version_idx
  on workflow_jobs (workflow_version_id, status, requested_at desc);

-- One workflow version's kernel transitions run one at a time. A claim skips a
-- job whose version already has a running job, and this index refuses the
-- second of two claims that race for one version.
create unique index workflow_jobs_running_version_idx
  on workflow_jobs (workflow_version_id)
  where status = 'running';

create function notify_workflow_job() returns trigger as $$
begin
  perform pg_notify('badger_workflow_jobs', new.id);
  return new;
end;
$$ language plpgsql;

create trigger workflow_jobs_notify
  after insert on workflow_jobs
  for each row execute function notify_workflow_job();

-- The latest source check is a read model of one exact pin set. The job keeps
-- the history of requests and outcomes, while this row drives the Sources
-- stage and is replaced whenever the pins change.
create table workflow_source_checks (
  id text primary key,
  workflow_version_id text not null unique references workflow_versions (id),
  job_id text references workflow_jobs (id),
  pins_hash text not null check (pins_hash ~ '^[a-f0-9]{64}$'),
  status text not null check (status in ('queued', 'running', 'passed', 'blocked', 'failed')),
  sources jsonb not null default '[]'::jsonb check (jsonb_typeof(sources) = 'array'),
  blockers jsonb not null default '[]'::jsonb check (jsonb_typeof(blockers) = 'array'),
  workspace_path text,
  revision integer not null default 1 check (revision >= 1),
  requested_at timestamptz not null,
  started_at timestamptz,
  finished_at timestamptz
);
