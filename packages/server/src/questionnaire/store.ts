import { invalidateQuestionFacts } from "./resolutions.js";
import { readTranslations } from "./translations.js";
import { readImportedSources } from "./imports.js";
import { reconcileDossier } from "../dossier.js";
import { canonicalHash } from "@realityjunky/badger";
import { recordAudit, type WriteContext } from "../audit.js";
import type { Queryable } from "../database/database.js";
import type { ServiceDependencies } from "../dependencies.js";
import { RequestError } from "../http/errors.js";
import { toIsoString } from "../util.js";
import { evidenceComparison } from "../evidence-changes.js";
import { readRecordOrigins } from "../version-inheritance.js";
import type {
  Question,
  QuestionContent,
  QuestionRound,
  QuestionRevision,
} from "./model.js";

export interface RoundRow {
  id: string;
  number: number;
  title: string;
  state: "draft" | "published";
  revision: number;
  published_at: Date | string | null;
  publication_hash: string | null;
}
interface QuestionRow {
  id: string;
  round_id: string;
  revision: number;
  state: Question["state"];
  position: number | null;
  resolved_at: Date | string | null;
  parent_question_id: string | null;
  resolution_revision: number;
  content: QuestionContent;
}
export function toRound(row: RoundRow): QuestionRound {
  return {
    id: row.id,
    number: row.number,
    title: row.title,
    state: row.state,
    revision: row.revision,
    publishedAt:
      row.published_at === null ? null : toIsoString(row.published_at),
  };
}
export async function advanceQuestionnaireRevision(
  tx: Queryable,
  versionId: string,
  deps: ServiceDependencies,
  context: WriteContext,
) {
  await tx.query(
    `insert into questionnaires (workflow_version_id) values ($1)
    on conflict (workflow_version_id) do update set revision = questionnaires.revision + 1`,
    [versionId],
  );
  await reconcileDossier(tx, deps, context, versionId);
}
export async function recordQuestionnaireAudit(
  tx: Queryable,
  deps: ServiceDependencies,
  context: WriteContext,
  action: string,
  type: string,
  id: string,
  revision: number,
  before: number | null,
) {
  await recordAudit(tx, deps, {
    actor: { personId: context.personId, credential: context.credential },
    channel: context.channel,
    action,
    target: { type, id },
    before: before === null ? null : { revision: before, hash: null },
    after: { revision, hash: null },
    reason: null,
    requestId: context.requestId,
  });
}
export async function readRound(tx: Queryable, versionId: string, id: string) {
  const result = await tx.query<RoundRow>(
    "select * from question_rounds where id = $1 and workflow_version_id = $2",
    [id, versionId],
  );
  if (!result.rows[0])
    throw new RequestError(404, "No such round in this workflow version");
  return result.rows[0];
}
export async function readQuestions(
  tx: Queryable,
  versionId: string,
  personId: string,
  compose: boolean,
): Promise<Question[]> {
  const result = await tx.query<QuestionRow>(
    `select q.*, r.content from questions q
    join question_revisions r on r.question_id = q.id and r.revision = q.revision
    join question_rounds b on b.id = q.round_id
    where q.workflow_version_id = $1 and ($2::boolean or q.state <> 'draft')
    order by b.number, q.position nulls last, (r.content->>'priority')::integer desc, q.created_at, q.id`,
    [versionId, compose],
  );
  const revisions = await tx.query<{
    question_id: string;
    revision: number;
    content: QuestionContent;
    actor_id: string;
    created_at: Date | string;
  }>(
    `select r.* from question_revisions r join questions q on q.id = r.question_id
    where q.workflow_version_id = $1 and ($2::boolean or q.state <> 'draft') order by r.revision`,
    [versionId, compose],
  );
  const assigned = await tx.query<{ question_id: string }>(
    `select distinct a.question_id from question_recipients a join role_bindings b on b.id = a.binding_id
    join questions q on q.id = a.question_id where q.workflow_version_id = $1 and b.person_id = $2`,
    [versionId, personId],
  );
  const history = new Map<string, QuestionRevision[]>();
  for (const row of revisions.rows) {
    const entries = history.get(row.question_id) ?? [];
    entries.push({
      ...row.content,
      revision: row.revision,
      actorId: row.actor_id,
      createdAt: toIsoString(row.created_at),
    });
    history.set(row.question_id, entries);
  }
  const assignedIds = new Set(assigned.rows.map((row) => row.question_id));
  const translations = await readTranslations(tx, versionId);
  const sources = await readImportedSources(tx, versionId);
  const compareEvidence = await evidenceComparison(tx, versionId);
  const origins = await readRecordOrigins(tx, versionId, "question");
  return Promise.all(
    result.rows.map(async (row) => ({
      ...row.content,
      id: row.id,
      roundId: row.round_id,
      revision: row.revision,
      state: row.state,
      evidenceChanges: await compareEvidence(row.content.evidence),
      origin: origins.get(row.id) ?? null,
      position: row.position,
      parentQuestionId: row.parent_question_id,
      resolutionRevision: row.resolution_revision,
      resolvedAt:
        row.resolved_at === null ? null : toIsoString(row.resolved_at),
      revisions: history.get(row.id) ?? [],
      translations: translations.filter(
        (translation) => translation.questionId === row.id,
      ),
      source: sources.get(row.id) ?? null,
      canAnswer:
        row.state !== "draft" &&
        (row.resolved_at === null || row.state === "confirmed") &&
        assignedIds.has(row.id),
    })),
  );
}

async function recipients(
  tx: Queryable,
  versionId: string,
  content: QuestionContent,
) {
  const bindings = await tx.query<{
    id: string;
    person_id: string | null;
    role: string;
  }>(
    `select b.id, b.person_id, b.role from role_bindings b join workflow_versions v on v.workflow_id = b.workflow_id
    where v.id = $1 and b.role in ('Workflow owner', 'Field expert') order by b.id`,
    [versionId],
  );
  const matches = bindings.rows.filter((b) =>
    content.assignees.some((a) =>
      a.kind === "person" ? a.personId === b.person_id : a.role === b.role,
    ),
  );
  if (
    content.assignees.some(
      (a) =>
        !matches.some((b) =>
          a.kind === "person" ? a.personId === b.person_id : a.role === b.role,
        ),
    )
  )
    throw new RequestError(
      400,
      "Every assignee must hold an expert or owner role in this workflow",
    );
  // One binding per person (or pending address) is selected below by SQL when
  // creating inbox items. Keeping all grants here preserves additive roles.
  return matches;
}

async function validateEvidence(
  tx: Queryable,
  versionId: string,
  content: QuestionContent,
) {
  for (const link of content.evidence) {
    const result = await tx.query<{ present: boolean }>(
      `select exists (select 1 from workflow_skill_pins p join skill_versions s on s.skill_id = p.skill_id and s.hash = p.skill_version_hash
      where p.workflow_version_id = $1 and p.skill_id = $2 and p.skill_version_hash = $3
        and exists (select 1 from jsonb_array_elements(s.inventory) f where f->>'path' = $4)) as present`,
      [versionId, link.skillId, link.versionHash, link.path],
    );
    if (!result.rows[0]?.present)
      throw new RequestError(
        400,
        "Evidence must name a file in a pinned Skill version",
      );
  }
}

export async function createRound(
  tx: Queryable,
  deps: ServiceDependencies,
  context: WriteContext,
  versionId: string,
  title: string,
) {
  const id = deps.ids.next();
  const result = await tx.query<RoundRow>(
    `insert into question_rounds (id, workflow_version_id, number, title, created_by, created_at)
    select $1, $2, coalesce(max(number), 0) + 1, $3, $4, $5 from question_rounds where workflow_version_id = $2 returning *`,
    [id, versionId, title, context.personId, deps.clock.now()],
  );
  await advanceQuestionnaireRevision(tx, versionId, deps, context);
  await recordQuestionnaireAudit(
    tx,
    deps,
    context,
    "round.created",
    "round",
    id,
    1,
    null,
  );
  return toRound(result.rows[0]);
}

export async function saveQuestion(
  tx: Queryable,
  deps: ServiceDependencies,
  context: WriteContext,
  versionId: string,
  roundId: string,
  content: QuestionContent,
  previous?: { id: string; revision: number },
) {
  const round = await readRound(tx, versionId, roundId);
  const existing =
    previous === undefined
      ? undefined
      : (await readQuestions(tx, versionId, context.personId, true)).find(
          (q) => q.id === previous.id,
        );
  if (previous !== undefined && existing === undefined)
    throw new RequestError(404, "No such question");
  if (existing && existing.revision !== previous!.revision)
    throw new RequestError(409, "The question changed since you read it", {
      currentRevision: existing.revision,
    });
  if (existing?.resolvedAt && existing.state !== "confirmed")
    throw new RequestError(
      409,
      "The Engineer has already resolved this question",
    );
  if (previous === undefined && round.state !== "draft")
    throw new RequestError(409, "Add new questions to a draft round");
  await validateEvidence(tx, versionId, content);
  const bindings = await recipients(tx, versionId, content);
  const id = existing?.id ?? deps.ids.next();
  const revision = (existing?.revision ?? 0) + 1;
  if (existing) {
    await invalidateQuestionFacts(
      tx,
      deps,
      context,
      versionId,
      id,
      "The confirmed question or its evidence changed",
    );
    await tx.query(
      "update questions set revision = $2, state = case when state = 'draft' then 'draft' when state = 'needs-reconfirmation' then state else 'open' end where id = $1",
      [id, revision],
    );
    await tx.query("delete from question_recipients where question_id = $1", [
      id,
    ]);
    await tx.query(
      "update inbox_items set state = 'done', revision = revision + 1 where question_id = $1 and state <> 'done'",
      [id],
    );
  } else {
    await tx.query(
      "insert into questions (id, workflow_version_id, round_id, created_at) values ($1, $2, $3, $4)",
      [id, versionId, roundId, deps.clock.now()],
    );
  }
  await tx.query(
    "insert into question_revisions (question_id, revision, content, actor_id, created_at) values ($1, $2, $3, $4, $5)",
    [id, revision, JSON.stringify(content), context.personId, deps.clock.now()],
  );
  for (const binding of bindings)
    await tx.query(
      "insert into question_recipients (question_id, binding_id) values ($1, $2)",
      [id, binding.id],
    );
  if (existing?.state !== undefined && existing.state !== "draft")
    await notifyQuestion(tx, deps, versionId, id, revision);
  await tx.query(
    "update question_rounds set revision = revision + 1 where id = $1",
    [roundId],
  );
  await advanceQuestionnaireRevision(tx, versionId, deps, context);
  await recordQuestionnaireAudit(
    tx,
    deps,
    context,
    existing ? "question.revised" : "question.drafted",
    "question",
    id,
    revision,
    existing?.revision ?? null,
  );
  return (await readQuestions(tx, versionId, context.personId, true)).find(
    (q) => q.id === id,
  )!;
}

export async function notifyQuestion(
  tx: Queryable,
  deps: ServiceDependencies,
  versionId: string,
  questionId: string,
  revision: number | string,
) {
  await tx.query(
    `insert into inbox_items (id, person_id, binding_id, workflow_version_id, gate, kind, event_id, question_id, created_at, updated_at)
    select $1 || '-' || min(b.id), b.person_id, case when b.person_id is null then min(b.id) else null end,
      $2, 'questionnaire', 'question-assigned', $3, $4, $5, $5
    from question_recipients a join role_bindings b on b.id = a.binding_id where a.question_id = $4
    group by b.person_id, case when b.person_id is null then lower(b.email) else '' end on conflict do nothing`,
    [
      deps.ids.next(),
      versionId,
      `${questionId}:${revision}`,
      questionId,
      deps.clock.now(),
    ],
  );
}

export async function publicationPreview(
  tx: Queryable,
  versionId: string,
  roundId: string,
  personId: string,
) {
  const round = await readRound(tx, versionId, roundId);
  const questions = (await readQuestions(tx, versionId, personId, true)).filter(
    (q) => q.roundId === roundId,
  );
  if (questions.length === 0)
    throw new RequestError(409, "Add at least one question before publishing");
  const settings = await tx.query<{
    round_size_limit: number | null;
    revision: number;
  }>(
    "select s.* from questionnaire_settings s join workflow_versions v on v.workflow_id = s.workflow_id where v.id = $1",
    [versionId],
  );
  const roundSizeLimit = settings.rows[0]?.round_size_limit ?? null;
  if (roundSizeLimit !== null && questions.length > roundSizeLimit)
    throw new RequestError(
      409,
      `This workflow limits rounds to ${roundSizeLimit} questions`,
    );
  const bindings = [];
  for (const q of questions)
    bindings.push({
      questionId: q.id,
      recipients: await recipients(tx, versionId, q),
    });
  const records = questions.map((q) => ({
    id: q.id,
    revision: q.revision,
    text: q.text,
    answerType: q.answerType ?? { kind: "free-text" as const },
    priority: q.priority,
    hash: canonicalHash(q.revisions.at(-1)!),
  }));
  const bound = {
    versionId,
    round: toRound(round),
    questions: records,
    bindings,
    settings: settings.rows[0] ?? null,
  };
  return {
    roundId,
    revision: round.revision,
    questions: records,
    confirmationHash: canonicalHash(bound),
  };
}

export async function publishRound(
  tx: Queryable,
  deps: ServiceDependencies,
  context: WriteContext,
  versionId: string,
  roundId: string,
  hash: string,
) {
  const round = await readRound(tx, versionId, roundId);
  if (round.state === "published") {
    if (round.publication_hash === hash) return toRound(round);
    throw new RequestError(409, "This round has already been published");
  }
  const preview = await publicationPreview(
    tx,
    versionId,
    roundId,
    context.personId,
  );
  if (preview.confirmationHash !== hash)
    throw new RequestError(
      409,
      "The round changed; review it again before publishing",
    );
  const questions = new Map(
    (await readQuestions(tx, versionId, context.personId, true)).map(
      (question) => [question.id, question],
    ),
  );
  for (const [index, q] of preview.questions.entries()) {
    // Role selectors are resolved again at publication, so the reviewed
    // recipients include people invited after the draft was first saved.
    const question = questions.get(q.id)!;
    await tx.query("delete from question_recipients where question_id = $1", [
      q.id,
    ]);
    for (const binding of await recipients(tx, versionId, question))
      await tx.query(
        "insert into question_recipients (question_id, binding_id) values ($1, $2)",
        [q.id, binding.id],
      );
    await tx.query(
      "update questions set state = 'open', position = $2 where id = $1",
      [q.id, index + 1],
    );
    await notifyQuestion(tx, deps, versionId, q.id, q.revision);
  }
  const result = await tx.query<RoundRow>(
    "update question_rounds set state = 'published', revision = revision + 1, published_at = $2, publication_hash = $3 where id = $1 returning *",
    [roundId, deps.clock.now(), hash],
  );
  await advanceQuestionnaireRevision(tx, versionId, deps, context);
  await recordQuestionnaireAudit(
    tx,
    deps,
    context,
    "round.published",
    "round",
    roundId,
    round.revision + 1,
    round.revision,
  );
  return toRound(result.rows[0]);
}

export async function readSettings(tx: Queryable, workflowId: string) {
  const result = await tx.query<{
    revision: number;
    round_size_limit: number | null;
  }>(
    "select revision, round_size_limit from questionnaire_settings where workflow_id = $1",
    [workflowId],
  );
  return {
    revision: result.rows[0]?.revision ?? 0,
    roundSizeLimit: result.rows[0]?.round_size_limit ?? null,
  };
}
export async function saveSettings(
  tx: Queryable,
  deps: ServiceDependencies,
  context: WriteContext,
  workflowId: string,
  revision: number,
  limit: number | null,
) {
  const current = await readSettings(tx, workflowId);
  if (current.revision !== revision)
    throw new RequestError(409, "The workflow's round size limit changed", {
      currentRevision: current.revision,
    });
  await tx.query(
    `insert into questionnaire_settings (workflow_id, round_size_limit, revision) values ($1, $2, $3)
    on conflict (workflow_id) do update set round_size_limit = excluded.round_size_limit, revision = excluded.revision`,
    [workflowId, limit, revision + 1],
  );
  await tx.query(
    "update questionnaires set revision = revision + 1 where workflow_version_id in (select id from workflow_versions where workflow_id = $1)",
    [workflowId],
  );
  await recordQuestionnaireAudit(
    tx,
    deps,
    context,
    "questionnaire.settings-updated",
    "workflow",
    workflowId,
    revision + 1,
    revision || null,
  );
  return readSettings(tx, workflowId);
}
