-- Failed removals rotate behind content that has not been tried recently.
alter table attachment_blob_cleanup add column last_attempt_at timestamptz;
create index attachment_blob_cleanup_attempt_idx
  on attachment_blob_cleanup (last_attempt_at nulls first, hash);
