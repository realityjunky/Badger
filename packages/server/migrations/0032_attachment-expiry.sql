-- Historical answers, including drafts and inherited revisions, keep their
-- receipts forever. Only an upload that has never been referenced can expire.
create function answer_attachment_is_referenced(attachment_id text) returns boolean as $$
  select exists (
    select 1 from answer_revisions r
    where r.attachments @> jsonb_build_array(jsonb_build_object('id', attachment_id))
  ) or exists (
    select 1 from inherited_answer_attachments i where i.attachment_id = $1
  );
$$ language sql stable;

create function guard_answer_attachment_change() returns trigger as $$
begin
  if TG_OP <> 'DELETE' or answer_attachment_is_referenced(OLD.id) then
    raise exception 'Referenced answer attachments and all attachment metadata are immutable';
  end if;
  return OLD;
end;
$$ language plpgsql;

drop trigger answer_attachments_immutable on answer_attachments;
create trigger answer_attachments_immutable before update or delete on answer_attachments
  for each row execute function guard_answer_attachment_change();
-- The existing no-truncate trigger stays in force.
create index answer_attachments_expiry_idx on answer_attachments (created_at);

-- A committed deletion must survive a worker stopping before content removal.
create table attachment_blob_cleanup (
  hash text primary key check (hash ~ '^[a-f0-9]{64}$')
);
