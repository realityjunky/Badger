import type {
  DossierFieldValue,
  DossierPin,
  WorkingDossierRevision,
} from "@realityjunky/badger";
import type { Queryable } from "./database/database.js";

interface WorkingRow {
  revision: number;
  pins_hash: string;
  pins: DossierPin[];
  content: WorkingDossierRevision["content"];
}

export async function lockDossierSkillAnswers(
  tx: Queryable,
  versionId: string,
  fields: Record<string, DossierFieldValue | null>,
) {
  const questionIds = [
    ...new Set(
      Object.values(fields).flatMap(
        (field) => field?.answers?.map(({ questionId }) => questionId) ?? [],
      ),
    ),
  ];
  if (!questionIds.length) return;
  await tx.query(
    `select sq.id from skill_questionnaires sq where exists (
       select 1 from questions q
       join workflow_skill_pins p on p.skill_id = sq.skill_id and p.workflow_version_id = $1
       where q.skill_questionnaire_id = sq.id and q.id = any($2::text[])
     ) order by sq.id for share`,
    [versionId, questionIds],
  );
}

export async function lockDossiersCitingSkillQuestion(
  tx: Queryable,
  questionId: string,
) {
  const versions = await tx.query<{ id: string }>(
    `select v.id from workflow_versions v
     join lateral (
       select content from working_dossier_revisions
       where workflow_version_id = v.id order by revision desc limit 1
     ) dossier on true
     where exists (
       select 1 from jsonb_each(dossier.content->'fields') field
       where field.value->'answers' @> jsonb_build_array(jsonb_build_object('questionId', $1::text))
     )
     order by v.id for no key update of v`,
    [questionId],
  );
  return versions.rows.map(({ id }) => id);
}

export async function readWorkingRevision(
  tx: Queryable,
  versionId: string,
  revision?: number,
): Promise<WorkingDossierRevision | null> {
  const row = (
    await tx.query<WorkingRow>(
      `select revision, pins_hash, pins, content from working_dossier_revisions
     where workflow_version_id = $1 and ($2::integer is null or revision = $2)
     order by revision desc limit 1`,
      [versionId, revision ?? null],
    )
  ).rows[0];
  return row
    ? {
        revision: row.revision,
        pinsHash: row.pins_hash,
        pins: row.pins,
        content: row.content,
      }
    : null;
}

/** Keep earlier workflows on their existing authoring path. */
export async function hasLegacyAuthoring(tx: Queryable, versionId: string) {
  return (
    await tx.query<{ present: boolean }>(
      `select exists (
        select 1 from source_study_records r where r.workflow_version_id = $1
          and (r.revision > 1 or not exists (
            select 1 from workflow_record_origins o
            where o.workflow_version_id = $1 and o.record_type = 'source-study' and o.record_id = r.id
          ))
      )
      or exists (select 1 from dossier_versions where workflow_version_id = $1)
      or exists (select 1 from gate_confirmations where workflow_version_id = $1 and gate like 'source-study/%')
      as present`,
      [versionId],
    )
  ).rows[0]!.present;
}
