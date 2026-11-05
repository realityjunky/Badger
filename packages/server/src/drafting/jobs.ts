import {
  isAuthoringJob,
  validateLaneResult,
  acceptLaneResult,
} from "../authoring.js";
import type { ServiceConfig } from "../config.js";
import { portableAuthoringHistory } from "../authoring-history.js";
import type { AuthoringLaneId } from "@realityjunky/badger";
import {
  canonicalHash,
  composeFactoryPlan,
  factoryPlanDraftSchema,
} from "@realityjunky/badger";
import { storePlan } from "../plans.js";
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
import {
  draftingContext,
  draftingInputHash,
  type DraftingBundle,
  type DraftingTarget,
} from "./context.js";
import {
  DRAFT_SCHEMAS,
  validateDraftResult,
  type DraftingKind,
  type DraftResult,
  type ImportedQuestion,
} from "./schema.js";
import {
  saveStudyRecordInTransaction,
  studyReferences,
} from "../source-study.js";
import type { BlobStore } from "../skills/blobs.js";
import { effectHead, validateEffectDraft } from "../script-effects.js";
import { readVersion } from "../skills/library.js";
import {
  resolutionPreview,
  resolveQuestion,
} from "../questionnaire/resolutions.js";
import { saveTranslation } from "../questionnaire/translations.js";
import {
  refuseImportedAgain,
  saveImportedQuestion,
} from "../questionnaire/imports.js";
import { readPromptTemplate } from "../prompt-templates.js";

export type DraftingActor = WriteContext & { agentHost: string | null };
export interface DraftingJobRow {
  id: string;
  package_id: string | null;
  lane_id: AuthoringLaneId | null;
  workflow_version_id: string;
  kind: DraftingKind;
  round_id: string | null;
  skill_id: string | null;
  question_id: string | null;
  locale: string | null;
  parent_question_id: string | null;
  requester_id: string;
  context_bundle: DraftingBundle;
  context_hash: string;
  input_hash: string;
  output_schema: object;
  status:
    "queued" | "claimed" | "submitted" | "accepted" | "rejected" | "cancelled";
  revision: number;
  lease_id: string | null;
  lease_person_id: string | null;
  lease_token_id: string | null;
  lease_agent_host: string | null;
  lease_until: string | Date | null;
  result: DraftResult | null;
  result_hash: string | null;
  review_result: DraftResult | null;
  review_hash: string | null;
  review_person_id: string | null;
  review_updated_at: string | Date | null;
  review_revision: number;
  decision: unknown;
  created_at: string | Date;
}
export function publicDraftingJob(row: DraftingJobRow) {
  return {
    id: row.id,
    workflowVersionId: row.workflow_version_id,
    kind: row.kind,
    packageId: row.package_id,
    laneId: row.lane_id,
    roundId: row.round_id,
    skillId: row.skill_id,
    questionId: row.question_id,
    locale: row.locale,
    parentQuestionId: row.parent_question_id,
    requesterId: row.requester_id,
    contextHash: row.context_hash,
    promptTemplate: row.context_bundle.promptTemplate
      ? {
          id: row.context_bundle.promptTemplate.id,
          revision: row.context_bundle.promptTemplate.revision,
          hash: row.context_bundle.promptTemplate.hash,
        }
      : null,
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
    review:
      row.review_result === null
        ? null
        : {
            result: row.review_result,
            resultHash: row.review_hash,
            personId: row.review_person_id,
            revision: row.review_revision,
            updatedAt: toIsoString(row.review_updated_at!),
          },
    decision: row.decision,
    createdAt: toIsoString(row.created_at),
  };
}

export function isQuestionnaireDraftingJob(job: DraftingJobRow) {
  return job.kind !== "draft-plan" && !isAuthoringJob(job);
}

export function draftingTarget(job: DraftingJobRow): DraftingTarget {
  return {
    kind: job.kind,
    roundId: job.round_id,
    parentQuestionId: job.parent_question_id,
    skillId: job.skill_id,
    questionId: job.question_id,
    locale: job.locale,
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
      hash: job.review_hash ?? job.result_hash ?? job.context_hash,
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

/**
 * Called under the workflow/version locks before reading or changing jobs.
 * A job is cancelled only when the inputs its kind reads change.
 */
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
    let inputs = current.bundle;
    if (job.kind === "source-study" && job.status === "submitted") {
      const pin = job.context_bundle.pins.find(
        (entry) => entry.skillId === job.skill_id,
      );
      const review = pin ? await effectHead(tx, pin.skillId, pin.hash) : null;
      if (pin && review?.content.sourceJobId === job.id)
        inputs = {
          ...inputs,
          pins: inputs.pins.map((entry) =>
            entry.skillId === pin.skillId && entry.hash === pin.hash
              ? { ...entry, effectRevision: pin.effectRevision }
              : entry,
          ),
        };
    }
    const changed =
      portableAuthoringHistory(job.context_bundle).legacy ||
      (!isAuthoringJob(job) &&
        job.input_hash !== draftingInputHash(inputs, draftingTarget(job)));
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
  input: DraftingTarget,
  current: Awaited<ReturnType<typeof draftingContext>>,
) {
  if (input.kind === "draft-plan" && !current.bundle.planning)
    throw new RequestError(
      409,
      "Approve the current dossier before requesting a plan draft",
    );
  const round = input.roundId
    ? await readRound(tx, versionId, input.roundId)
    : null;
  if (round && round.state !== "draft")
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
  if (
    input.skillId &&
    !current.bundle.pins.some((p) => p.skillId === input.skillId)
  )
    throw new RequestError(
      400,
      "Choose a Skill pinned by this workflow version",
    );
  if (
    input.questionId &&
    !current.bundle.questions.some(
      (q) =>
        q.id === input.questionId &&
        (input.kind !== "restate-answer" ||
          ["answered", "needs-reconfirmation"].includes(q.state)),
    )
  )
    throw new RequestError(
      400,
      "Choose a question in this workflow version; restatements need submitted answers",
    );
  const bundle = {
    ...current.bundle,
    promptTemplate: await readPromptTemplate(tx, input.kind),
  };
  const job = (
    await tx.query<DraftingJobRow>(
      `insert into drafting_jobs (id, workflow_version_id, kind, round_id, parent_question_id, requester_id, context_bundle, context_hash, output_schema, created_at, updated_at, skill_id, question_id, locale, input_hash)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10,$11,$12,$13,$14) returning *`,
      [
        deps.ids.next(),
        versionId,
        input.kind,
        input.roundId,
        input.parentQuestionId,
        actor.personId,
        JSON.stringify(bundle),
        canonicalHash(bundle),
        JSON.stringify(
          input.kind === "draft-plan"
            ? factoryPlanDraftSchema(current.bundle.planning!.input)
            : DRAFT_SCHEMAS[input.kind],
        ),
        deps.clock.now(),
        input.skillId,
        input.questionId,
        input.locale,
        draftingInputHash(current.bundle, input),
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
  blobs: BlobStore,
) {
  const validated = validateDraftResult(
    job.kind,
    job.output_schema,
    result,
    job.context_bundle.pins.find((pin) => pin.skillId === job.skill_id),
  );
  if ("interfaces" in validated && validated.scriptEffects !== undefined) {
    const pin = job.context_bundle.pins.find(
      (entry) => entry.skillId === job.skill_id,
    )!;
    validated.scriptEffects = await validateEffectDraft(
      tx,
      blobs,
      await readVersion(tx, pin.skillId, pin.hash),
      validated.scriptEffects,
    );
  }
  if (isAuthoringJob(job)) validateLaneResult(job, validated);
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
     values ($1,$2,$3,$6,'job-submitted',$4,$4,$5,$5)`,
    [
      deps.ids.next(),
      job.requester_id,
      job.workflow_version_id,
      job.id,
      deps.clock.now(),
      isAuthoringJob(job)
        ? "package"
        : job.kind === "draft-plan"
          ? "plan"
          : "questionnaire",
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

export async function jobDecisionPreview(
  tx: Queryable,
  actor: DraftingActor,
  job: DraftingJobRow,
  action: "accept" | "reject",
  blobs: BlobStore,
  result?: unknown,
  reason?: unknown,
) {
  const decision =
    action === "accept"
      ? validateDraftResult(
          job.kind,
          job.output_schema,
          result,
          job.context_bundle.pins.find((pin) => pin.skillId === job.skill_id),
        )
      : { reason };
  if ("interfaces" in decision && decision.scriptEffects !== undefined) {
    const pin = job.context_bundle.pins.find(
      (entry) => entry.skillId === job.skill_id,
    )!;
    decision.scriptEffects = await validateEffectDraft(
      tx,
      blobs,
      await readVersion(tx, pin.skillId, pin.hash),
      decision.scriptEffects,
    );
  }
  if (action === "accept" && isAuthoringJob(job))
    validateLaneResult(job, decision);
  if (action === "accept" && job.kind === "import-open-questions")
    await refuseImportedAgain(
      tx,
      job.workflow_version_id,
      (decision as { questions: ImportedQuestion[] }).questions,
    );
  if ("plan" in decision) {
    const composition = composeFactoryPlan(
      job.context_bundle.planning!.input,
      decision.plan,
    );
    if (composition.findings.length)
      throw new RequestError(
        409,
        "Repair the kernel's plan findings before accepting",
        { findings: composition.findings },
      );
  }
  const resolution =
    action === "accept" && "facts" in decision && !("interfaces" in decision)
      ? await resolutionPreview(
          tx,
          job.workflow_version_id,
          job.question_id!,
          actor.personId,
          {
            revision: job.context_bundle.questions.find(
              (q) => q.id === job.question_id,
            )!.revision,
            kind: "confirmed",
            facts: decision.facts,
          },
        )
      : null;
  const bound = {
    jobId: job.id,
    revision: job.revision,
    contextHash: job.context_hash,
    resultHash: job.result_hash,
    action,
    decision,
    resolutionConfirmationHash: resolution?.confirmationHash ?? null,
  };
  return { ...bound, confirmationHash: canonicalHash(bound) };
}

export async function decideDraftingJob(
  tx: Queryable,
  deps: ServiceDependencies,
  actor: DraftingActor,
  job: DraftingJobRow,
  preview: Awaited<ReturnType<typeof jobDecisionPreview>>,
  requestId: string,
  inputHash: string,
  blobs: BlobStore,
  config: ServiceConfig,
) {
  const authoringDecision =
    preview.action === "accept" && isAuthoringJob(job)
      ? await acceptLaneResult(tx, config, deps, actor, job, preview.decision)
      : null;
  const questionIds: string[] = [];
  let planVersionId: string | null = null;
  if (preview.action === "accept" && "plan" in preview.decision) {
    const planning = job.context_bundle.planning!;
    const stored = await storePlan(
      tx,
      deps,
      actor,
      composeFactoryPlan(planning.input, preview.decision.plan),
      planning.basePlanVersionId,
    );
    planVersionId = stored.version.id;
  }
  if (preview.action === "accept" && "questions" in preview.decision) {
    for (const content of preview.decision.questions) {
      const question =
        "question" in content
          ? await saveImportedQuestion(
              tx,
              deps,
              actor,
              blobs,
              job.workflow_version_id,
              job.round_id!,
              job.id,
              job.context_bundle.pins.find((p) => p.skillId === job.skill_id)!,
              content,
            )
          : await saveQuestion(
              tx,
              deps,
              actor,
              job.workflow_version_id,
              job.round_id!,
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
  const studyRecordIds: string[] = [];
  if (preview.action === "accept" && "interfaces" in preview.decision) {
    for (const [kind, contents] of [
      ["fact", preview.decision.facts],
      ["interface", preview.decision.interfaces],
    ] as const) {
      for (const content of contents) {
        if (
          !studyReferences(content).some((ref) => ref.skillId === job.skill_id)
        )
          throw new RequestError(
            400,
            "Study results must reference the job's pinned Skill",
          );
        const record = await saveStudyRecordInTransaction(
          tx,
          deps,
          actor,
          blobs,
          job.workflow_version_id,
          kind,
          { content },
        );
        studyRecordIds.push(record.id);
      }
    }
  }
  let resolutionId: string | null = null;
  if (
    preview.action === "accept" &&
    "facts" in preview.decision &&
    !("interfaces" in preview.decision)
  ) {
    const result = await resolveQuestion(
      tx,
      deps,
      actor,
      job.workflow_version_id,
      job.question_id!,
      {
        revision: job.context_bundle.questions.find(
          (q) => q.id === job.question_id,
        )!.revision,
        kind: "confirmed",
        facts: preview.decision.facts,
      },
      preview.resolutionConfirmationHash!,
      `drafting-job:${job.id}`,
    );
    resolutionId = result.resolution.id;
  }
  const translationId =
    preview.action === "accept" && "text" in preview.decision
      ? await saveTranslation(tx, deps, actor, {
          questionId: job.question_id!,
          questionRevision: job.context_bundle.questions.find(
            (q) => q.id === job.question_id,
          )!.revision,
          locale: job.locale!,
          ...preview.decision,
          jobId: job.id,
        })
      : null;
  const decided = (
    await tx.query<DraftingJobRow>(
      "update drafting_jobs set status = $2, revision = revision + 1, decision = $3, updated_at = $4 where id = $1 returning *",
      [
        job.id,
        preview.action === "accept" ? "accepted" : "rejected",
        JSON.stringify({
          ...preview,
          ...(authoringDecision ?? {}),
          personId: actor.personId,
          questionIds,
          ...(planVersionId ? { planVersionId } : {}),
          studyRecordIds,
          resolutionId,
          translationId,
        }),
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
