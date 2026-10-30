-- Historical receipts did not check reachability. NULL records that absence
-- honestly; they must never acquire a fabricated branch or tag on upgrade.
alter table skill_version_git_origins add column published_ref text
  check (published_ref is null or published_ref ~ '^refs/(heads|tags)/.+');
