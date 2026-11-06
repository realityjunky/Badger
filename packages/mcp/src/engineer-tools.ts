import { z } from "zod";
import type { BadgerApi } from "./api.js";
import { context, id, questionnairePath, tool } from "./tools.js";
import { claimJob, finishJob, jobsPath } from "./jobs.js";
import type { LocalDraftingSessions } from "./drafting-sessions.js";

export function engineerTools(api: BadgerApi, sessions: LocalDraftingSessions) {
  const job = { ...context, jobId: id };
  const folder = { ...job, folder: z.string().min(1).max(4096) };
  return [
    tool(
      "evaluation_status",
      "Read evaluation jobs, progress, immutable report history, and kernel publication readiness for a workflow version. Starting an evaluation requires the person to confirm in the dashboard.",
      context,
      async (args) => ({
        ...(await api.request<Record<string, unknown>>(
          `/workflows/${encodeURIComponent(args.workflowId)}/versions/${encodeURIComponent(args.versionId)}/evaluations`,
        )),
        dashboard: `${api.url}/evaluations?workflow=${encodeURIComponent(args.workflowId)}&version=${encodeURIComponent(args.versionId)}`,
      }),
      "compose",
      true,
    ),
    tool(
      "list_jobs",
      "List drafting jobs for a workflow version, including queued work and submitted suggestions.",
      context,
      (args) => api.request(jobsPath(args)),
      "compose",
      true,
    ),
    tool(
      "claim_job",
      "Claim a queued job or unclaimed suggestions when the user asks. Write its hash-bound context, schema, pinned files, and any existing suggestions to a private local folder. This MCP session keeps the exclusive claim until finish_job, release_job, or disconnect.",
      { ...job, revision: z.number().int().min(1) },
      (args) => claimJob(api, args, sessions),
      "compose",
    ),
    tool(
      "submit_job",
      "Validate and save result.json as suggestions while keeping this session's exclusive claim. Repeat for follow-up changes. Do not finish automatically after submitting; wait until the user says the drafting session is finished. A person accepts suggestions separately in the dashboard.",
      folder,
      (args) => finishJob(api, args, "submit", sessions),
      "compose",
    ),
    tool(
      "finish_job",
      "When the user says this drafting session is finished, release its exclusive claim and hand the latest saved suggestions to the dashboard. Other people can then edit or claim the job again. This never accepts suggestions. Submit unsaved result.json changes first.",
      folder,
      (args) => finishJob(api, args, "finish", sessions),
      "compose",
    ),
    tool(
      "release_job",
      "End this session's claim when the user asks. Saved suggestions become available for review and another claim; a job without suggestions returns to the queue. Supply the local folder returned by claim_job.",
      folder,
      (args) => finishJob(api, args, "release", sessions),
      "compose",
    ),
    tool(
      "questionnaire",
      "Read the questionnaire for a workflow version, including draft questions, submitted answers, and suggestions.",
      context,
      (args) => api.request(questionnairePath(args)),
      "compose",
      true,
    ),
    tool(
      "ledger",
      "Read the questionnaire's five-part ledger and changes since an optional published round.",
      { ...context, sinceRound: id.optional() },
      (args) =>
        api.request(
          `${questionnairePath(args)}/ledger${args.sinceRound ? `?sinceRound=${encodeURIComponent(args.sinceRound)}` : ""}`,
        ),
      "compose",
      true,
    ),
    tool(
      "readiness",
      "Read the kernel's readiness blockers by dossier topic. This never confirms facts or approves a dossier.",
      context,
      async (args) => {
        const { handoff } = await api.request<{
          handoff: { readiness: unknown };
        }>(`${questionnairePath(args)}/ledger`);
        return { readiness: handoff.readiness };
      },
      "compose",
      true,
    ),
  ];
}
