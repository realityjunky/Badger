import { canonicalHash } from "@realityjunky/badger";
import { recordAudit, type WriteContext } from "../audit.js";
import type { Queryable } from "../database/database.js";
import type { ServiceDependencies } from "../dependencies.js";
import { RequestError } from "../http/errors.js";
import { toIsoString } from "../util.js";
import type { AnswerAttachment, AnswerValue } from "./answer-types.js";
import { fields, textInput, type QuestionContent } from "./model.js";
import { advanceQuestionnaireRevision } from "./store.js";
import type { SkillQuestionnaireScope } from "./subject.js";

export function successorHashInput(value: unknown) {
  const hash = textInput(value, "successorVersionHash", 64);
  if (!/^[a-f0-9]{64}$/u.test(hash))
    throw new RequestError(400, "Choose a saved successor hash");
  return hash;
}

export async function validateSkillSuccessor(
  tx: Queryable,
  scope: SkillQuestionnaireScope,
  successorVersionHash: string,
) {
  if (successorVersionHash === scope.versionHash)
    throw new RequestError(
      400,
      "A successor must be a different version of this Skill",
    );
  const origin = await tx.query(
    `select 1 from skill_version_edit_origins
     where skill_id = $1 and base_hash = $2 and hash = $3`,
    [scope.skillId, scope.versionHash, successorVersionHash],
  );
  if (!origin.rows.length)
    throw new RequestError(
      400,
      "Choose a saved successor derived from the Skill version under review",
    );
}

interface SuccessorLinkInput {
  resolutionId: string;
  successorVersionHash: string;
}

export function parseSuccessorLink(
  body: Record<string, unknown>,
): SuccessorLinkInput {
  fields(body, [
    "resolutionId",
    "successorVersionHash",
    "confirmed",
    "confirmationHash",
    "requestId",
  ]);
  return {
    resolutionId: textInput(body.resolutionId, "resolutionId", 200),
    successorVersionHash: successorHashInput(body.successorVersionHash),
  };
}

export async function successorLinkPreview(
  tx: Queryable,
  scope: SkillQuestionnaireScope,
  questionId: string,
  input: SuccessorLinkInput,
) {
  const resolution = (
    await tx.query<{
      resolution_revision: number;
      question_revision: number;
      confirmation_hash: string;
      answer_type: QuestionContent["answerType"] | null;
      kind: string;
      successor_version_hash: string | null;
      current: boolean;
    }>(
      `select r.revision as resolution_revision, r.question_revision, r.confirmation_hash,
          qr.content->'answerType' as answer_type, o.kind, o.successor_version_hash,
          (q.state = 'confirmed' and q.resolution_revision = r.revision
           and q.revision = r.question_revision) as current
       from effective_skill_question_outcomes o
       join question_resolutions r on r.id = o.resolution_id
       join questions q on q.id = o.question_id
       join question_revisions qr on qr.question_id = q.id and qr.revision = r.question_revision
       where q.skill_questionnaire_id = $1 and q.id = $2 and r.id = $3`,
      [scope.id, questionId, input.resolutionId],
    )
  ).rows[0];
  if (!resolution)
    throw new RequestError(404, "No such Skill resolution for this question");
  if (
    resolution.kind !== "change" ||
    resolution.successor_version_hash !== null ||
    !resolution.current
  )
    throw new RequestError(
      409,
      "Choose a current reviewed change awaiting a successor",
    );
  await validateSkillSuccessor(tx, scope, input.successorVersionHash);
  const facts = (
    await tx.query<{ id: string; hash: string; text: string }>(
      `select id, hash, content->>'text' as text from confirmed_facts
       where resolution_id = $1 order by id`,
      [input.resolutionId],
    )
  ).rows;
  const answers = (
    await tx.query<{
      personId: string;
      revision: number;
      text: string;
      value: AnswerValue;
      attachments: AnswerAttachment[];
    }>(
      `select distinct a.person_id as "personId", a.revision, a.text, a.value, a.attachments
       from confirmed_facts f join fact_answer_revisions fa on fa.fact_id = f.id
       join answer_revisions a on a.question_id = fa.question_id and a.person_id = fa.person_id and a.revision = fa.revision
       where f.resolution_id = $1 order by "personId", a.revision`,
      [input.resolutionId],
    )
  ).rows;
  const bound = {
    ...input,
    questionId,
    skillId: scope.skillId,
    versionHash: scope.versionHash,
    resolutionRevision: resolution.resolution_revision,
    questionRevision: resolution.question_revision,
    resolutionConfirmationHash: resolution.confirmation_hash,
    answerType: resolution.answer_type ?? { kind: "free-text" },
    locale: "und",
    facts,
    answers,
  };
  return { ...bound, confirmationHash: canonicalHash(bound) };
}

interface SuccessorLinkRow {
  id: string;
  actor_id: string;
  resolution_id: string;
  skill_id: string;
  version_hash: string;
  successor_version_hash: string;
  confirmation_hash: string;
  created_at: Date | string;
}

function toSuccessorLink(row: SuccessorLinkRow) {
  return {
    id: row.id,
    actorId: row.actor_id,
    resolutionId: row.resolution_id,
    skillId: row.skill_id,
    versionHash: row.version_hash,
    successorVersionHash: row.successor_version_hash,
    confirmationHash: row.confirmation_hash,
    createdAt: toIsoString(row.created_at),
  };
}

export async function linkSkillSuccessor(
  tx: Queryable,
  deps: ServiceDependencies,
  context: WriteContext,
  scope: SkillQuestionnaireScope,
  questionId: string,
  input: SuccessorLinkInput,
  confirmationHash: string,
  requestId: string,
) {
  async function readReplay() {
    const previous = (
      await tx.query<SuccessorLinkRow & { question_id: string }>(
        `select l.*, o.question_id from skill_question_successor_links l
         join skill_question_resolution_outcomes o on o.resolution_id = l.resolution_id
         where l.actor_id = $1 and l.request_id = $2`,
        [context.personId, requestId],
      )
    ).rows[0];
    if (
      previous &&
      (previous.skill_id !== scope.skillId ||
        previous.version_hash !== scope.versionHash ||
        previous.question_id !== questionId ||
        previous.resolution_id !== input.resolutionId ||
        previous.successor_version_hash !== input.successorVersionHash ||
        previous.confirmation_hash !== confirmationHash)
    )
      throw new RequestError(
        409,
        "This request ID was already used for another successor link",
      );
    return previous;
  }

  const previous = await readReplay();
  if (previous) return { successorLink: toSuccessorLink(previous) };
  const preview = await successorLinkPreview(tx, scope, questionId, input);
  if (preview.confirmationHash !== confirmationHash)
    throw new RequestError(
      409,
      "The successor link inputs changed; review them again",
    );
  const row = (
    await tx.query<SuccessorLinkRow>(
      `insert into skill_question_successor_links
       (id, resolution_id, skill_id, version_hash, successor_version_hash, actor_id, confirmation_hash, request_id, created_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       on conflict (actor_id, request_id) do nothing returning *`,
      [
        deps.ids.next(),
        input.resolutionId,
        scope.skillId,
        scope.versionHash,
        input.successorVersionHash,
        context.personId,
        confirmationHash,
        requestId,
        deps.clock.now(),
      ],
    )
  ).rows[0];
  if (!row) return { successorLink: toSuccessorLink((await readReplay())!) };
  await advanceQuestionnaireRevision(tx, scope, deps, context);
  await recordAudit(tx, deps, {
    actor: { personId: context.personId, credential: context.credential },
    channel: context.channel,
    action: "question.successor_linked",
    target: { type: "question", id: questionId },
    before: {
      revision: preview.resolutionRevision,
      hash: preview.resolutionConfirmationHash,
    },
    after: { revision: preview.resolutionRevision, hash: confirmationHash },
    reason: null,
    requestId: context.requestId,
  });
  return { successorLink: toSuccessorLink(row) };
}
