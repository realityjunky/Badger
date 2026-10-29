import { createHash } from "node:crypto";
import { canonicalHash } from "@realityjunky/badger";
import {
  auditJob,
  claimDraftingJob,
  createDraftingJob,
  decideDraftingJob,
  jobDecisionPreview,
  publicDraftingJob,
  reconcileDraftingJobs,
  releaseDraftingJob,
  requireLease,
  submitDraftingJob,
  type DraftingActor,
} from "../drafting/jobs.js";
import { readVersion } from "../skills/library.js";
import { firstHeader } from "../identity/identity.js";
import { questionnaireCapabilities } from "../questionnaire/access.js";
import { fields, revisionInput, textInput } from "../questionnaire/model.js";
import { workflowCapabilities } from "../workflow-access.js";
import { readWorkflow, listWorkflowVersions } from "../workflows.js";
import type { AuthorizedRequest } from "./authorized-request.js";
import { readJsonBody } from "./body.js";
import { RequestError, objectInput } from "./errors.js";

const PATH =
  /^\/api\/v1\/workflows\/([^/]+)\/versions\/([^/]+)\/drafting-jobs(?:\/([^/]+)(?:\/(claim|submit|release|accept-preview|accept|reject-preview|reject))?)?$/u;
export function draftingJobMethods(path: string): string | null {
  const match = PATH.exec(path);
  if (!match) return null;
  return match[4] ? "POST" : match[3] ? "GET, HEAD" : "GET, HEAD, POST";
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
  const host = firstHeader(request.headers, "x-badger-agent-host");
  if (
    context.channel === "mcp" &&
    (typeof host !== "string" ||
      !/^[\x20-\x7e]{1,200}$/u.test(host) ||
      !host.trim())
  )
    throw new RequestError(400, "Supply a printable Agent host label");
  const actor: DraftingActor = {
    ...context,
    agentHost: context.channel === "mcp" ? host! : null,
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
      await tx.query("select id from people where id = $1 for update", [
        person.id,
      ]);
    await tx.query("select id from workflows where id = $1 for update", [
      workflowId,
    ]);
    await tx.query(
      "select id from workflow_versions where id = $1 and workflow_id = $2 for update",
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
    if (
      !(await workflowCapabilities(tx, access, person, workflow)).read ||
      !(await questionnaireCapabilities(tx, access, person, workflowId)).compose
    )
      throw new RequestError(
        403,
        "Only this workflow's Engineer manages drafting jobs",
      );
    const { jobs, current } = await reconcileDraftingJobs(
      tx,
      deps,
      actor,
      workflowId,
      versionId,
    );
    if (!id) {
      if (method !== "POST") {
        for (const job of jobs)
          await auditJob(tx, deps, actor, job, "listed", null);
        return { status: 200, value: { jobs: jobs.map(publicDraftingJob) } };
      }
      fields(body, ["kind", "roundId", "parentQuestionId", "confirmed"]);
      if (context.credential.kind === "token" || body.confirmed !== true)
        throw new RequestError(
          403,
          "A signed-in Engineer requests and confirms drafting",
        );
      if (body.kind !== "draft-questions" && body.kind !== "draft-follow-ups")
        throw new RequestError(
          400,
          "Choose draft-questions or draft-follow-ups",
        );
      const parentQuestionId =
        body.kind === "draft-follow-ups"
          ? textInput(body.parentQuestionId, "parentQuestionId", 200)
          : null;
      if (
        body.kind === "draft-questions" &&
        body.parentQuestionId !== undefined
      )
        throw new RequestError(400, "Only follow-ups name a parent question");
      const job = await createDraftingJob(
        tx,
        deps,
        actor,
        versionId,
        {
          kind: body.kind,
          roundId: textInput(body.roundId, "roundId", 200),
          parentQuestionId,
        },
        current,
      );
      return { status: 201, value: { job: publicDraftingJob(job) } };
    }
    const job = jobs.find((j) => j.id === id);
    if (!job)
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
    if (action === "claim") {
      fields(body, ["revision"]);
      if (
        job.status !== "queued" ||
        revisionInput(body.revision) !== job.revision
      )
        return conflict("Read the current queued job before claiming");
      const claimed = await claimDraftingJob(tx, deps, actor, job);
      const files = [];
      let bytes = 0;
      for (const pin of job.context_bundle.pins) {
        const version = await readVersion(tx, pin.skillId, pin.hash);
        for (const file of version.inventory) {
          bytes += file.bytes;
          if (bytes > 32 * 1024 * 1024)
            throw new RequestError(
              400,
              "The pinned Skill bundle exceeds 32 MiB",
            );
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
          job: publicDraftingJob(claimed),
          contextBundle: job.context_bundle,
          files,
        },
      };
    }
    if (action === "submit" || action === "release") {
      fields(body, [
        "leaseId",
        "contextHash",
        ...(action === "submit" ? ["result"] : []),
      ]);
      if (job.status !== "claimed")
        return conflict("This lease expired or the job is no longer claimed");
      requireLease(actor, job, body.leaseId, body.contextHash);
      const updated =
        action === "submit"
          ? await submitDraftingJob(tx, deps, actor, job, body.result)
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
      accept ? "questions" : "reason",
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
    const preview = jobDecisionPreview(
      job,
      accept ? "accept" : "reject",
      body.questions,
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
    );
    return { status: 200, value: { job: publicDraftingJob(decided) } };
  });
  reply.json(result.status, result.value);
}
