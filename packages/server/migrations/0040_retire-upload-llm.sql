alter table llm_configuration rename to retired_llm_configuration;
alter table llm_secrets rename to retired_llm_secrets;
alter table skill_suggestion_previews rename to retired_skill_suggestion_previews;
drop table llm_call_leases;

create function protect_retired_llm_archive() returns trigger as $$
begin
  raise exception 'Retired upload-time model configuration is an offline archive';
end;
$$ language plpgsql;
create trigger retired_llm_configuration_read_only
  before insert or update or delete or truncate on retired_llm_configuration
  for each statement execute function protect_retired_llm_archive();
create trigger retired_llm_secrets_read_only
  before insert or update or delete or truncate on retired_llm_secrets
  for each statement execute function protect_retired_llm_archive();
create trigger retired_skill_suggestion_previews_read_only
  before insert or update or delete or truncate on retired_skill_suggestion_previews
  for each statement execute function protect_retired_llm_archive();
