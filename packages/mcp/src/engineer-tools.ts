import { z } from "zod";
import type { BadgerApi } from "./api.js";
import { context, id, questionnairePath, tool } from "./tools.js";
import { claimJob, finishJob, jobsPath } from "./jobs.js";

export function engineerTools(api: BadgerApi) {
  const job = { ...context, jobId: id };
  const folder = { ...job, folder: z.string().min(1).max(4096) };
  return [
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
      "Claim a queued drafting job when the user asks; write its hash-bound context, schema, and exact pinned Skill files to a private local folder. Returns that folder.",
      { ...job, revision: z.number().int().min(1) },
      (args) => claimJob(api, args),
      "compose",
    ),
    tool(
      "submit_job",
      "Validate result.json in the claimed folder against the job's current schema and submit it as suggestions. A person must accept suggestions in the dashboard.",
      folder,
      (args) => finishJob(api, args, "submit"),
      "compose",
    ),
    tool(
      "release_job",
      "Release this Agent's claim back to the queue when the user asks. Supply the local folder returned by claim_job.",
      folder,
      (args) => finishJob(api, args, "release"),
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
