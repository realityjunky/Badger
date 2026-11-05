import { assemblePrompt, packagedPromptTemplate } from "../prompt-templates.js";
import { publicDraftingJob, type DraftingJobRow } from "./jobs.js";

export function draftingJobPrompt(
  job: DraftingJobRow,
  mode: "dispatch" | "claimed" = "dispatch",
) {
  const template =
    job.context_bundle.promptTemplate ?? packagedPromptTemplate(job.kind);
  const target = publicDraftingJob(job);
  return {
    template,
    prompt: assemblePrompt(
      template,
      {
        jobId: job.id,
        workflowId: job.context_bundle.workflow.id,
        versionId: job.workflow_version_id,
        kind: job.kind,
        revision: job.revision,
        contextHash: job.context_hash,
        roundId: job.round_id,
        skillId: job.skill_id,
        questionId: job.question_id,
        parentQuestionId: job.parent_question_id,
        locale: job.locale,
        workflow: job.context_bundle.workflow,
        outputSchema: job.output_schema,
      },
      mode === "claimed"
        ? "This job is already claimed. Read job.json, context.json, output-schema.json, bounded inputs/ when present and the exact pinned files under skills/. Follow these server instructions to write result.json in the claimed folder, then submit_job with workflowId, versionId, jobId and that folder. Do not claim the job again. Return the dashboard review link."
        : "The user authorizes claiming this exact queued job and submitting suggestions. Use list_jobs to read its current revision. Verify its kind and contextHash, then claim_job with workflowId, versionId, jobId and that revision. Read job.json, context.json, instructions.md, output-schema.json, inputs/ when present, and the supplied pinned files under skills/. Write result.json following the exact output schema and call submit_job with the returned folder. Do not create or claim another job. Return the dashboard review link; a signed-in person decides whether to accept.",
    ),
    job: target,
  };
}
