import { canonicalHash } from "@realityjunky/badger";
import { recordAudit, type WriteContext } from "../audit.js";
import type { Queryable } from "../database/database.js";
import type { ServiceDependencies } from "../dependencies.js";
import { RequestError } from "../http/errors.js";
import {
  readQuestions,
  readRound,
  saveQuestion,
} from "../questionnaire/store.js";
import { toIsoString } from "../util.js";
import { draftingContext } from "./context.js";
import { QUESTION_DRAFT_SCHEMA, validateDraftResult } from "./schema.js";

export type DraftingActor = WriteContext & { agentHost: string | null };
export interface DraftingJobRow {
  id: string;
  workflow_version_id: string;
  kind: "draft-questions" | "draft-follow-ups";
  round_id: string;
  parent_question_id: string | null;
  requester_id: string;
  context_bundle: Awaited<ReturnType<typeof draftingContext>>["bundle"];
  context_hash: string;
  output_schema: object;
  status:
    "queued" | "claimed" | "submitted" | "accepted" | "rejected" | "cancelled";
  revision: number;
  lease_id: string | null;
  lease_person_id: string | null;
  lease_token_id: string | null;
  lease_agent_host: string | null;
  lease_until: string | Date | null;
  result: {
    questions: import("../questionnaire/model.js").QuestionContent[];
  } | null;
  result_hash: string | null;
  decision: unknown;
  created_at: string | Date;
}
export function publicDraftingJob(row: DraftingJobRow) {
  return {
    id: row.id,
    workflowVersionId: row.workflow_version_id,
    kind: row.kind,
    roundId: row.round_id,
    parentQuestionId: row.parent_question_id,
    requesterId: row.requester_id,
    contextHash: row.context_hash,
    outputSchema: row.output_schema,
    revision: row.revision,
    status: row.status,
    lease:
      row.lease_id === null
        ? null
        : {
            id: row.lease_id,
            personId: row.lease_person_id,
            agentHost: row.lease_agent_host,
            until: toIsoString(row.lease_until!),
          },
    result: row.result,
    resultHash: row.result_hash,
    decision: row.decision,
    createdAt: toIsoString(row.created_at),
  };
}

export async function auditJob(
  tx: Queryable,
  deps: ServiceDependencies,
  actor: DraftingActor,
  job: DraftingJobRow,
  action: string,
  before: number | null,
  reason: string | null = null,
) {
  await recordAudit(tx, deps, {
    actor: { personId: actor.personId, credential: actor.credential },
    channel: actor.channel,
    agentHost: actor.agentHost,
    action: `drafting-job.${action}`,
    target: { type: "drafting-job", id: job.id },
    before:
      before === null ? null : { revision: before, hash: job.context_hash },
    after: {
      revision: job.revision,
      hash: job.result_hash ?? job.context_hash,
    },
    reason,
    requestId: actor.requestId,
  });
}

export async function readDraftingJobs(tx: Queryable, versionId: string) {
  return (
    await tx.query<DraftingJobRow>(
      "select * from drafting_jobs where workflow_version_id = $1 order by created_at, id",
      [versionId],
    )
  ).rows;
}

async function finishInbox(
  tx: Queryable,
  deps: ServiceDependencies,
  id: string,
) {
  await tx.query(
    "update inbox_items set state = 'done', revision = revision + 1, updated_at = $2 where drafting_job_id = $1 and state <> 'done'",
    [id, deps.clock.now()],
  );
}

/** Called under the workflow/version locks before reading or changing jobs. */
export async function reconcileDraftingJobs(
  tx: Queryable,
  deps: ServiceDependencies,
  actor: DraftingActor,
  workflowId: string,
  versionId: string,
) {
  const current = await draftingContext(
    tx,
    workflowId,
    versionId,
    actor.personId,
  );
  const jobs = await readDraftingJobs(tx, versionId);
  for (const job of jobs) {
    if (!["queued", "claimed", "submitted"].includes(job.status)) continue;
    const changed = job.context_hash !== current.hash;
    const expired =
      job.status === "claimed" &&
      new Date(job.lease_until!).getTime() <= deps.clock.now().getTime();
    if (!changed && !expired) continue;
    const before = job.revision;
    const updated = (
      await tx.query<DraftingJobRow>(
        `update drafting_jobs set status = $2, revision = revision + 1, lease_id = null, lease_person_id = null,
       lease_token_id = null, lease_agent_host = null, lease_until = null, updated_at = $3 where id = $1 returning *`,
        [job.id, changed ? "cancelled" : "queued", deps.clock.now()],
      )
    ).rows[0]!;
    Object.assign(job, updated);
    if (changed) await finishInbox(tx, deps, job.id);
    await auditJob(
      tx,
      deps,
      actor,
      job,
      changed ? "cancelled" : "lease-expired",
      before,
      changed ? "The job's inputs changed" : "The claim lease expired",
    );
  }
  return { jobs, current };
}

export async function createDraftingJob(
  tx: Queryable,
  deps: ServiceDependencies,
  actor: DraftingActor,
  versionId: string,
  input: {
    kind: DraftingJobRow["kind"];
    roundId: string;
    parentQuestionId: string | null;
  },
  current: Awaited<ReturnType<typeof draftingContext>>,
) {
  const round = await readRound(tx, versionId, input.roundId);
  if (round.state !== "draft")
    throw new RequestError(
      409,
      "Choose a draft round for the suggested questions",
    );
  if (input.parentQuestionId) {
    const parent = (
      await readQuestions(tx, versionId, actor.personId, true)
    ).find((q) => q.id === input.parentQuestionId);
    if (!parent || parent.state === "draft")
      throw new RequestError(
        400,
        "Choose a published parent question in this workflow version",
      );
  }
  const job = (
    await tx.query<DraftingJobRow>(
      `insert into drafting_jobs (id, workflow_version_id, kind, round_id, parent_question_id, requester_id, context_bundle, context_hash, output_schema, created_at, updated_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10) returning *`,
      [
        deps.ids.next(),
        versionId,
        input.kind,
        input.roundId,
        input.parentQuestionId,
        actor.personId,
        JSON.stringify(current.bundle),
        current.hash,
        JSON.stringify(QUESTION_DRAFT_SCHEMA),
        deps.clock.now(),
      ],
    )
  ).rows[0]!;
  await auditJob(tx, deps, actor, job, "queued", null);
  return job;
}

export async function claimDraftingJob(
  tx: Queryable,
  deps: ServiceDependencies,
  actor: DraftingActor,
  job: DraftingJobRow,
) {
  const claimed = (
    await tx.query<DraftingJobRow>(
      `update drafting_jobs set status = 'claimed', revision = revision + 1, lease_id = $2, lease_person_id = $3,
     lease_token_id = $4, lease_agent_host = $5, lease_until = $6, updated_at = $7 where id = $1 returning *`,
      [
        job.id,
        deps.ids.next(),
        actor.personId,
        actor.credential.kind === "token" ? actor.credential.id : null,
        actor.agentHost,
        new Date(deps.clock.now().getTime() + 30 * 60_000),
        deps.clock.now(),
      ],
    )
  ).rows[0]!;
  await auditJob(tx, deps, actor, claimed, "claimed", job.revision);
  return claimed;
}

export function requireLease(
  actor: DraftingActor,
  job: DraftingJobRow,
  leaseId: unknown,
  contextHash: unknown,
) {
  if (
    job.lease_id !== leaseId ||
    job.context_hash !== contextHash ||
    job.lease_person_id !== actor.personId ||
    job.lease_token_id !==
      (actor.credential.kind === "token" ? actor.credential.id : null) ||
    job.lease_agent_host !== actor.agentHost
  )
    throw new RequestError(
      409,
      "Quote your current claim's lease and context hash from the same token and Agent host",
    );
}

export async function submitDraftingJob(
  tx: Queryable,
  deps: ServiceDependencies,
  actor: DraftingActor,
  job: DraftingJobRow,
  result: unknown,
) {
  const validated = validateDraftResult(job.output_schema, result);
  const submitted = (
    await tx.query<DraftingJobRow>(
      `update drafting_jobs set status = 'submitted', revision = revision + 1, result = $2, result_hash = $3,
     lease_id = null, lease_person_id = null, lease_token_id = null, lease_agent_host = null, lease_until = null, updated_at = $4 where id = $1 returning *`,
      [
        job.id,
        JSON.stringify(validated),
        canonicalHash(validated),
        deps.clock.now(),
      ],
    )
  ).rows[0]!;
  await tx.query(
    `insert into inbox_items (id, person_id, workflow_version_id, gate, kind, event_id, drafting_job_id, created_at, updated_at)
     values ($1,$2,$3,'questionnaire','job-submitted',$4,$4,$5,$5)`,
    [
      deps.ids.next(),
      job.requester_id,
      job.workflow_version_id,
      job.id,
      deps.clock.now(),
    ],
  );
  await auditJob(tx, deps, actor, submitted, "submitted", job.revision);
  return submitted;
}

export async function releaseDraftingJob(
  tx: Queryable,
  deps: ServiceDependencies,
  actor: DraftingActor,
  job: DraftingJobRow,
) {
  const released = (
    await tx.query<DraftingJobRow>(
      `update drafting_jobs set status = 'queued', revision = revision + 1, lease_id = null, lease_person_id = null,
     lease_token_id = null, lease_agent_host = null, lease_until = null, updated_at = $2 where id = $1 returning *`,
      [job.id, deps.clock.now()],
    )
  ).rows[0]!;
  await auditJob(tx, deps, actor, released, "released", job.revision);
  return released;
}

export function jobDecisionPreview(
  job: DraftingJobRow,
  action: "accept" | "reject",
  questions?: unknown,
  reason?: unknown,
) {
  const decision =
    action === "accept"
      ? validateDraftResult(job.output_schema, { questions })
      : { reason };
  const bound = {
    jobId: job.id,
    revision: job.revision,
    contextHash: job.context_hash,
    resultHash: job.result_hash,
    action,
    decision,
  };
  return { ...bound, confirmationHash: canonicalHash(bound) };
}

export async function decideDraftingJob(
  tx: Queryable,
  deps: ServiceDependencies,
  actor: DraftingActor,
  job: DraftingJobRow,
  preview: ReturnType<typeof jobDecisionPreview>,
  requestId: string,
  inputHash: string,
) {
  const questionIds: string[] = [];
  if (preview.action === "accept" && "questions" in preview.decision) {
    for (const content of preview.decision.questions) {
      const question = await saveQuestion(
        tx,
        deps,
        actor,
        job.workflow_version_id,
        job.round_id,
        content,
      );
      if (job.parent_question_id)
        await tx.query(
          "update questions set parent_question_id = $2 where id = $1",
          [question.id, job.parent_question_id],
        );
      questionIds.push(question.id);
    }
  }
  const decided = (
    await tx.query<DraftingJobRow>(
      "update drafting_jobs set status = $2, revision = revision + 1, decision = $3, updated_at = $4 where id = $1 returning *",
      [
        job.id,
        preview.action === "accept" ? "accepted" : "rejected",
        JSON.stringify({ ...preview, personId: actor.personId, questionIds }),
        deps.clock.now(),
      ],
    )
  ).rows[0]!;
  await finishInbox(tx, deps, job.id);
  await auditJob(
    tx,
    deps,
    actor,
    decided,
    decided.status,
    job.revision,
    "reason" in preview.decision ? String(preview.decision.reason) : null,
  );
  await tx.query(
    "insert into drafting_job_decisions (person_id, request_id, job_id, input_hash, response) values ($1,$2,$3,$4,$5)",
    [
      actor.personId,
      requestId,
      job.id,
      inputHash,
      JSON.stringify({ job: publicDraftingJob(decided) }),
    ],
  );
  return decided;
}
