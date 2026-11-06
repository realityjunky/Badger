import { isAuthoringJob, reconcileAuthoringJobs } from "../authoring.js";
import { portableAuthoringHistory } from "../authoring-history.js";
import { createHash } from "node:crypto";
import { canonicalHash } from "@realityjunky/badger";
import {
  auditJob,
  claimDraftingJob,
  createDraftingJob,
  decideDraftingJob,
  draftingTarget,
  finishDraftingJob,
  isQuestionnaireDraftingJob,
  jobDecisionPreview,
  publicDraftingJob,
  reconcileDraftingJobs,
  releaseDraftingJob,
  renewDraftingJob,
  requireLease,
  submitDraftingJob,
  type DraftingActor,
} from "../drafting/jobs.js";
import { saveDraftingReview } from "../drafting/reviews.js";
import { draftingSkills } from "../drafting/context.js";
import { draftingJobPrompt } from "../drafting/prompts.js";
import { readVersion } from "../skills/library.js";
import { questionnaireCapabilities } from "../questionnaire/access.js";
import { fields, revisionInput, textInput } from "../questionnaire/model.js";
import { workflowCapabilities } from "../workflow-access.js";
import { readWorkflow, listWorkflowVersions } from "../workflows.js";
import type { AuthorizedRequest } from "./authorized-request.js";
import { readJsonBody } from "./body.js";
import { RequestError, objectInput } from "./errors.js";
import {
  DRAFT_SCHEMAS,
  draftResultFields,
  type DraftingKind,
} from "../drafting/schema.js";

const PATH =
  /^\/api\/v1\/workflows\/([^/]+)\/versions\/([^/]+)\/drafting-jobs(?:\/([^/]+)(?:\/(prompt|claim|submit|finish|renew|release|review|accept-preview|accept|reject-preview|reject))?)?$/u;
const REQUEST_FIELDS: Record<DraftingKind, string[]> = {
  "draft-questions": ["roundId"],
  "draft-follow-ups": ["roundId", "parentQuestionId"],
  "source-study": ["skillId"],
  "restate-answer": ["questionId"],
  "translate-question": ["questionId", "locale"],
  "import-open-questions": ["roundId", "skillId"],
  "draft-plan": [],
  "authoring-lane": [],
  "review-vote": [],
};
export function draftingJobMethods(path: string): string | null {
  const match = PATH.exec(path);
  if (!match) return null;
  return match[4] && match[4] !== "prompt"
    ? "POST"
    : match[3]
      ? "GET, HEAD"
      : "GET, HEAD, POST";
}

export async function handleDraftingJobs(input: AuthorizedRequest) {
  const {
    database,
    dependencies: deps,
    context,
    access,
    person,
    request,
    reply,
    method,
  } = input;
  const [, rawWorkflow, rawVersion, rawId, action] = PATH.exec(input.path)!;
  const workflowId = decodeURIComponent(rawWorkflow!);
  const versionId = decodeURIComponent(rawVersion!);
  const id = rawId ? decodeURIComponent(rawId) : null;
  if (action === "review" && context.credential.kind === "token")
    throw new RequestError(
      403,
      "Only signed-in people review and edit suggestions in the dashboard",
    );
  // The service refuses a token request without a valid Agent host.
  const actor: DraftingActor = {
    ...context,
    agentHost:
      context.credential.kind === "token"
        ? (context.credential.agentHost ?? null)
        : null,
  };
  let body: Record<string, unknown> = {};
  if (method === "POST") {
    const parsed = await readJsonBody(request, 1024 * 1024 + 16384);
    if (!parsed.ok)
      throw new RequestError(parsed.status ?? 400, parsed.message);
    body = objectInput(parsed.value);
  }
  // Serialize this person's replay keys before workflow locks, including
  // requests targeting different workflow versions on separate connections.
  const decisionCommit = action === "accept" || action === "reject";
  const result = await database.transaction(async (tx) => {
    if (decisionCommit)
      // FK checks in workflow-first writers take KEY SHARE on this row.
      // NO KEY UPDATE serializes replay keys without blocking those checks.
      await tx.query("select id from people where id = $1 for no key update", [
        person.id,
      ]);
    await tx.query("select id from workflows where id = $1 for no key update", [
      workflowId,
    ]);
    await tx.query(
      "select id from workflow_versions where id = $1 and workflow_id = $2 for no key update",
      [versionId, workflowId],
    );
    const workflow = await readWorkflow(tx, workflowId);
    if (
      !workflow ||
      !(await listWorkflowVersions(tx, workflowId)).some(
        (v) => v.id === versionId,
      )
    )
      throw new RequestError(404, "No such workflow version");
    const capabilities = await questionnaireCapabilities(
      tx,
      access,
      person,
      workflowId,
    );
    if (
      !(await workflowCapabilities(tx, access, person, workflow)).read ||
      !(capabilities.compose || capabilities.reviewSuggestions)
    )
      throw new RequestError(
        403,
        "Only this workflow's Engineer and Field experts review drafting suggestions",
      );
    if (
      (action === "review" && !capabilities.reviewSuggestions) ||
      (((action && action !== "review") || (!id && method === "POST")) &&
        !capabilities.compose)
    )
      throw new RequestError(
        403,
        "Only this workflow's Engineer manages drafting jobs and decisions",
      );
    const { jobs, current } = await reconcileDraftingJobs(
      tx,
      deps,
      actor,
      workflowId,
      versionId,
    );
    if (capabilities.compose)
      await reconcileAuthoringJobs(
        tx,
        input.config,
        deps,
        actor,
        versionId,
        jobs,
      );
    if (!id) {
      if (method !== "POST") {
        const visible = capabilities.compose
          ? jobs
          : jobs.filter(isQuestionnaireDraftingJob);
        for (const job of visible)
          await auditJob(tx, deps, actor, job, "listed", null);
        return { status: 200, value: { jobs: visible.map(publicDraftingJob) } };
      }
      if (context.credential.kind === "token" || body.confirmed !== true)
        throw new RequestError(
          403,
          "A signed-in Engineer requests and confirms drafting",
        );
      if (
        typeof body.kind !== "string" ||
        (body.kind !== "draft-plan" && !Object.hasOwn(DRAFT_SCHEMAS, body.kind))
      )
        throw new RequestError(400, "Choose a supported drafting job kind");
      if (body.kind === "authoring-lane" || body.kind === "review-vote")
        throw new RequestError(
          400,
          "Request Authoring lanes from the Package stage",
        );
      fields(body, [
        "kind",
        "confirmed",
        ...REQUEST_FIELDS[body.kind as DraftingKind],
      ]);
      const parentQuestionId =
        body.kind === "draft-follow-ups"
          ? textInput(body.parentQuestionId, "parentQuestionId", 200)
          : null;
      if (
        body.kind !== "draft-follow-ups" &&
        body.parentQuestionId !== undefined
      )
        throw new RequestError(400, "Only follow-ups name a parent question");
      let locale: string | null = null;
      if (body.kind === "translate-question") {
        try {
          locale =
            Intl.getCanonicalLocales(
              textInput(body.locale, "locale", 100),
            )[0] ?? null;
        } catch {
          throw new RequestError(
            400,
            "Choose a valid translation language tag, such as en or zh-CN",
          );
        }
      }
      const job = await createDraftingJob(
        tx,
        deps,
        actor,
        versionId,
        {
          kind: body.kind as DraftingKind,
          roundId: [
            "draft-questions",
            "draft-follow-ups",
            "import-open-questions",
          ].includes(body.kind)
            ? textInput(body.roundId, "roundId", 200)
            : null,
          parentQuestionId,
          skillId: ["source-study", "import-open-questions"].includes(body.kind)
            ? textInput(body.skillId, "skillId", 200)
            : null,
          questionId: ["restate-answer", "translate-question"].includes(
            body.kind,
          )
            ? textInput(body.questionId, "questionId", 200)
            : null,
          locale,
        },
        current,
      );
      return { status: 201, value: { job: publicDraftingJob(job) } };
    }
    const job = jobs.find((j) => j.id === id);
    if (!job || (!capabilities.compose && !isQuestionnaireDraftingJob(job)))
      throw new RequestError(
        404,
        "No such drafting job in this workflow version",
      );
    if (!action) {
      await auditJob(tx, deps, actor, job, "viewed", null);
      return { status: 200, value: { job: publicDraftingJob(job) } };
    }
    // Return conflicts after committing reconciliation, so cancellation and
    // expiry survive the very request that discovers stale inputs or leases.
    const conflict = (message: string) => ({
      status: 409,
      value: {
        error: { code: "conflict", message },
        job: publicDraftingJob(job),
      },
    });
    if (job.status === "cancelled")
      return conflict("The job's inputs changed; request a new job");
    if (action === "prompt") {
      if (!["queued", "submitted"].includes(job.status))
        return conflict(
          "Only queued jobs or unclaimed suggestions can be dispatched to an Agent",
        );
      return { status: 200, value: draftingJobPrompt(job) };
    }
    if (action === "review") {
      if (!isQuestionnaireDraftingJob(job))
        throw new RequestError(
          400,
          "Review edits are for questionnaire suggestions",
        );
      fields(body, ["revision", "result"]);
      if (job.status !== "submitted")
        return conflict("Only submitted suggestions can be edited");
      if (revisionInput(body.revision) !== job.revision)
        return conflict(
          "The suggestions changed. Reopen the review before saving your edits.",
        );
      const saved = await saveDraftingReview(
        tx,
        deps,
        actor,
        job,
        body.result,
        input.blobs,
      );
      return { status: 200, value: { job: publicDraftingJob(saved) } };
    }
    if (action === "claim") {
      fields(body, ["revision"]);
      if (
        !["queued", "submitted"].includes(job.status) ||
        revisionInput(body.revision) !== job.revision
      )
        return conflict(
          "Read the current queued job or unclaimed suggestions before claiming",
        );
      if (isAuthoringJob(job) && !job.context_bundle.authoring)
        throw new RequestError(409, "The Authoring job has no bounded inputs");
      // Only the Skills this kind reads travel. Any two Skill versions within
      // the upload limit fit, such as a producer and its consumer.
      const skills = draftingSkills(job.context_bundle, draftingTarget(job));
      const versions = [];
      let bytes = 0;
      for (const pin of skills) {
        const version = await readVersion(tx, pin.skillId, pin.hash);
        for (const file of version.inventory) bytes += file.bytes;
        versions.push({ pin, version });
      }
      if (bytes > 2 * input.config.uploads.maxBytes)
        throw new RequestError(
          413,
          "The pinned Skill files this job reads exceed the claim byte limit",
        );
      const claimed = await claimDraftingJob(tx, deps, actor, job);
      const files = [];
      for (const { pin, version } of versions) {
        for (const file of version.inventory) {
          const content = await input.blobs.get(file.hash);
          if (createHash("sha256").update(content).digest("hex") !== file.hash)
            throw new Error("Pinned Skill integrity check failed");
          files.push({
            skillId: pin.skillId,
            versionHash: pin.hash,
            path: file.path,
            hash: file.hash,
            contentBase64: content.toString("base64"),
          });
        }
      }
      return {
        status: 200,
        value: {
          job: {
            ...publicDraftingJob(claimed),
            lease: {
              ...publicDraftingJob(claimed).lease,
              id: claimed.lease_id!,
            },
          },
          contextBundle: job.context_bundle,
          skills: skills.map((pin) => ({
            skillId: pin.skillId,
            versionHash: pin.hash,
          })),
          files,
          instructions: draftingJobPrompt(claimed, "claimed").prompt,
        },
      };
    }
    if (["submit", "finish", "renew", "release"].includes(action)) {
      fields(body, [
        "leaseId",
        "contextHash",
        "revision",
        ...(action === "submit" ? ["result", "keepClaim"] : []),
      ]);
      if (job.status !== "claimed")
        return conflict("This lease expired or the job is no longer claimed");
      requireLease(actor, job, body.leaseId, body.contextHash);
      if (
        body.revision !== undefined &&
        revisionInput(body.revision) !== job.revision
      )
        return conflict(
          "The suggestions changed; read the current job before saving",
        );
      if (body.keepClaim !== undefined && typeof body.keepClaim !== "boolean")
        throw new RequestError(400, "keepClaim must be a boolean");
      const updated =
        action === "submit"
          ? await submitDraftingJob(
              tx,
              deps,
              actor,
              job,
              body.result,
              input.blobs,
              body.keepClaim === true,
            )
          : action === "finish"
            ? await finishDraftingJob(tx, deps, actor, job)
            : action === "renew"
              ? await renewDraftingJob(tx, deps, job)
              : await releaseDraftingJob(tx, deps, actor, job);
      return { status: 200, value: { job: publicDraftingJob(updated) } };
    }
    if (context.credential.kind === "token")
      throw new RequestError(
        403,
        "Only a signed-in person accepts or discards suggestions",
      );
    const accept = action.startsWith("accept");
    fields(body, [
      "revision",
      ...(accept ? draftResultFields(job.kind) : ["reason"]),
      "confirmationHash",
      "confirmed",
      "requestId",
    ]);
    const requestId = decisionCommit
      ? textInput(body.requestId, "requestId", 200)
      : null;
    const inputHash = canonicalHash({
      workflowId,
      versionId,
      jobId: job.id,
      action,
      body,
    });
    if (requestId) {
      const previous = (
        await tx.query<{
          job_id: string;
          input_hash: string;
          response: object;
        }>(
          "select job_id, input_hash, response from drafting_job_decisions where person_id = $1 and request_id = $2",
          [person.id, requestId],
        )
      ).rows[0];
      if (previous) {
        if (previous.job_id !== job.id || previous.input_hash !== inputHash)
          return conflict(
            "This request ID already confirmed a different drafting decision",
          );
        return { status: 200, value: previous.response };
      }
    }
    if (job.status !== "submitted")
      return conflict("Only submitted suggestions can be reviewed");
    if (revisionInput(body.revision) !== job.revision)
      return conflict("The job changed; review it again");
    if (
      accept &&
      job.kind !== "draft-plan" &&
      job.review_hash !== null &&
      canonicalHash(
        Object.fromEntries(
          draftResultFields(job.kind)
            .filter((key) => body[key] !== undefined)
            .map((key) => [key, body[key]]),
        ),
      ) !== job.review_hash
    )
      return conflict(
        "The saved review changed. Open Review decisions again to use the saved edits.",
      );
    const preview = await jobDecisionPreview(
      tx,
      actor,
      job,
      accept ? "accept" : "reject",
      input.blobs,
      Object.fromEntries(
        draftResultFields(job.kind).map((key) => [key, body[key]]),
      ),
      accept ? undefined : textInput(body.reason, "reason"),
    );
    if (action.endsWith("-preview")) {
      await auditJob(tx, deps, actor, job, "previewed", null);
      return { status: 200, value: { preview } };
    }
    if (body.confirmed !== true)
      throw new RequestError(400, "Confirm the reviewed suggestions");
    if (body.confirmationHash !== preview.confirmationHash)
      return conflict("The reviewed suggestions changed; preview them again");
    const decided = await decideDraftingJob(
      tx,
      deps,
      actor,
      job,
      preview,
      requestId!,
      inputHash,
      input.blobs,
      input.config,
    );
    return { status: 200, value: { job: publicDraftingJob(decided) } };
  });
  reply.json(result.status, portableAuthoringHistory(result.value).snapshot);
}
