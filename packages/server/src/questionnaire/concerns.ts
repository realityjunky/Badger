import { canonicalHash } from "@realityjunky/badger";
import { recordAudit, type WriteContext } from "../audit.js";
import type { Queryable } from "../database/database.js";
import type { ServiceDependencies } from "../dependencies.js";
import { notifyWorkflowRoles } from "../inbox.js";
import { RequestError } from "../http/errors.js";
import { toIsoString } from "../util.js";
import type { Concern, ConcernDecision, ConcernOutcome } from "./model.js";
import {
  advanceQuestionnaireRevision,
  recordQuestionnaireAudit,
  readRound,
  saveQuestion,
  toRound,
} from "./store.js";

export async function readConcerns(
  tx: Queryable,
  versionId: string,
): Promise<Concern[]> {
  const rows = await tx.query<{
    id: string;
    person_id: string;
    display_name: string;
    text: string;
    created_at: Date | string;
    outcome: ConcernOutcome | null;
    reason: string | null;
    question_id: string | null;
    actor_id: string | null;
    resolved_at: Date | string | null;
  }>(
    `select c.*, p.display_name, r.outcome, r.reason, r.question_id, r.actor_id, r.created_at as resolved_at
    from questionnaire_concerns c join people p on p.id = c.person_id
    left join concern_resolutions r on r.concern_id = c.id
    where c.workflow_version_id = $1 order by c.created_at, c.id`,
    [versionId],
  );
  return rows.rows.map((row) => ({
    id: row.id,
    personId: row.person_id,
    personName: row.display_name,
    text: row.text,
    createdAt: toIsoString(row.created_at),
    revision: row.outcome === null ? 1 : 2,
    state: row.outcome ?? "open",
    resolution:
      row.outcome === null
        ? null
        : {
            outcome: row.outcome,
            reason: row.reason,
            questionId: row.question_id,
            actorId: row.actor_id!,
            createdAt: toIsoString(row.resolved_at!),
          },
  }));
}

export async function raiseConcern(
  tx: Queryable,
  deps: ServiceDependencies,
  context: WriteContext,
  versionId: string,
  text: string,
) {
  const id = deps.ids.next();
  await tx.query(
    "insert into questionnaire_concerns (id, workflow_version_id, person_id, text, created_at) values ($1, $2, $3, $4, $5)",
    [id, versionId, context.personId, text, deps.clock.now()],
  );
  await notifyWorkflowRoles(
    tx,
    deps,
    versionId,
    "questionnaire",
    "concern-raised",
    id,
    ["Engineer"],
    id,
  );
  await advanceQuestionnaireRevision(tx, versionId, deps, context);
  await recordQuestionnaireAudit(
    tx,
    deps,
    context,
    "concern.raised",
    "concern",
    id,
    1,
    null,
  );
  return (await readConcerns(tx, versionId)).find((c) => c.id === id)!;
}

export async function concernResolutionPreview(
  tx: Queryable,
  versionId: string,
  id: string,
  decision: ConcernDecision,
) {
  const concern = (await readConcerns(tx, versionId)).find((c) => c.id === id);
  if (!concern)
    throw new RequestError(404, "No such concern in this workflow version");
  if (concern.state !== "open" || concern.revision !== decision.revision)
    throw new RequestError(
      409,
      "This concern has already been resolved or changed",
    );
  const round =
    decision.outcome === "question"
      ? await readRound(tx, versionId, decision.roundId)
      : null;
  if (round && round.state !== "draft")
    throw new RequestError(
      409,
      "Turn the concern into a question in a draft round",
    );
  return {
    concern,
    decision,
    confirmationHash: canonicalHash({
      versionId,
      concern,
      decision,
      round: round === null ? null : toRound(round),
    }),
  };
}

/** One transaction creates the outcome, its question if any, audit, and inbox closure. */
export async function resolveConcern(
  tx: Queryable,
  deps: ServiceDependencies,
  context: WriteContext,
  versionId: string,
  id: string,
  decision: ConcernDecision,
  confirmationHash: string,
) {
  const preview = await concernResolutionPreview(tx, versionId, id, decision);
  if (preview.confirmationHash !== confirmationHash)
    throw new RequestError(
      409,
      "The concern resolution changed; review it again",
    );
  const question =
    decision.outcome === "question"
      ? await saveQuestion(
          tx,
          deps,
          context,
          versionId,
          decision.roundId,
          decision.question,
        )
      : null;
  const reason = decision.outcome === "declined" ? decision.reason : null;
  await tx.query(
    `insert into concern_resolutions (concern_id, outcome, reason, question_id, actor_id, confirmation_hash, created_at)
    values ($1, $2, $3, $4, $5, $6, $7)`,
    [
      id,
      decision.outcome,
      reason,
      question?.id ?? null,
      context.personId,
      confirmationHash,
      deps.clock.now(),
    ],
  );
  await tx.query(
    "update inbox_items set state = 'done', revision = revision + 1, updated_at = $2 where concern_id = $1 and state <> 'done'",
    [id, deps.clock.now()],
  );
  await advanceQuestionnaireRevision(tx, versionId, deps, context);
  const concern = (await readConcerns(tx, versionId)).find((c) => c.id === id)!;
  await recordAudit(tx, deps, {
    actor: { personId: context.personId, credential: context.credential },
    channel: context.channel,
    action: "concern.resolved",
    target: { type: "concern", id },
    before: { revision: 1, hash: canonicalHash(preview.concern) },
    after: { revision: 2, hash: canonicalHash(concern) },
    reason,
    requestId: context.requestId,
  });
  return { concern, question };
}
