-- Sign-off evidence and published bytes are immutable. Current approval is
-- tracked separately by the existing invalidatable gate confirmation.
create table package_reviews (
  id text primary key references gate_confirmations (id),
  workflow_version_id text not null references workflow_versions (id),
  package_id text not null references workflow_packages (id),
  package_hash text not null check (package_hash ~ '^[a-f0-9]{64}$'),
  evaluation_report_id text not null references evaluation_reports (id),
  reviewer_id text not null references people (id),
  reviewer_name text not null,
  approved_at timestamptz not null,
  override_reason text check (override_reason is null or length(trim(override_reason)) between 1 and 2000),
  kernel_review jsonb not null
);
create table published_packages (
  id text primary key references gate_confirmations (id),
  workflow_version_id text not null references workflow_versions (id),
  review_id text not null references package_reviews (id),
  package_id text not null references workflow_packages (id),
  package_hash text not null check (package_hash ~ '^[a-f0-9]{64}$'),
  publisher_id text not null references people (id),
  publisher_name text not null,
  published_at timestamptz not null,
  snapshot jsonb not null check (jsonb_typeof(snapshot) = 'object'),
  unique (review_id)
);
create function refuse_publication_evidence_change() returns trigger as $$
begin
  raise exception 'Package reviews and published packages are immutable';
end;
$$ language plpgsql;
create trigger package_reviews_immutable before update or delete or truncate on package_reviews
  for each statement execute function refuse_publication_evidence_change();
create trigger published_packages_immutable before update or delete or truncate on published_packages
  for each statement execute function refuse_publication_evidence_change();
create index package_reviews_version_idx on package_reviews (workflow_version_id, approved_at desc, id desc);
create index published_packages_version_idx on published_packages (workflow_version_id, published_at desc, id desc);
