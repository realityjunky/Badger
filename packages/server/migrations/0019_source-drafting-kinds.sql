alter table drafting_jobs drop constraint drafting_jobs_kind_check;
alter table drafting_jobs add constraint drafting_jobs_kind_check
  check (kind in ('draft-questions', 'draft-follow-ups', 'source-study', 'restate-answer', 'translate-question', 'import-open-questions'));
alter table drafting_jobs alter column round_id drop not null;
alter table drafting_jobs add column skill_id text references skills (id);
alter table drafting_jobs add column question_id text references questions (id);
alter table drafting_jobs add column locale text;
alter table drafting_jobs add constraint drafting_jobs_locale_check
  check ((kind = 'translate-question') = (locale is not null));
alter table drafting_jobs add constraint drafting_jobs_question_check
  check ((kind in ('restate-answer', 'translate-question')) = (question_id is not null));
alter table drafting_jobs add constraint drafting_jobs_round_check
  check ((kind in ('draft-questions', 'draft-follow-ups', 'import-open-questions')) = (round_id is not null));
alter table drafting_jobs add constraint drafting_jobs_skill_check
  check ((kind in ('source-study', 'import-open-questions')) = (skill_id is not null));

create table question_translations (
  id text primary key,
  question_id text not null,
  question_revision integer not null,
  locale text not null,
  text text not null,
  rationale text not null,
  actor_id text not null references people (id),
  job_id text not null unique references drafting_jobs (id),
  created_at timestamptz not null,
  foreign key (question_id, question_revision) references question_revisions (question_id, revision)
);
create trigger question_translations_immutable before update or delete on question_translations
  for each row execute function refuse_questionnaire_revision_change();
create trigger question_translations_no_truncate before truncate on question_translations
  for each statement execute function refuse_questionnaire_revision_change();

create table question_imports (
  question_id text primary key,
  question_revision integer not null,
  skill_id text not null,
  skill_version_hash text not null,
  source_number integer not null check (source_number > 0),
  evidence jsonb not null,
  job_id text not null references drafting_jobs (id),
  foreign key (question_id, question_revision) references question_revisions (question_id, revision),
  foreign key (skill_id, skill_version_hash) references skill_versions (skill_id, hash)
);
create trigger question_imports_immutable before update or delete on question_imports
  for each row execute function refuse_questionnaire_revision_change();
create trigger question_imports_no_truncate before truncate on question_imports
  for each statement execute function refuse_questionnaire_revision_change();
