import { canonicalHash } from "@realityjunky/badger";
import { recordAudit, type WriteContext } from "../audit.js";
import type { Queryable } from "../database/database.js";
import type { ServiceDependencies } from "../dependencies.js";
import { objectInput, RequestError } from "../http/errors.js";
import { toIsoString } from "../util.js";
import {
  fields,
  parseQuestion,
  revisionInput,
  textInput,
  type QuestionContent,
  type QuestionEvidence,
} from "./model.js";
import {
  advanceQuestionnaireRevision,
  createRound,
  notifyQuestion,
  readQuestions,
  saveQuestion,
} from "./store.js";

interface AnswerLink {
  personId: string;
  revision: number;
}
interface FactDraft {
  text: string;
  answers: AnswerLink[];
}
export interface ResolutionInput {
  revision: number;
  kind: "confirmed" | "followed-up" | "deferred" | "withdrawn";
  facts?: FactDraft[];
  followUp?: QuestionContent;
  reason?: string;
  deferredKind?: "skill-internal" | "out-of-scope";
  skillId?: string;
}
export function parseResolution(
  body: Record<string, unknown>,
): ResolutionInput {
  fields(body, [
    "revision",
    "kind",
    "facts",
    "followUp",
    "reason",
    "deferredKind",
    "skillId",
    "confirmed",
    "confirmationHash",
    "requestId",
  ]);
  if (
    !["confirmed", "followed-up", "deferred", "withdrawn"].includes(
      body.kind as string,
    )
  )
    throw new RequestError(400, "Choose a question resolution");
  const input: ResolutionInput = {
    revision: revisionInput(body.revision),
    kind: body.kind as ResolutionInput["kind"],
  };
  if (body.reason !== undefined)
    input.reason = textInput(body.reason, "reason");
  if (input.kind === "confirmed") {
    if (
      !Array.isArray(body.facts) ||
      body.facts.length === 0 ||
      body.facts.length > 100
    )
      throw new RequestError(
        400,
        "Confirmation needs one or more formal facts",
      );
    input.facts = body.facts.map((raw) => {
      const fact = objectInput(raw);
      fields(fact, ["text", "answers"]);
      if (!Array.isArray(fact.answers) || fact.answers.length === 0)
        throw new RequestError(
          400,
          "Every fact must link to the answers it restates",
        );
      const answers = fact.answers
        .map((raw) => {
          const answer = objectInput(raw);
          fields(answer, ["personId", "revision"]);
          return {
            personId: textInput(answer.personId, "personId", 200),
            revision: revisionInput(answer.revision),
          };
        })
        .sort((a, b) => a.personId.localeCompare(b.personId));
      if (new Set(answers.map((a) => a.personId)).size !== answers.length)
        throw new RequestError(400, "Link each answering person once per fact");
      return { text: textInput(fact.text, "fact text", 20000), answers };
    });
  } else if (body.facts !== undefined)
    throw new RequestError(400, "Only a confirmation produces facts");
  if (input.kind === "followed-up")
    input.followUp = parseQuestion(objectInput(body.followUp));
  else if (body.followUp !== undefined)
    throw new RequestError(400, "Only a follow-up creates a child question");
  if (input.kind === "deferred") {
    input.reason = textInput(body.reason, "deferral reason");
    if (
      body.deferredKind !== "skill-internal" &&
      body.deferredKind !== "out-of-scope"
    )
      throw new RequestError(400, "Defer as Skill-internal or out of scope");
    input.deferredKind = body.deferredKind;
    if (body.deferredKind === "skill-internal")
      input.skillId = textInput(body.skillId, "skillId", 200);
    else if (body.skillId !== undefined)
      throw new RequestError(400, "Out-of-scope deferrals do not name a Skill");
  } else if (body.deferredKind !== undefined || body.skillId !== undefined)
    throw new RequestError(400, "Only deferrals name a deferral kind or Skill");
  return input;
}
interface ResolutionRow {
  id: string;
  question_id: string;
  revision: number;
  question_revision: number;
  kind: ResolutionInput["kind"];
  actor_id: string;
  actor_name: string;
  reason: string | null;
  deferred_kind: string | null;
  skill_id: string | null;
  child_question_id: string | null;
  confirmation_hash: string;
  input_hash: string;
  request_id: string;
  created_at: Date | string;
}
function toResolution(row: ResolutionRow) {
  return {
    id: row.id,
    questionId: row.question_id,
    revision: row.revision,
    questionRevision: row.question_revision,
    kind: row.kind,
    actorId: row.actor_id,
    reason: row.reason,
    deferredKind: row.deferred_kind,
    skillId: row.skill_id,
    childQuestionId: row.child_question_id,
    confirmationHash: row.confirmation_hash,
    createdAt: toIsoString(row.created_at),
  };
}
export async function readResolutions(tx: Queryable, versionId: string) {
  return (
    await tx.query<ResolutionRow>(
      `select r.*, p.display_name as actor_name from question_resolutions r join questions q on q.id = r.question_id join people p on p.id = r.actor_id where q.workflow_version_id = $1 order by r.created_at, r.id`,
      [versionId],
    )
  ).rows.map((row) => ({ ...toResolution(row), actorName: row.actor_name }));
}
interface FactContent extends FactDraft {
  locale: string;
  evidence: (QuestionEvidence & { fileHash: string })[];
}
interface FactRow {
  id: string;
  resolution_id: string;
  content: FactContent;
  hash: string;
  actor_id: string;
  actor_name: string;
  question_id: string;
  active: boolean;
  created_at: Date | string;
}
interface AcknowledgementRow {
  id: string;
  fact_id: string;
  person_id: string;
  person_name: string;
  decision: "acknowledged" | "disputed";
  reason: string | null;
  confirmation_hash: string;
  request_id: string;
  created_at: Date | string;
}
function toAcknowledgement(a: AcknowledgementRow) {
  return {
    id: a.id,
    factId: a.fact_id,
    personId: a.person_id,
    decision: a.decision,
    reason: a.reason,
    createdAt: toIsoString(a.created_at),
  };
}
export async function readFacts(tx: Queryable, versionId: string) {
  const rows = await tx.query<FactRow>(
    `select f.*, r.actor_id, p.display_name as actor_name, r.question_id, r.created_at,
    (q.state = 'confirmed' and q.resolution_revision = r.revision) as active
    from confirmed_facts f join question_resolutions r on r.id = f.resolution_id join questions q on q.id = r.question_id join people p on p.id = r.actor_id
    where q.workflow_version_id = $1 order by r.created_at, f.id`,
    [versionId],
  );
  const acks = await tx.query<AcknowledgementRow>(
    `select a.*, p.display_name as person_name from fact_acknowledgements a join people p on p.id = a.person_id join confirmed_facts f on f.id = a.fact_id
    join question_resolutions r on r.id = f.resolution_id join questions q on q.id = r.question_id where q.workflow_version_id = $1 order by a.created_at, a.id`,
    [versionId],
  );
  return rows.rows.map((f) => ({
    ...f.content,
    id: f.id,
    resolutionId: f.resolution_id,
    questionId: f.question_id,
    hash: f.hash,
    actorId: f.actor_id,
    actorName: f.actor_name,
    active: f.active,
    createdAt: toIsoString(f.created_at),
    acknowledgements: acks.rows
      .filter((a) => a.fact_id === f.id)
      .map((a) => ({ ...toAcknowledgement(a), personName: a.person_name })),
  }));
}

/** The preview binds submitted answer heads, evidence, locale and current resolution. */
export async function resolutionPreview(
  tx: Queryable,
  versionId: string,
  questionId: string,
  personId: string,
  input: ResolutionInput,
) {
  const question = (await readQuestions(tx, versionId, personId, true)).find(
    (q) => q.id === questionId,
  );
  if (!question) throw new RequestError(404, "No such question");
  if (question.revision !== input.revision)
    throw new RequestError(
      409,
      "The question changed; review its current revision",
      { currentRevision: question.revision },
    );
  if (!["answered", "needs-reconfirmation"].includes(question.state))
    throw new RequestError(
      409,
      "Resolve an answered question or one needing re-confirmation",
    );
  const heads = (
    await tx.query<{
      person_id: string;
      revision: number;
      question_revision: number;
      state: string;
      text: string;
    }>(
      `select r.* from question_answers a join answer_revisions r on r.question_id = a.question_id and r.person_id = a.person_id and r.revision = a.revision where a.question_id = $1 and exists (
      select 1 from question_recipients recipient join role_bindings binding on binding.id = recipient.binding_id
      where recipient.question_id = a.question_id and binding.person_id = a.person_id) order by a.person_id`,
      [questionId],
    )
  ).rows;
  const recipients = (
    await tx.query<{ person_id: string | null }>(
      `select distinct b.person_id from question_recipients r join role_bindings b on b.id = r.binding_id where r.question_id = $1`,
      [questionId],
    )
  ).rows;
  if (
    heads.length === 0 ||
    recipients.some(
      (recipient) =>
        recipient.person_id === null ||
        !heads.some((answer) => answer.person_id === recipient.person_id),
    ) ||
    heads.some(
      (a) =>
        a.state !== "submitted" || a.question_revision !== question.revision,
    )
  )
    throw new RequestError(
      409,
      "Wait for submitted answers to the current question; a draft is still being edited",
    );
  const version = (
    await tx.query<{ locale: string }>(
      "select locale from workflow_versions where id = $1",
      [versionId],
    )
  ).rows[0];
  const evidence: FactContent["evidence"] = [];
  for (const link of question.evidence) {
    const file = (
      await tx.query<{ hash: string }>(
        `select f->>'hash' as hash from workflow_skill_pins p
      join skill_versions s on s.skill_id = p.skill_id and s.hash = p.skill_version_hash,
      jsonb_array_elements(s.inventory) f where p.workflow_version_id = $1 and p.skill_id = $2 and p.skill_version_hash = $3 and f->>'path' = $4`,
        [versionId, link.skillId, link.versionHash, link.path],
      )
    ).rows[0];
    if (!file)
      throw new RequestError(
        409,
        "Question evidence changed; revise it to the current pinned Skill version",
      );
    evidence.push({ ...link, fileHash: file.hash });
  }
  const facts = (input.facts ?? []).map((fact) => {
    for (const link of fact.answers)
      if (
        !heads.some(
          (a) => a.person_id === link.personId && a.revision === link.revision,
        )
      )
        throw new RequestError(
          409,
          "Facts must restate the current submitted answer revisions",
        );
    return { ...fact, locale: version.locale, evidence };
  });
  if (
    input.kind === "confirmed" &&
    heads.some(
      (a) =>
        !facts.some((f) =>
          f.answers.some((link) => link.personId === a.person_id),
        ),
    )
  )
    throw new RequestError(
      400,
      "Confirmation must cover every submitted answer",
    );
  if (
    input.skillId &&
    !(
      await tx.query(
        "select 1 from workflow_skill_pins where workflow_version_id = $1 and skill_id = $2",
        [versionId, input.skillId],
      )
    ).rows.length
  )
    throw new RequestError(
      400,
      "Defer only to a Skill pinned by this workflow version",
    );
  // Follow-up recipients and evidence are revalidated by saveQuestion during the commit.
  const bindings = input.followUp
    ? (
        await tx.query(
          "select id, person_id, role from role_bindings where workflow_id = (select workflow_id from workflow_versions where id = $1) order by id",
          [versionId],
        )
      ).rows
    : [];
  const bound = {
    versionId,
    questionId,
    questionRevision: question.revision,
    resolutionRevision: question.resolutionRevision,
    state: question.state,
    input,
    answers: heads.map((a) => ({
      personId: a.person_id,
      revision: a.revision,
      text: a.text,
    })),
    facts,
    locale: version.locale,
    evidence,
    bindings,
  };
  return { ...bound, confirmationHash: canonicalHash(bound) };
}
async function closeQuestionInbox(
  tx: Queryable,
  deps: ServiceDependencies,
  questionId: string,
) {
  await tx.query(
    "update inbox_items set state = 'done', revision = revision + 1, updated_at = $2 where question_id = $1 and state <> 'done'",
    [questionId, deps.clock.now()],
  );
}
export async function notifyQuestionEngineers(
  tx: Queryable,
  deps: ServiceDependencies,
  versionId: string,
  questionId: string,
  eventId: string,
) {
  await tx.query(
    `insert into inbox_items (id, person_id, binding_id, workflow_version_id, gate, kind, event_id, question_id, created_at, updated_at)
    select $1 || '-' || min(b.id), b.person_id, case when b.person_id is null then min(b.id) else null end,
      $2, 'questionnaire', 'question-reopened', $3, $4, $5, $5 from role_bindings b join workflow_versions v on v.workflow_id = b.workflow_id
    where v.id = $2 and b.role = 'Engineer' group by b.person_id, case when b.person_id is null then lower(b.email) else '' end on conflict do nothing`,
    [deps.ids.next(), versionId, eventId, questionId, deps.clock.now()],
  );
}
export async function invalidateQuestionFacts(
  tx: Queryable,
  deps: ServiceDependencies,
  context: WriteContext,
  versionId: string,
  questionId: string,
  reason: string,
) {
  const changed = await tx.query(
    "update questions set state = 'needs-reconfirmation', resolved_at = null where id = $1 and workflow_version_id = $2 and state = 'confirmed' returning id",
    [questionId, versionId],
  );
  if (changed.rows.length === 0) return;
  await closeQuestionInbox(tx, deps, questionId);
  await notifyQuestionEngineers(
    tx,
    deps,
    versionId,
    questionId,
    deps.ids.next(),
  );
  await advanceQuestionnaireRevision(tx, versionId);
  await resolutionAudit(
    tx,
    deps,
    context,
    "question.reconfirmation-required",
    questionId,
    reason,
    {
      revision: null,
      hash: canonicalHash({ state: "needs-reconfirmation", reason }),
    },
  );
}
async function resolutionAudit(
  tx: Queryable,
  deps: ServiceDependencies,
  context: WriteContext,
  action: string,
  id: string,
  reason: string | null,
  after: { revision: number | null; hash: string | null },
) {
  await recordAudit(tx, deps, {
    actor: { personId: context.personId, credential: context.credential },
    channel: context.channel,
    action,
    target: { type: action.startsWith("fact.") ? "fact" : "question", id },
    before: null,
    after,
    reason,
    requestId: context.requestId,
  });
}
export async function resolveQuestion(
  tx: Queryable,
  deps: ServiceDependencies,
  context: WriteContext,
  versionId: string,
  questionId: string,
  input: ResolutionInput,
  confirmationHash: string,
  requestId: string,
) {
  const previous = (
    await tx.query<ResolutionRow & { workflow_version_id: string }>(
      "select r.*, p.display_name as actor_name, q.workflow_version_id from question_resolutions r join people p on p.id = r.actor_id join questions q on q.id = r.question_id where r.actor_id = $1 and r.request_id = $2",
      [context.personId, requestId],
    )
  ).rows[0];
  if (previous) {
    if (
      previous.workflow_version_id !== versionId ||
      previous.question_id !== questionId ||
      previous.input_hash !== canonicalHash(input) ||
      previous.confirmation_hash !== confirmationHash
    )
      throw new RequestError(
        409,
        "This request ID was already used for another resolution",
      );
    return { resolution: toResolution(previous) };
  }
  const preview = await resolutionPreview(
    tx,
    versionId,
    questionId,
    context.personId,
    input,
  );
  if (preview.confirmationHash !== confirmationHash)
    throw new RequestError(
      409,
      "The resolution inputs changed; review them again",
    );
  const id = deps.ids.next();
  let childQuestionId: string | null = null;
  if (input.followUp) {
    const round = await createRound(
      tx,
      deps,
      context,
      versionId,
      input.followUp.text.slice(0, 200),
    );
    const child = await saveQuestion(
      tx,
      deps,
      context,
      versionId,
      round.id,
      input.followUp,
    );
    childQuestionId = child.id;
    await tx.query(
      "update questions set parent_question_id = $2, state = 'open', position = 1 where id = $1",
      [child.id, questionId],
    );
    await tx.query(
      "update question_rounds set state = 'published', revision = revision + 1, published_at = $2, publication_hash = $3 where id = $1",
      [round.id, deps.clock.now(), confirmationHash],
    );
    await notifyQuestion(tx, deps, versionId, child.id, child.revision);
  }
  const row = (
    await tx.query<ResolutionRow>(
      `insert into question_resolutions (id, question_id, revision, question_revision, kind, actor_id, reason, deferred_kind, skill_id, child_question_id, confirmation_hash, input_hash, request_id, created_at)
    values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) returning *`,
      [
        id,
        questionId,
        preview.resolutionRevision + 1,
        input.revision,
        input.kind,
        context.personId,
        input.reason ?? null,
        input.deferredKind ?? null,
        input.skillId ?? null,
        childQuestionId,
        confirmationHash,
        canonicalHash(input),
        requestId,
        deps.clock.now(),
      ],
    )
  ).rows[0];
  await closeQuestionInbox(tx, deps, questionId);
  for (const fact of preview.facts) {
    const factId = deps.ids.next();
    await tx.query(
      "insert into confirmed_facts (id, resolution_id, content, hash) values ($1,$2,$3,$4)",
      [factId, id, JSON.stringify(fact), canonicalHash(fact)],
    );
    for (const answer of fact.answers) {
      await tx.query(
        "insert into fact_answer_revisions (fact_id, question_id, person_id, revision) values ($1,$2,$3,$4)",
        [factId, questionId, answer.personId, answer.revision],
      );
      await tx.query(
        `insert into inbox_items (id, person_id, workflow_version_id, gate, kind, event_id, question_id, fact_id, created_at, updated_at)
        values ($1,$2,$3,'questionnaire','restatement-ready',$4,$5,$6,$7,$7)`,
        [
          deps.ids.next(),
          answer.personId,
          versionId,
          `${factId}:${answer.personId}`,
          questionId,
          factId,
          deps.clock.now(),
        ],
      );
    }
  }
  await tx.query(
    "update questions set state = $2, resolved_at = $3, resolution_revision = $4 where id = $1",
    [questionId, input.kind, deps.clock.now(), row.revision],
  );
  await advanceQuestionnaireRevision(tx, versionId);
  await resolutionAudit(
    tx,
    deps,
    context,
    `question.${input.kind}`,
    questionId,
    input.reason ?? null,
    { revision: row.revision, hash: confirmationHash },
  );
  return { resolution: toResolution(row) };
}
export interface AcknowledgementInput {
  decision: "acknowledged" | "disputed";
  reason?: string;
}
export function parseAcknowledgement(
  body: Record<string, unknown>,
): AcknowledgementInput {
  fields(body, [
    "decision",
    "reason",
    "confirmed",
    "confirmationHash",
    "requestId",
  ]);
  if (body.decision !== "acknowledged" && body.decision !== "disputed")
    throw new RequestError(400, "Acknowledge or dispute the restatement");
  return {
    decision: body.decision,
    ...(body.decision === "disputed" || body.reason !== undefined
      ? { reason: textInput(body.reason, "reason") }
      : {}),
  };
}
export async function acknowledgementPreview(
  tx: Queryable,
  versionId: string,
  factId: string,
  personId: string,
  input: AcknowledgementInput,
) {
  const fact = (await readFacts(tx, versionId)).find((f) => f.id === factId);
  if (!fact) throw new RequestError(404, "No such fact");
  if (!fact.answers.some((a) => a.personId === personId))
    throw new RequestError(
      403,
      "Only the person whose answer this fact restates can acknowledge or dispute it",
    );
  if (!fact.active)
    throw new RequestError(
      409,
      "This restatement is no longer current; wait for re-confirmation",
    );
  if (fact.acknowledgements.some((a) => a.personId === personId))
    throw new RequestError(
      409,
      "You have already responded to this restatement",
    );
  const bound = {
    versionId,
    factId,
    factHash: fact.hash,
    personId,
    input,
    text: fact.text,
    locale: fact.locale,
    answers: fact.answers,
  };
  return { ...bound, confirmationHash: canonicalHash(bound) };
}
export async function acknowledgeFact(
  tx: Queryable,
  deps: ServiceDependencies,
  context: WriteContext,
  versionId: string,
  factId: string,
  input: AcknowledgementInput,
  confirmationHash: string,
  requestId: string,
) {
  const previous = (
    await tx.query<AcknowledgementRow & { workflow_version_id: string }>(
      "select a.*, p.display_name as person_name, q.workflow_version_id from fact_acknowledgements a join people p on p.id = a.person_id join confirmed_facts f on f.id = a.fact_id join question_resolutions r on r.id = f.resolution_id join questions q on q.id = r.question_id where a.person_id = $1 and a.request_id = $2",
      [context.personId, requestId],
    )
  ).rows[0];
  if (previous) {
    if (
      previous.workflow_version_id !== versionId ||
      previous.fact_id !== factId ||
      previous.decision !== input.decision ||
      previous.reason !== (input.reason ?? null) ||
      previous.confirmation_hash !== confirmationHash
    )
      throw new RequestError(
        409,
        "This request ID was already used for another acknowledgement",
      );
    return { acknowledgement: toAcknowledgement(previous) };
  }
  const preview = await acknowledgementPreview(
    tx,
    versionId,
    factId,
    context.personId,
    input,
  );
  if (preview.confirmationHash !== confirmationHash)
    throw new RequestError(409, "The restatement changed; review it again");
  const row = (
    await tx.query<AcknowledgementRow>(
      `insert into fact_acknowledgements (id, fact_id, person_id, decision, reason, confirmation_hash, request_id, created_at)
    values ($1,$2,$3,$4,$5,$6,$7,$8) returning *`,
      [
        deps.ids.next(),
        factId,
        context.personId,
        input.decision,
        input.reason ?? null,
        confirmationHash,
        requestId,
        deps.clock.now(),
      ],
    )
  ).rows[0];
  await tx.query(
    "update inbox_items set state = 'done', revision = revision + 1, updated_at = $3 where fact_id = $1 and person_id = $2 and state <> 'done'",
    [factId, context.personId, deps.clock.now()],
  );
  if (input.decision === "disputed") {
    const fact = (await readFacts(tx, versionId)).find((f) => f.id === factId)!;
    await invalidateQuestionFacts(
      tx,
      deps,
      context,
      versionId,
      fact.questionId,
      input.reason!,
    );
    await tx.query("update questions set state = 'open' where id = $1", [
      fact.questionId,
    ]);
    await notifyQuestion(tx, deps, versionId, fact.questionId, row.id);
  }
  await advanceQuestionnaireRevision(tx, versionId);
  await resolutionAudit(
    tx,
    deps,
    context,
    `fact.${input.decision}`,
    factId,
    input.reason ?? null,
    { revision: null, hash: confirmationHash },
  );
  return { acknowledgement: toAcknowledgement(row) };
}

/** Read through both library and workflow permissions; a library grant alone reveals no workflow. */
export async function readSkillBacklog(
  tx: Queryable,
  skillId: string,
  visibleWorkflowIds: string[],
) {
  return (
    await tx.query<{
      question_id: string;
      text: string;
      reason: string;
      actor_id: string;
      created_at: Date | string;
      workflow_id: string;
      workflow_name: string;
      workflow_version_id: string;
    }>(
      `select q.id as question_id, qr.content->>'text' as text, r.reason, r.actor_id, r.created_at,
    v.workflow_id, v.name as workflow_name, q.workflow_version_id from question_resolutions r
    join questions q on q.id = r.question_id and q.resolution_revision = r.revision
    join question_revisions qr on qr.question_id = q.id and qr.revision = q.revision
    join workflow_versions v on v.id = q.workflow_version_id
    where r.skill_id = $1 and r.deferred_kind = 'skill-internal' and q.state = 'deferred' and v.workflow_id = any($2::text[]) order by r.created_at, q.id`,
      [skillId, visibleWorkflowIds],
    )
  ).rows.map((r) => ({
    questionId: r.question_id,
    text: r.text,
    reason: r.reason,
    actorId: r.actor_id,
    createdAt: toIsoString(r.created_at),
    workflowId: r.workflow_id,
    workflowName: r.workflow_name,
    versionId: r.workflow_version_id,
    href: `/questionnaire/questions/${encodeURIComponent(r.question_id)}`,
  }));
}

/** A replacement only reopens facts whose cited file bytes changed or disappeared. */
export async function invalidateSkillFactEvidence(
  tx: Queryable,
  deps: ServiceDependencies,
  context: WriteContext,
  versionId: string,
  skillId: string,
) {
  const inventory =
    (
      await tx.query<{ inventory: { path: string; hash: string }[] }>(
        `select s.inventory from workflow_skill_pins p join skill_versions s on s.skill_id = p.skill_id and s.hash = p.skill_version_hash where p.workflow_version_id = $1 and p.skill_id = $2`,
        [versionId, skillId],
      )
    ).rows[0]?.inventory ?? [];
  const questions = new Set(
    (await readFacts(tx, versionId))
      .filter(
        (f) =>
          f.active &&
          f.evidence.some(
            (link) =>
              link.skillId === skillId &&
              !inventory.some(
                (file) =>
                  file.path === link.path && file.hash === link.fileHash,
              ),
          ),
      )
      .map((f) => f.questionId),
  );
  for (const questionId of questions)
    await invalidateQuestionFacts(
      tx,
      deps,
      context,
      versionId,
      questionId,
      "The pinned Skill evidence changed",
    );
}
