-- Drafting jobs introduced this column in 0017. Keep that shipped migration
-- intact while making Agent provenance an audit-wide contract.
alter table audit_events add column if not exists agent_host text;
alter table audit_events add constraint audit_events_agent_host_credential_check
  check (agent_host is null or credential_kind = 'token');
