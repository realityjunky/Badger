import type { Queryable } from "../database/database.js";
import type { ServiceDependencies } from "../dependencies.js";
import type { WriteContext } from "../audit.js";
import { toIsoString } from "../util.js";
import { readRecordOrigins } from "../version-inheritance.js";
import { recordQuestionnaireAudit } from "./store.js";

interface TranslationRow {
  id: string;
  question_id: string;
  question_revision: number;
  locale: string;
  text: string;
  rationale: string;
  actor_id: string;
  created_at: Date | string;
}
export async function readTranslations(tx: Queryable, versionId: string) {
  const rows = await tx.query<TranslationRow>(
    `select t.* from question_translations t join questions q on q.id = t.question_id
     where q.workflow_version_id = $1 order by t.created_at, t.id`,
    [versionId],
  );
  const origins = await readRecordOrigins(tx, versionId, "translation");
  return rows.rows.map((row) => ({
    id: row.id,
    questionId: row.question_id,
    questionRevision: row.question_revision,
    locale: row.locale,
    text: row.text,
    rationale: row.rationale,
    actorId: row.actor_id,
    createdAt: toIsoString(row.created_at),
    origin: origins.get(row.id) ?? null,
  }));
}
export type QuestionTranslation = Awaited<
  ReturnType<typeof readTranslations>
>[number];
export async function saveTranslation(
  tx: Queryable,
  deps: ServiceDependencies,
  actor: WriteContext,
  input: {
    questionId: string;
    questionRevision: number;
    locale: string;
    text: string;
    rationale: string;
    jobId: string;
  },
) {
  const id = deps.ids.next();
  await tx.query(
    `insert into question_translations (id, question_id, question_revision, locale, text, rationale, actor_id, job_id, created_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      id,
      input.questionId,
      input.questionRevision,
      input.locale,
      input.text,
      input.rationale,
      actor.personId,
      input.jobId,
      deps.clock.now(),
    ],
  );
  await recordQuestionnaireAudit(
    tx,
    deps,
    actor,
    "question.translation-accepted",
    "question-translation",
    id,
    input.questionRevision,
    null,
  );
  return id;
}
