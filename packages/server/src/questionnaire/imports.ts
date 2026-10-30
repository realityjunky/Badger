import type { Queryable } from "../database/database.js";
import type { ServiceDependencies } from "../dependencies.js";
import type { WriteContext } from "../audit.js";
import { RequestError } from "../http/errors.js";
import {
  evidenceLines,
  type SourceEvidence,
  type StudySkill,
} from "../source-study.js";
import type { BlobStore } from "../skills/blobs.js";
import type { ImportedQuestion } from "../drafting/schema.js";
import {
  readRecordOrigins,
  type RecordOrigin,
} from "../version-inheritance.js";
import { recordQuestionnaireAudit, saveQuestion } from "./store.js";
import { canonicalHash } from "@realityjunky/badger";

export interface ImportedSource extends SourceEvidence {
  questionRevision: number;
  number: number;
  origin: RecordOrigin | null;
}

export async function readImportedSources(tx: Queryable, versionId: string) {
  const result = await tx.query<{
    question_id: string;
    question_revision: number;
    source_number: number;
    evidence: SourceEvidence;
  }>("select * from question_imports where workflow_version_id = $1", [
    versionId,
  ]);
  const origins = await readRecordOrigins(tx, versionId, "import");
  return new Map(
    result.rows.map((row) => [
      row.question_id,
      {
        ...row.evidence,
        questionRevision: row.question_revision,
        number: row.source_number,
        origin: origins.get(row.question_id) ?? null,
      },
    ]),
  );
}

/** Each numbered source question enters a workflow version at most once. */
export async function refuseImportedAgain(
  tx: Queryable,
  versionId: string,
  items: ImportedQuestion[],
) {
  const imported = [...(await readImportedSources(tx, versionId))];
  for (const { number, source } of items) {
    const existing = imported.find(
      ([, s]) =>
        s.skillId === source.skillId &&
        s.hash === source.hash &&
        s.path === source.path &&
        s.number === number,
    );
    if (existing)
      throw new RequestError(
        409,
        `Question ${number} of ${source.path} is already imported into this workflow version`,
        { questionId: existing[0] },
      );
  }
}

export async function saveImportedQuestion(
  tx: Queryable,
  deps: ServiceDependencies,
  actor: WriteContext,
  blobs: BlobStore,
  versionId: string,
  roundId: string,
  jobId: string,
  pin: StudySkill,
  item: ImportedQuestion,
) {
  if (item.source.skillId !== pin.skillId || item.source.hash !== pin.hash)
    throw new RequestError(
      400,
      "Import questions from the job's pinned Skill version",
    );
  await evidenceLines(tx, blobs, item.source);
  const { source } = item;
  const citation = {
    skillId: source.skillId,
    versionHash: source.hash,
    path: source.path,
    startLine: source.startLine,
    endLine: source.endLine,
  };
  const question = await saveQuestion(tx, deps, actor, versionId, roundId, {
    ...item.question,
    evidence: [
      citation,
      ...item.question.evidence.filter(
        (e) => canonicalHash(e) !== canonicalHash(citation),
      ),
    ],
  });
  await tx.query(
    `insert into question_imports (question_id, workflow_version_id, question_revision, skill_id, skill_version_hash, source_number, evidence, job_id)
     values ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      question.id,
      versionId,
      question.revision,
      source.skillId,
      source.hash,
      item.number,
      JSON.stringify(source),
      jobId,
    ],
  );
  await recordQuestionnaireAudit(
    tx,
    deps,
    actor,
    "question.imported",
    "question",
    question.id,
    question.revision,
    null,
  );
  return question;
}
