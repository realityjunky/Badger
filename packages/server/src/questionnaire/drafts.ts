import {
  canonicalHash,
  SEMANTIC_DOSSIER_TOPICS,
  type QuestionnaireTopic,
} from "@realityjunky/badger";
import type { WriteContext } from "../audit.js";
import type { Queryable } from "../database/database.js";
import type { ServiceDependencies } from "../dependencies.js";
import { RequestError } from "../http/errors.js";
import { toIsoString } from "../util.js";
import { fields, revisionInput, textInput } from "./model.js";
import {
  advanceQuestionnaireRevision,
  recordQuestionnaireAudit,
} from "./store.js";

export type DraftKind = "inference" | "assumption";
interface DraftRow {
  id: string;
  kind: DraftKind;
  revision: number;
  statement: string;
  topic: QuestionnaireTopic;
  question_id: string | null;
  question_revision: number | null;
  status: "active" | "retired";
  actor_id: string;
  created_at: Date | string;
}
function toDraft(row: DraftRow) {
  return {
    id: row.id,
    kind: row.kind,
    revision: row.revision,
    statement: row.statement,
    topic: row.topic,
    questionId: row.question_id,
    questionRevision: row.question_revision,
    status: row.status,
    actorId: row.actor_id,
    createdAt: toIsoString(row.created_at),
  };
}
export async function readDrafts(tx: Queryable, versionId: string) {
  const result = await tx.query<DraftRow>(
    `select d.id, d.kind, r.* from questionnaire_drafts d join questionnaire_draft_revisions r
    on r.draft_id = d.id and r.revision = d.revision where d.workflow_version_id = $1 order by d.id`,
    [versionId],
  );
  return result.rows.map(toDraft);
}
export async function readDraft(
  tx: Queryable,
  versionId: string,
  id: string,
  kind: DraftKind,
) {
  const record = (await readDrafts(tx, versionId)).find(
    (r) => r.id === id && r.kind === kind,
  );
  if (!record) throw new RequestError(404, "No such questionnaire draft");
  const result = await tx.query<DraftRow>(
    `select d.id, d.kind, r.* from questionnaire_drafts d join questionnaire_draft_revisions r
    on r.draft_id = d.id where d.id = $1 order by r.revision`,
    [id],
  );
  return { record, revisions: result.rows.map(toDraft) };
}
export async function saveDraft(
  tx: Queryable,
  deps: ServiceDependencies,
  context: WriteContext,
  versionId: string,
  kind: DraftKind,
  id: string | null,
  body: Record<string, unknown>,
  retire: boolean,
) {
  fields(
    body,
    retire ? ["revision"] : ["revision", "statement", "topic", "questionId"],
  );
  const previous =
    id === null ? null : (await readDraft(tx, versionId, id, kind)).record;
  if (
    previous
      ? revisionInput(body.revision) !== previous.revision
      : body.revision !== undefined
  )
    throw new RequestError(
      409,
      "The draft changed; quote its current revision",
    );
  if (previous?.status === "retired")
    throw new RequestError(409, "This draft is retired");
  const topic = retire ? previous!.topic : textInput(body.topic, "topic", 100);
  if (!(["scope", ...SEMANTIC_DOSSIER_TOPICS] as string[]).includes(topic))
    throw new RequestError(400, "Use a dossier topic or scope");
  const statement = retire
    ? previous!.statement
    : textInput(body.statement, "statement", 20000);
  const questionId = retire
    ? previous!.questionId
    : body.questionId === null || body.questionId === undefined
      ? null
      : textInput(body.questionId, "questionId", 200);
  let questionRevision = retire ? previous!.questionRevision : null;
  if (!retire && questionId !== null) {
    const question = (
      await tx.query<{ revision: number; topic: string }>(
        `select q.revision, r.content->>'topic' as topic from questions q join question_revisions r on r.question_id = q.id and r.revision = q.revision
      where q.id = $1 and q.workflow_version_id = $2`,
        [questionId, versionId],
      )
    ).rows[0];
    if (!question)
      throw new RequestError(400, "Link a question in this workflow version");
    if (question.topic !== topic)
      throw new RequestError(
        400,
        "The confirming question must address the same topic",
      );
    questionRevision = question.revision;
    // Editing meaning after confirmation must not borrow an earlier sign-off.
    if (
      !previous ||
      canonicalHash({ statement, topic, questionId }) !==
        canonicalHash({
          statement: previous.statement,
          topic: previous.topic,
          questionId: previous.questionId,
        })
    ) {
      const resolved = (
        await tx.query<{ resolved_at: unknown }>(
          "select resolved_at from questions where id = $1",
          [questionId],
        )
      ).rows[0];
      if (resolved?.resolved_at !== null)
        throw new RequestError(
          409,
          "Link a new confirming question when changing a resolved draft's meaning",
        );
    }
  }
  const recordId = previous?.id ?? deps.ids.next();
  const revision = (previous?.revision ?? 0) + 1;
  if (previous)
    await tx.query(
      "update questionnaire_drafts set revision = $2 where id = $1",
      [recordId, revision],
    );
  else
    await tx.query(
      "insert into questionnaire_drafts (id, workflow_version_id, kind, revision) values ($1,$2,$3,$4)",
      [recordId, versionId, kind, revision],
    );
  await tx.query(
    `insert into questionnaire_draft_revisions (draft_id, revision, statement, topic, question_id, question_revision, status, actor_id, created_at)
    values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      recordId,
      revision,
      statement,
      topic,
      questionId,
      questionRevision,
      retire ? "retired" : "active",
      context.personId,
      deps.clock.now(),
    ],
  );
  await advanceQuestionnaireRevision(tx, versionId);
  await recordQuestionnaireAudit(
    tx,
    deps,
    context,
    `${kind}.${retire ? "retired" : previous ? "revised" : "drafted"}`,
    kind,
    recordId,
    revision,
    previous?.revision ?? null,
  );
  return (await readDraft(tx, versionId, recordId, kind)).record;
}
