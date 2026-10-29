import type { WriteContext } from "../audit.js";
import type { Queryable } from "../database/database.js";
import type { ServiceDependencies } from "../dependencies.js";
import { RequestError } from "../http/errors.js";
import { toIsoString } from "../util.js";
import type { Answer, AnswerRevision } from "./model.js";
import {
  recordQuestionnaireAudit,
  advanceQuestionnaireRevision,
  readQuestions,
} from "./store.js";

interface AnswerRow {
  question_id: string;
  person_id: string;
  display_name: string;
  revision: number;
  question_revision: number;
  text: string;
  state: "draft" | "submitted";
  channel: "web" | "mcp";
  agent_host: string | null;
  created_at: string | Date;
}
function toRevision(row: AnswerRow): AnswerRevision {
  return {
    revision: row.revision,
    questionRevision: row.question_revision,
    text: row.text,
    state: row.state,
    channel: row.channel,
    agentHost: row.agent_host,
    createdAt: toIsoString(row.created_at),
  };
}

/** Drafts belong only to their author; everyone else sees submitted history. */
export async function readAnswers(
  tx: Queryable,
  versionId: string,
  personId: string,
): Promise<Answer[]> {
  const rows = await tx.query<AnswerRow>(
    `select r.*, p.display_name from answer_revisions r join questions q on q.id = r.question_id
    join people p on p.id = r.person_id where q.workflow_version_id = $1 and q.state <> 'draft'
      and (r.person_id = $2 or r.state = 'submitted') order by r.question_id, r.person_id, r.revision`,
    [versionId, personId],
  );
  const answers = new Map<string, Answer>();
  for (const row of rows.rows) {
    const key = JSON.stringify([row.question_id, row.person_id]);
    const revision = toRevision(row);
    const revisions = [...(answers.get(key)?.revisions ?? []), revision];
    answers.set(key, {
      ...revision,
      questionId: row.question_id,
      personId: row.person_id,
      personName: row.display_name,
      revisions,
    });
  }
  return [...answers.values()];
}

export interface AnswerInput {
  questionId: string;
  questionRevision: number;
  revision: number;
}

/** Called under the version lock, also serializing first drafts on two devices. */
async function answerForWrite(
  tx: Queryable,
  versionId: string,
  personId: string,
  input: AnswerInput,
) {
  const row = (
    await tx.query<{
      id: string;
      round_id: string;
      revision: number;
      resolved_at: Date | string | null;
      assigned: boolean;
    }>(
      `select q.id, q.round_id, q.revision, q.resolved_at,
    exists (select 1 from question_recipients r join role_bindings b on b.id = r.binding_id
      where r.question_id = q.id and b.person_id = $3) as assigned
    from questions q where q.workflow_version_id = $1 and q.id = $2 and q.state <> 'draft'`,
      [versionId, input.questionId, personId],
    )
  ).rows[0];
  const question =
    row === undefined
      ? undefined
      : {
          id: row.id,
          roundId: row.round_id,
          revision: row.revision,
          canAnswer: row.assigned && row.resolved_at === null,
        };
  if (!question) throw new RequestError(404, "No such published question");
  if (!question.canAnswer)
    throw new RequestError(
      403,
      "Only a current assignee may answer an unresolved question",
    );
  if (question.revision !== input.questionRevision)
    throw new RequestError(
      409,
      "The Engineer revised the question; read it before answering",
      { currentRevision: question.revision },
    );
  const result = await tx.query<AnswerRow>(
    `select r.* from question_answers a join answer_revisions r
    on r.question_id = a.question_id and r.person_id = a.person_id and r.revision = a.revision
    where a.question_id = $1 and a.person_id = $2`,
    [input.questionId, personId],
  );
  const answer = result.rows[0];
  if ((answer?.revision ?? 0) !== input.revision)
    throw new RequestError(
      409,
      "Your answer changed on another device; reload before saving",
      { currentRevision: answer?.revision ?? 0 },
    );
  return { question, answer };
}

async function appendAnswer(
  tx: Queryable,
  deps: ServiceDependencies,
  context: WriteContext,
  versionId: string,
  input: AnswerInput,
  text: string,
  state: "draft" | "submitted",
  agentHost: string | null,
) {
  const revision = input.revision + 1;
  await tx.query(
    `insert into question_answers (question_id, person_id, revision) values ($1, $2, $3)
    on conflict (question_id, person_id) do update set revision = excluded.revision`,
    [input.questionId, context.personId, revision],
  );
  await tx.query(
    `insert into answer_revisions (question_id, person_id, revision, question_revision, text, state, channel, agent_host, created_at)
    values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      input.questionId,
      context.personId,
      revision,
      input.questionRevision,
      text,
      state,
      context.channel,
      agentHost,
      deps.clock.now(),
    ],
  );
  await advanceQuestionnaireRevision(tx, versionId);
  await recordQuestionnaireAudit(
    tx,
    deps,
    context,
    state === "draft" ? "answer.draft-saved" : "answer.submitted",
    "answer",
    `${input.questionId}:${context.personId}`,
    revision,
    input.revision || null,
  );
}

export async function saveAnswer(
  tx: Queryable,
  deps: ServiceDependencies,
  context: WriteContext,
  versionId: string,
  input: AnswerInput,
  text: string,
  agentHost: string | null,
) {
  await answerForWrite(tx, versionId, context.personId, input);
  await appendAnswer(
    tx,
    deps,
    context,
    versionId,
    input,
    text,
    "draft",
    agentHost,
  );
  return (await readAnswers(tx, versionId, context.personId)).find(
    (a) => a.questionId === input.questionId && a.personId === context.personId,
  )!;
}

/** Validate every draft first. Any stale or missing draft rolls back the round. */
export async function submitAnswers(
  tx: Queryable,
  deps: ServiceDependencies,
  context: WriteContext,
  versionId: string,
  inputs: AnswerInput[],
  agentHost: string | null,
  roundId?: string,
) {
  if (
    inputs.length === 0 ||
    new Set(inputs.map((a) => a.questionId)).size !== inputs.length
  )
    throw new RequestError(
      400,
      "Select distinct questions with saved drafts to submit",
    );
  if (roundId !== undefined) {
    const assigned = (
      await readQuestions(tx, versionId, context.personId, false)
    ).filter((question) => question.roundId === roundId && question.canAnswer);
    const answers = await readAnswers(tx, versionId, context.personId);
    const missing = assigned.some((question) => {
      const answer = answers.find(
        (a) => a.questionId === question.id && a.personId === context.personId,
      );
      const submitted =
        answer?.state === "submitted" &&
        answer.questionRevision === question.revision;
      return (
        !submitted && !inputs.some((input) => input.questionId === question.id)
      );
    });
    if (missing)
      throw new RequestError(
        409,
        "Submit every outstanding assigned answer in this round, or use per-question submission",
      );
  }
  const prepared = [];
  for (const input of inputs) {
    const { question, answer } = await answerForWrite(
      tx,
      versionId,
      context.personId,
      input,
    );
    if (roundId !== undefined && question.roundId !== roundId)
      throw new RequestError(400, "Every answer must belong to this round");
    if (
      !answer ||
      !answer.text.trim() ||
      answer.question_revision !== input.questionRevision
    )
      throw new RequestError(
        409,
        "Save a nonempty draft for the current question before submitting",
      );
    prepared.push({ input, text: answer.text });
  }
  for (const { input, text } of prepared) {
    await appendAnswer(
      tx,
      deps,
      context,
      versionId,
      input,
      text,
      "submitted",
      agentHost,
    );
    await tx.query(
      `update inbox_items i set state = 'done', revision = revision + 1, updated_at = $3
      where i.question_id = $1 and i.state <> 'done' and (i.person_id = $2 or exists
        (select 1 from role_bindings b where b.id = i.binding_id and b.person_id = $2))`,
      [input.questionId, context.personId, deps.clock.now()],
    );
    await tx.query(
      `update questions q set state = case when not exists (
      select 1 from question_recipients a join role_bindings b on b.id = a.binding_id where a.question_id = q.id
        and (b.person_id is null or not exists (select 1 from answer_revisions r where r.question_id = q.id
          and r.person_id = b.person_id and r.question_revision = q.revision and r.state = 'submitted'))
      ) then 'answered' else 'open' end where q.id = $1`,
      [input.questionId],
    );
  }
  return (await readAnswers(tx, versionId, context.personId)).filter(
    (a) =>
      a.personId === context.personId &&
      inputs.some((i) => i.questionId === a.questionId),
  );
}
