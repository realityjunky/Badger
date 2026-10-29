import type { Queryable } from "../database/database.js";
import { readAnswers } from "./answers.js";
import { readComments } from "./comments.js";
import { readQuestions } from "./store.js";

/** The person's current assignments, using the same views as the dashboard. */
export async function readMyQuestions(
  database: Queryable,
  personId: string,
  filter: { workflowId: string | null; versionId: string | null },
) {
  const versions = await database.query<{
    workflow_id: string;
    version_id: string;
  }>(
    `select distinct v.workflow_id, v.id as version_id from question_recipients r
       join role_bindings b on b.id = r.binding_id
       join questions q on q.id = r.question_id
       join workflow_versions v on v.id = q.workflow_version_id
      where b.person_id = $1 and q.state in ('open', 'answered', 'needs-reconfirmation')
        and ($2::text is null or v.workflow_id = $2)
        and ($3::text is null or v.id = $3)
      order by v.workflow_id, v.id`,
    [personId, filter.workflowId, filter.versionId],
  );
  const questions = [];
  for (const version of versions.rows) {
    const current = await readQuestions(
      database,
      version.version_id,
      personId,
      false,
    );
    const answers = await readAnswers(database, version.version_id, personId);
    const comments = await readComments(database, version.version_id, false);
    for (const question of current.filter(
      (q) =>
        q.canAnswer &&
        ["open", "answered", "needs-reconfirmation"].includes(q.state),
    )) {
      const { revisions: _history, ...content } = question;
      const answer = answers.find(
        (a) => a.questionId === question.id && a.personId === personId,
      );
      const { revisions: _answerHistory, ...currentAnswer } = answer ?? {};
      questions.push({
        workflowId: version.workflow_id,
        versionId: version.version_id,
        ...content,
        answer: answer ? currentAnswer : null,
        comments: comments.filter((c) => c.questionId === question.id),
      });
    }
  }
  return { questions };
}
