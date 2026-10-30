-- 0017 added this column for drafting jobs. Agent provenance is now an
-- audit-wide contract, so keep the column it made and allow a host only on
-- token credentials.
alter table audit_events add column if not exists agent_host text;
alter table audit_events add constraint audit_events_agent_host_credential_check
  check (agent_host is null or credential_kind = 'token');
