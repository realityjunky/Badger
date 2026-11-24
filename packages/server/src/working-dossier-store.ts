import type { DossierPin, WorkingDossierRevision } from "@realityjunky/badger";
import type { Queryable } from "./database/database.js";

interface WorkingRow {
  revision: number;
  pins_hash: string;
  pins: DossierPin[];
  content: WorkingDossierRevision["content"];
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
