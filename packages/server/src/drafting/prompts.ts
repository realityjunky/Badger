import { assemblePrompt, packagedPromptTemplate } from "../prompt-templates.js";
import {
  authoringContentScaffold,
  planRepairItems,
} from "@realityjunky/badger";
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
  const planRepair = job.context_bundle.planRepair;
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
        ...(planRepair
          ? [
              `Prepare one Plan repair for the ${planRepair.wave} reports from ${planRepair.reports.map((report) => report.lane).join(", ")}. Resolve overlaps and account for every finding for the Engineer's review.`,
            ]
          : []),
        `Call claim_job with these arguments:\n${JSON.stringify({
          workflowId: job.context_bundle.workflow.id,
          versionId: job.workflow_version_id,
          jobId: job.id,
          revision: job.revision,
        })}`,
        `Expected context hash: ${job.context_hash}.`,
        "Before claiming, confirm finish_job is available. If missing, update/build and restart the local Badger MCP; stop until it is available.",
        `Output locale: ${JSON.stringify(outputLocale)}. Use this language for drafted narrative text.`,
        "Read the returned instructions.md first, then job.json, context.json, output-schema.json, inputs/ when present, and pinned files under skills/. Follow those server instructions to write result.json in the claimed folder and call submit_job with workflowId, versionId, jobId and that folder.",
        "submit_job keeps this session's claim for further drafting. Existing saved edits arrive in result.json.",
        "Verify that savedDraft.resultHash matches job.currentResultHash and check the saved content at job.currentResultPath. job.result and job.resultHash preserve the first submission.",
        "After saving the final draft, call finish_job with the same workflowId, versionId, jobId and folder once you have verified the save. I authorize this handoff for the final draft, including a valid draft that reports blockers. Keep the claim open if I ask for more edits before handoff. Confirm the job is submitted after finishing.",
        "If the job changed or cannot be claimed, stop and report it. Do not create or claim another job. Return the dashboard link. Only people accept or discard suggestions in the dashboard.",
      ].join("\n\n"),
      job: target,
    };
  const authoring = job.context_bundle.authoring;
  const followUp = job.context_bundle.authoringFollowUp;
  const lane = authoring?.plan.lanes.find(({ id }) => id === job.lane_id);
  const scaffolds =
    lane?.contentLeaves.flatMap((artifactPath) => {
      const markdown = authoringContentScaffold(artifactPath);
      return markdown
        ? [`### \`${artifactPath}\`\n\n\`\`\`markdown\n${markdown}\n\`\`\``]
        : [];
    }) ?? [];
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
        ...(job.context_bundle.findingWork
          ? [
              "Read findingWork in context.json for the assignment, governing requirement, original observations and acceptance example. Each observation's evidenceFiles maps its original citations to files under inputs/history/. Use the output schema for this job.",
              ...(job.kind === "implement-finding"
                ? [
                    "Edit the assigned copy in the private job folder. Package sources are under package/ and pinned Skills are under skills/. Return only the approved package-relative or Skill-relative file changes, with previousHash (null for creation) and complete UTF-8 content (null for deletion). Include the fixture and observed test results. File changes to Badger belong in a separate platform defect report.",
                  ]
                : []),
              ...(job.kind === "verify-finding"
                ? [
                    "The package/ folder contains the verified candidate bytes. Exercise each acceptance example on the dispatched subjectHash. Record the actual fixture, environment, tool versions and evidence. Return the configured verifier's signed receipt when the assignment requires one.",
                  ]
                : []),
              ...(job.repair_feedback
                ? [
                    "Respond to the Engineer's feedback: " +
                      job.repair_feedback.reason,
                  ]
                : []),
            ]
          : []),
        "Current drafting-session rules supersede older suggestion-editing or completion wording in this template snapshot. Saving suggestions keeps the session open. The person's copied dispatch prompt can authorize finish_job after the final verified save. If the person has authorized only drafting, wait for their instruction to finish. Only people accept or discard suggestions in the dashboard.",
        "Your MCP must expose finish_job for an iterative drafting session. If it is missing, release_job preserves the saved suggestions while ending this claim; update/build the local Badger MCP and restart its connection before reclaiming. After each submit, verify savedDraft.resultHash and job.currentResultHash, and follow job.currentResultPath to the latest content. job.result and job.resultHash always preserve the first submission; a stable original hash does not mean a later save failed. Never submit probe content to a real job to test persistence.",
        "This job is already claimed. Read job.json, context.json, output-schema.json, bounded inputs/ when present and the exact pinned files under skills/. Read result.json when present: it contains the latest saved suggestions, including changes made since any previous session. Never start from an old folder's copy. Write result.json in this new folder, then submit_job with workflowId, versionId, jobId and that folder. Keep this claim for follow-up changes and submit again as needed. When authorized to hand off the final saved draft, call finish_job with the same arguments. release_job and disconnect give up ownership while preserving saved work. Thirty minutes without job activity expires the claim; background checks do not keep it alive. After any handover or expiry, list the current job and claim its latest revision into a new folder before continuing. Return the dashboard link.",
        ...(job.kind === "draft-plan"
          ? [
              "Skill Library script-effect attestations are advisory. A missing attestation alone is not a workflow prerequisite. Apply a stricter rule only with its specific approved authority.",
              "For a mandatory workflow prerequisite put prerequisite: {factId, statement} on its guardrail using the exact approved Dossier fact. A platform prerequisite can cite platformRule: verification.verifierPin or approvalRequirements when that binding exists on the Node.",
              "Use scoped Decision Nodes for mandatory human approvals. A Node can declare approvalRequirements with a Decision ID, approving choice ID and exact required Run or Cycle artifact IDs. Describe the acceptance condition while a checker is being built. Bind a trusted verifier's SHA-256 and public key in verification.verifierPin when the approved requirement calls for signed results and the reviewed inputs are available. Route missing checker code to package implementation and keep its evidence outstanding.",
            ]
          : []),
        ...(planRepair
          ? [
              "Read context.json at planRepair. Start from recovery.startingPlan when present, otherwise basePlan.plan. The base is the current saved Plan. Inspect every source report, preserve compatible changes, and resolve competing wording or structure using the pinned evidence. Never guess missing evidence.",
              "Submit one complete Plan and a resolutions object keyed by the following item IDs. For each item, explain the specific change and its Plan location, why existing coverage suffices, or which evidence is missing. Use addressed, already-covered or needs-evidence. Validate the combined Plan before finishing.",
              JSON.stringify(planRepairItems(planRepair)),
              ...(job.repair_feedback
                ? [
                    "Revise the latest saved result.json in response to the human review: " +
                      job.repair_feedback.reason,
                  ]
                : []),
            ]
          : []),
        ...(followUp
          ? [
              `Revise the approved plan in context.json at authoringFollowUp.basePlan.plan. It is bound to the approved dossier in planning.input. Use the findings in authoringFollowUp.findings and preserve the rest of the approved plan.\n\nRequired change\n${followUp.action.requirement}\n\nDrafting instructions\n${followUp.action.prompt}`,
            ]
          : []),
        ...(authoring
          ? [
              "For new findings use schemaVersion 2 and give each finding a disposition containing subject, route, target, authority, acceptance and optionally findingId from the handoff. Routes are implementation, verification, plan, lane, question, sources, dossier, proposal, and badger. Use implementation for workflow package code, and badger only for a platform defect. Plan edits quote an existing JSON pointer or insertion point in target and the exact change in fix. Keep optional Skill Library reviews advisory.",
              "If submit_job returns validation findings, correct the named artifacts and retry in this claim before finishing. For a repair job, read the requirement in context.json before repeating the earlier work.",
              "Read both the roleBriefPath and sharedBriefPath in the Authoring handoff. Address priorFindings when revising a result.",
              "Use authoring.findingHistory for relevant earlier findings, reviewed work and verification evidence. Resolve historical citations through each observation’s evidenceFiles. Reference a continuing finding by ID. With the legacy report envelope, a BLOCKED result can use action.kind repair and an action.target of plan, sources, dossier or proposal.",
              "Route a finding by the implementation that needs to change. Use a stage repair for a workflow rule, a revised draft for a lane-local correction, and action.kind bug with area handoff, generator, runtime, or host for a demonstrated Badger defect or missing capability. Include expected behavior, observed behavior and evidence. A hook filename alone does not determine ownership.",
              "For DONE_WITH_CONCERNS, give each finding an owner, evidence and a concrete fix or expected result. Use action.kind repair or bug when upstream work is needed. A minor check that needs the assembled package may name evaluationCheck assembled-package-check, workflow-runtime-certification, or mcp-runtime-certification and describe the expected evidence in fix. These checks cover only their documented scope. Required authoring evidence and domain-specific acceptance remain separate.",
            ]
          : []),
        ...(scaffolds.length
          ? [
              "Use these scaffolds for the inline Markdown artifacts. Keep the section headings as written and use the pinned evidence to fill each section. In recovery, explain how a fresh process reads persisted state, finds the current Node and next step, and preserves the blocked reason.",
              ...scaffolds,
            ]
          : []),
      ].join("\n\n"),
    ),
    job: target,
  };
}
