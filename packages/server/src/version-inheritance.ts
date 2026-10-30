import { canonicalHash } from "@realityjunky/badger";
import type { Queryable } from "./database/database.js";
import type { ServiceDependencies } from "./dependencies.js";

type RecordType =
  | "round"
  | "question"
  | "resolution"
  | "fact"
  | "acknowledgement"
  | "source-study"
  | "draft"
  | "translation"
  | "import";
export interface RecordOrigin {
  workflowVersionId: string;
  recordId: string;
  revision: number;
}
const COPIED: [RecordType, string][] = [
  ["round", "rounds"],
  ["question", "questions"],
  ["resolution", "resolutions"],
  ["fact", "facts"],
  ["acknowledgement", "acknowledgements"],
  ["source-study", "source-study records"],
  ["draft", "drafts"],
  ["translation", "translations"],
  ["import", "imports"],
];
/** What a new version copied: nonzero counts, and a hash of the copied sources. */
export interface InheritedRecords {
  counts: [string, number][];
  hash: string;
}
export function describeInheritance(
  sourceId: string,
  inherited: InheritedRecords,
  moved: number,
) {
  const records =
    inherited.counts.map(([label, count]) => `${label}: ${count}`).join(", ") ||
    "no records";
  return `Inherited from workflow version ${sourceId} (${records}); moved ${moved} pending inbox items`;
}
export async function readRecordOrigins(
  tx: Queryable,
  versionId: string,
  type: RecordType,
) {
  const result = await tx.query<{
    record_id: string;
    source_workflow_version_id: string;
    source_record_id: string;
    source_revision: number;
  }>(
    "select * from workflow_record_origins where workflow_version_id = $1 and record_type = $2",
    [versionId, type],
  );
  return new Map(
    result.rows.map((r) => [
      r.record_id,
      {
        workflowVersionId: r.source_workflow_version_id,
        recordId: r.source_record_id,
        revision: r.source_revision,
      },
    ]),
  );
}

/** Called while both the parent workflow and its latest version are locked. */
export async function inheritVersionRecords(
  tx: Queryable,
  deps: ServiceDependencies,
  sourceId: string,
  versionId: string,
): Promise<InheritedRecords> {
  const records = await tx.query<{
    type: RecordType;
    id: string;
    revision: number;
  }>(
    `select 'round' as type, id, revision from question_rounds where workflow_version_id = $1
     union all select 'question', id, revision from questions where workflow_version_id = $1
     union all select 'resolution', r.id, r.revision from question_resolutions r join questions q on q.id = r.question_id where q.workflow_version_id = $1
     union all select 'fact', f.id, 1 from confirmed_facts f join question_resolutions r on r.id = f.resolution_id join questions q on q.id = r.question_id where q.workflow_version_id = $1
     union all select 'acknowledgement', a.id, 1 from fact_acknowledgements a join confirmed_facts f on f.id = a.fact_id join question_resolutions r on r.id = f.resolution_id join questions q on q.id = r.question_id where q.workflow_version_id = $1
     union all select 'source-study', id, revision from source_study_records where workflow_version_id = $1
     union all select 'draft', id, revision from questionnaire_drafts where workflow_version_id = $1
     union all select 'translation', t.id, 1 from question_translations t join questions q on q.id = t.question_id where q.workflow_version_id = $1
     order by type, id`,
    [sourceId],
  );
  for (const r of records.rows)
    await tx.query(
      `insert into workflow_record_origins
     (workflow_version_id, record_type, record_id, source_workflow_version_id, source_record_id, source_revision)
     values ($1, $2, $3, $4, $5, $6)`,
      [versionId, r.type, deps.ids.next(), sourceId, r.id, r.revision],
    );
  // All relationships use the same immutable identity map. The old records,
  // actors, hashes and timestamps remain untouched.
  const origins = `with origins as (select * from workflow_record_origins where workflow_version_id = $2)`;
  const values = [sourceId, versionId];
  // An import has no identity of its own; its origin maps the copied question.
  await tx.query(
    `${origins} insert into workflow_record_origins
     (workflow_version_id, record_type, record_id, source_workflow_version_id, source_record_id, source_revision)
     select $2, 'import', o.record_id, $1, i.question_id, 1
     from question_imports i join origins o on o.source_record_id = i.question_id and o.record_type = 'question'
     where o.source_workflow_version_id = $1`,
    values,
  );
  await tx.query(
    `insert into workflow_skill_pins
    (workflow_version_id, skill_id, skill_version_hash, purpose, revision, pinned_by, created_at, updated_at)
    select $2, skill_id, skill_version_hash, purpose, revision, pinned_by, created_at, updated_at
    from workflow_skill_pins where workflow_version_id = $1`,
    values,
  );
  await tx.query(
    `insert into questionnaires (workflow_version_id, revision)
    select $2, revision from questionnaires where workflow_version_id = $1`,
    values,
  );
  await tx.query(
    `${origins} insert into question_rounds
    (id, workflow_version_id, number, title, state, revision, created_by, created_at, published_at, publication_hash)
    select o.record_id, $2, r.number, r.title, r.state, r.revision, r.created_by, r.created_at, r.published_at, r.publication_hash
    from question_rounds r join origins o on o.source_record_id = r.id and o.record_type = 'round'
    where r.workflow_version_id = $1`,
    values,
  );
  await tx.query(
    `${origins} insert into questions
    (id, workflow_version_id, round_id, revision, state, position, resolved_at, created_at, resolution_revision)
    select o.record_id, $2, b.record_id, q.revision, q.state, q.position, q.resolved_at, q.created_at, q.resolution_revision
    from questions q join origins o on o.source_record_id = q.id and o.record_type = 'question'
    join origins b on b.source_record_id = q.round_id and b.record_type = 'round'
    where q.workflow_version_id = $1`,
    values,
  );
  await tx.query(
    `${origins} update questions n set parent_question_id = p.record_id
    from questions q join origins o on o.source_record_id = q.id and o.record_type = 'question'
    join origins p on p.source_record_id = q.parent_question_id and p.record_type = 'question'
    where n.id = o.record_id and q.workflow_version_id = $1`,
    values,
  );
  await tx.query(
    `${origins} insert into question_revisions (question_id, revision, content, actor_id, created_at)
    select o.record_id, r.revision, r.content, r.actor_id, r.created_at
    from question_revisions r join origins o on o.source_record_id = r.question_id and o.record_type = 'question'
    where o.source_workflow_version_id = $1`,
    values,
  );
  // Accepted translations and import provenance belong to question revisions,
  // so they follow the copied revisions. Each still names its original job.
  await tx.query(
    `${origins} insert into question_translations
    (id, question_id, question_revision, locale, text, rationale, actor_id, job_id, created_at)
    select o.record_id, q.record_id, t.question_revision, t.locale, t.text, t.rationale, t.actor_id, t.job_id, t.created_at
    from question_translations t join origins o on o.source_record_id = t.id and o.record_type = 'translation'
    join origins q on q.source_record_id = t.question_id and q.record_type = 'question'
    where o.source_workflow_version_id = $1`,
    values,
  );
  await tx.query(
    `${origins} insert into question_imports
    (question_id, workflow_version_id, question_revision, skill_id, skill_version_hash, source_number, evidence, job_id)
    select o.record_id, $2, i.question_revision, i.skill_id, i.skill_version_hash, i.source_number, i.evidence, i.job_id
    from question_imports i join origins o on o.source_record_id = i.question_id and o.record_type = 'import'
    where o.source_workflow_version_id = $1`,
    values,
  );
  await tx.query(
    `${origins} insert into question_recipients (question_id, binding_id)
    select o.record_id, r.binding_id from question_recipients r
    join origins o on o.source_record_id = r.question_id and o.record_type = 'question'
    where o.source_workflow_version_id = $1`,
    values,
  );
  await tx.query(
    `${origins} insert into question_answers (question_id, person_id, revision)
    select o.record_id, a.person_id, a.revision from question_answers a
    join origins o on o.source_record_id = a.question_id and o.record_type = 'question'
    where o.source_workflow_version_id = $1`,
    values,
  );
  await tx.query(
    `${origins} insert into answer_revisions
    (question_id, person_id, revision, question_revision, text, state, channel, agent_host, created_at, value, attachments)
    select o.record_id, a.person_id, a.revision, a.question_revision, a.text, a.state, a.channel, a.agent_host, a.created_at, a.value, a.attachments
    from answer_revisions a join origins o on o.source_record_id = a.question_id and o.record_type = 'question'
    where o.source_workflow_version_id = $1`,
    values,
  );
  await tx.query(
    `${origins} insert into inherited_answer_attachments (question_id, attachment_id)
    select distinct o.record_id, file->>'id' from answer_revisions a
    join origins o on o.source_record_id = a.question_id and o.record_type = 'question',
    jsonb_array_elements(a.attachments) file where o.source_workflow_version_id = $1`,
    values,
  );
  await tx.query(
    `${origins} insert into question_resolutions
    (id, question_id, revision, question_revision, kind, actor_id, reason, deferred_kind, skill_id, child_question_id, confirmation_hash, input_hash, request_id, created_at)
    select o.record_id, q.record_id, r.revision, r.question_revision, r.kind, r.actor_id, r.reason, r.deferred_kind, r.skill_id, child.record_id,
      r.confirmation_hash, r.input_hash, 'inherited:' || o.record_id, r.created_at
    from question_resolutions r join origins o on o.source_record_id = r.id and o.record_type = 'resolution'
    join origins q on q.source_record_id = r.question_id and q.record_type = 'question'
    left join origins child on child.source_record_id = r.child_question_id and child.record_type = 'question'
    where o.source_workflow_version_id = $1`,
    values,
  );
  await tx.query(
    `${origins} insert into confirmed_facts (id, resolution_id, content, hash)
    select o.record_id, r.record_id, f.content, f.hash from confirmed_facts f
    join origins o on o.source_record_id = f.id and o.record_type = 'fact'
    join origins r on r.source_record_id = f.resolution_id and r.record_type = 'resolution'
    where o.source_workflow_version_id = $1`,
    values,
  );
  await tx.query(
    `${origins} insert into fact_answer_revisions (fact_id, question_id, person_id, revision)
    select f.record_id, q.record_id, a.person_id, a.revision from fact_answer_revisions a
    join origins f on f.source_record_id = a.fact_id and f.record_type = 'fact'
    join origins q on q.source_record_id = a.question_id and q.record_type = 'question'
    where f.source_workflow_version_id = $1`,
    values,
  );
  await tx.query(
    `${origins} insert into fact_acknowledgements
    (id, fact_id, person_id, decision, reason, confirmation_hash, request_id, created_at)
    select o.record_id, f.record_id, a.person_id, a.decision, a.reason, a.confirmation_hash, 'inherited:' || o.record_id, a.created_at
    from fact_acknowledgements a join origins o on o.source_record_id = a.id and o.record_type = 'acknowledgement'
    join origins f on f.source_record_id = a.fact_id and f.record_type = 'fact'
    where o.source_workflow_version_id = $1`,
    values,
  );
  await tx.query(
    `${origins} insert into source_study_records
    (id, workflow_version_id, kind, revision, status, content, created_at, updated_at)
    select o.record_id, $2, r.kind, r.revision, r.status, r.content, r.created_at, r.updated_at
    from source_study_records r join origins o on o.source_record_id = r.id and o.record_type = 'source-study'
    where r.workflow_version_id = $1`,
    values,
  );
  await tx.query(
    `${origins} insert into source_study_revisions (record_id, revision, status, content, actor_id, recorded_at)
    select o.record_id, r.revision, r.status, r.content, r.actor_id, r.recorded_at
    from source_study_revisions r join origins o on o.source_record_id = r.record_id and o.record_type = 'source-study'
    where o.source_workflow_version_id = $1`,
    values,
  );
  await tx.query(
    `${origins} insert into questionnaire_drafts (id, workflow_version_id, kind, revision)
    select o.record_id, $2, d.kind, d.revision from questionnaire_drafts d
    join origins o on o.source_record_id = d.id and o.record_type = 'draft'
    where d.workflow_version_id = $1`,
    values,
  );
  await tx.query(
    `${origins} insert into questionnaire_draft_revisions
    (draft_id, revision, statement, topic, question_id, question_revision, status, actor_id, created_at)
    select o.record_id, r.revision, r.statement, r.topic, q.record_id, r.question_revision, r.status, r.actor_id, r.created_at
    from questionnaire_draft_revisions r join origins o on o.source_record_id = r.draft_id and o.record_type = 'draft'
    left join origins q on q.source_record_id = r.question_id and q.record_type = 'question'
    where o.source_workflow_version_id = $1`,
    values,
  );
  const pins = (
    await tx.query<{ skill_id: string; skill_version_hash: string }>(
      "select skill_id, skill_version_hash from workflow_skill_pins where workflow_version_id = $1",
      [versionId],
    )
  ).rows
    .map((pin) => ({ skillId: pin.skill_id, hash: pin.skill_version_hash }))
    .sort((a, b) => (a.skillId < b.skillId ? -1 : 1));
  const copied = (
    await tx.query<{
      record_type: RecordType;
      source_record_id: string;
      source_revision: number;
    }>(
      "select record_type, source_record_id, source_revision from workflow_record_origins where workflow_version_id = $1",
      [versionId],
    )
  ).rows
    .map((r) => ({
      type: r.record_type,
      id: r.source_record_id,
      revision: r.source_revision,
    }))
    .sort((a, b) =>
      a.type === b.type ? (a.id < b.id ? -1 : 1) : a.type < b.type ? -1 : 1,
    );
  const counts: [string, number][] = [
    ["pins", pins.length],
    ...COPIED.map(([type, label]): [string, number] => [
      label,
      copied.filter((record) => record.type === type).length,
    ]),
  ];
  return {
    counts: counts.filter(([, count]) => count > 0),
    hash: canonicalHash({ sourceVersionId: sourceId, pins, records: copied }),
  };
}
