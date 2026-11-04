alter table workflow_versions
  add column semantic_version text,
  add column label_revision integer not null default 0 check (label_revision >= 0),
  add constraint workflow_versions_semantic_version_format check (
    semantic_version is null or (
      length(semantic_version) <= 64 and
      semantic_version ~ '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'
    )
  ),
  add constraint workflow_versions_semantic_version_unique unique (workflow_id, semantic_version);
