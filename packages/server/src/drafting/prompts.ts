import { assemblePrompt, packagedPromptTemplate } from "../prompt-templates.js";
import { draftingLanguageInstructions } from "@realityjunky/badger/prompts";
import { publicDraftingJob, type DraftingJobRow } from "./jobs.js";
import { RequestError } from "../http/errors.js";

export function draftingJobPrompt(
  job: DraftingJobRow,
  mode: "dispatch" | "claimed" = "dispatch",
) {
  const template =
    job.context_bundle.promptTemplate ?? packagedPromptTemplate(job.kind);
  const target = publicDraftingJob(job);
  const outputLocale = target.outputLocale;
  if (outputLocale === null)
    throw new RequestError(
      409,
      "The job has no bound output locale; request a current draft",
    );
  if (mode === "dispatch")
    return {
      template,
      prompt: [
        `${job.status === "submitted" ? "Continue editing this" : "Process this queued"} Badger ${job.kind} job using the connected Badger MCP.`,
        `Call claim_job with these arguments:\n${JSON.stringify({
          workflowId: job.context_bundle.workflow.id,
          versionId: job.workflow_version_id,
          jobId: job.id,
          revision: job.revision,
        })}`,
        `Expected context hash: ${job.context_hash}.`,
        `Output locale: ${JSON.stringify(outputLocale)}. Use this language for drafted narrative text.`,
        "Read the returned instructions.md first, then job.json, context.json, output-schema.json, inputs/ when present, and pinned files under skills/. Follow those server instructions to write result.json in the claimed folder and call submit_job with workflowId, versionId, jobId and that folder.",
        "submit_job saves suggestions and keeps this MCP session's exclusive claim for follow-up changes. Existing suggestions, including saved dashboard edits, arrive in result.json. Edit that file and submit again as needed. Call finish_job only when the person says this drafting session is finished; do not finish automatically after a submission. The dashboard and other Agents can edit or claim the job after the session finishes. The MCP renews the claim while connected and releases it on disconnect.",
        "If the job changed or cannot be claimed, stop and report it. Do not create or claim another job. Return the dashboard link. Only people accept or discard suggestions in the dashboard.",
      ].join("\n\n"),
      job: target,
    };
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
        outputLocale,
        workflow: job.context_bundle.workflow,
        outputSchema: job.output_schema,
      },
      [
        draftingLanguageInstructions(outputLocale),
        "Current drafting-session rules supersede older suggestion-editing or completion wording in this template snapshot. Saving suggestions does not finish the session. Edits within this session's exclusive claim are authorized drafting; accepting or discarding remains a person's separate dashboard decision.",
        "This job is already claimed. Read job.json, context.json, output-schema.json, bounded inputs/ when present and the exact pinned files under skills/. Follow these server instructions to write result.json in the claimed folder, then submit_job with workflowId, versionId, jobId and that folder. Existing suggestions, including saved dashboard edits, arrive in result.json. Keep the exclusive claim for follow-up changes; edit that file and submit again as needed. Do not claim the job again or finish automatically after submitting. Call finish_job only when the person says this drafting session is finished. The MCP renews the claim while connected and releases it on disconnect. Return the dashboard link. Only people accept or discard suggestions.",
      ].join("\n\n"),
    ),
    job: target,
  };
}
