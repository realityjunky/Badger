import type { WriteContext } from "../audit.js";
import type { Queryable } from "../database/database.js";
import type { ServiceDependencies } from "../dependencies.js";
import { RequestError } from "../http/errors.js";
import { toIsoString } from "../util.js";
import type { CommentRevision, QuestionComment } from "./model.js";
import {
  advanceQuestionnaireRevision,
  recordQuestionnaireAudit,
} from "./store.js";

export async function readComments(
  tx: Queryable,
  versionId: string,
  compose: boolean,
): Promise<QuestionComment[]> {
  const rows = await tx.query<{
    id: string;
    question_id: string;
    person_id: string;
    display_name: string;
    current_revision: number;
    revision: number;
    text: string;
    actor_id: string;
    created_at: Date | string;
  }>(
    `select c.id, c.question_id, c.person_id, p.display_name, c.revision as current_revision, r.*
    from question_comments c join questions q on q.id = c.question_id
    join people p on p.id = c.person_id join comment_revisions r on r.comment_id = c.id
    where q.workflow_version_id = $1 and ($2::boolean or q.state <> 'draft')
    order by q.id, c.position, r.revision`,
    [versionId, compose],
  );
  const comments = new Map<string, QuestionComment>();
  for (const row of rows.rows) {
    const revision: CommentRevision = {
      revision: row.revision,
      text: row.text,
      actorId: row.actor_id,
      createdAt: toIsoString(row.created_at),
    };
    let comment = comments.get(row.id);
    if (!comment) {
      comment = {
        ...revision,
        id: row.id,
        questionId: row.question_id,
        personId: row.person_id,
        personName: row.display_name,
        revisions: [],
      };
      comments.set(row.id, comment);
    }
    comment.revisions.push(revision);
    if (row.revision === row.current_revision) Object.assign(comment, revision);
  }
  return [...comments.values()];
}

/** The caller holds the workflow/version lock and checks the comment capability. */
export async function saveComment(
  tx: Queryable,
  deps: ServiceDependencies,
  context: WriteContext,
  versionId: string,
  compose: boolean,
  text: string,
  target: { questionId: string } | { commentId: string; revision: number },
) {
  const previous =
    "commentId" in target
      ? (await readComments(tx, versionId, compose)).find(
          (c) => c.id === target.commentId,
        )
      : undefined;
  if ("commentId" in target) {
    if (!previous) throw new RequestError(404, "No such comment");
    if (previous.personId !== context.personId)
      throw new RequestError(403, "Only the author edits a comment");
    if (previous.revision !== target.revision)
      throw new RequestError(409, "The comment changed since you read it", {
        currentRevision: previous.revision,
      });
  } else {
    const question = await tx.query(
      "select id from questions where id = $1 and workflow_version_id = $2 and ($3::boolean or state <> 'draft')",
      [target.questionId, versionId, compose],
    );
    if (!question.rows[0]) throw new RequestError(404, "No such question");
  }
  const id = previous?.id ?? deps.ids.next();
  const revision = (previous?.revision ?? 0) + 1;
  if ("commentId" in target) {
    await tx.query("update question_comments set revision = $2 where id = $1", [
      id,
      revision,
    ]);
  } else {
    await tx.query(
      `insert into question_comments (id, question_id, person_id, position, created_at)
      select $1, $2, $3, coalesce(max(position), 0) + 1, $4 from question_comments where question_id = $2`,
      [id, target.questionId, context.personId, deps.clock.now()],
    );
  }
  await tx.query(
    "insert into comment_revisions (comment_id, revision, text, actor_id, created_at) values ($1, $2, $3, $4, $5)",
    [id, revision, text, context.personId, deps.clock.now()],
  );
  await advanceQuestionnaireRevision(tx, versionId);
  await recordQuestionnaireAudit(
    tx,
    deps,
    context,
    previous ? "comment.revised" : "comment.created",
    "comment",
    id,
    revision,
    previous?.revision ?? null,
  );
  return (await readComments(tx, versionId, compose)).find((c) => c.id === id)!;
}
