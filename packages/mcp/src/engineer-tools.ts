import { z } from "zod";
import type { BadgerApi } from "./api.js";
import { context, id, questionnairePath, tool } from "./tools.js";
import { claimJob, finishJob, jobsPath } from "./jobs.js";
import type { LocalDraftingSessions } from "./drafting-sessions.js";
import {
  readDossierReadiness,
  readWorkingDossierJob,
  type LocalWorkingDossiers,
} from "./working-dossier.js";

export function engineerTools(
  api: BadgerApi,
  sessions: LocalDraftingSessions,
  dossiers: LocalWorkingDossiers,
) {
  const job = { ...context, jobId: id };
  const localFolder = z.string().min(1).max(4096);
  const folder = { ...job, folder: localFolder };
  return [
    tool(
      "working_dossier_job",
      "Read the current working Semantic dossier job for an exact workflow version, including checked Skill pins, the edit schema, reviewed answers, instructions, and the dashboard review link.",
      context,
      (args) => readWorkingDossierJob(api, args),
      "compose",
      true,
    ),
    tool(
      "working_dossier_sources",
      "Prepare a private folder with the job's exact pinned files. Quote dossier.pinsHash from working_dossier_job. An optional localSourceRoot holds folders named for each Skill. Supply localSkillRoots keyed by Skill ID for specific folders. Locally verified files and pinned files fetched from Badger are returned with their hashes. Read the returned localPath values without executing the files.",
      {
        ...context,
        pinsHash: z.string().regex(/^[a-f0-9]{64}$/u),
        localSourceRoot: localFolder.optional(),
        localSkillRoots: z.record(id, localFolder).optional(),
      },
      (args) => dossiers.sources(args),
      "compose",
    ),
    tool(
      "save_working_dossier",
      "Save a partial working Semantic dossier edit. Use the job's schema, current revision and pinsHash. Supply the edit inline or write it to edit.json in your working_dossier_sources folder. Keep the same editId and body for retries. On a revision conflict, read the latest job and reconcile the edit. Return the dashboard review link to the Engineer.",
      {
        ...context,
        edit: z.record(z.string(), z.unknown()).optional(),
        folder: localFolder.optional(),
      },
      (args) => dossiers.save(args),
      "compose",
    ),
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
      "List drafting jobs and their current suggestions. Read currentResultHash and currentResultPath for the latest saved draft. result and resultHash preserve the immutable first submission; later edits are in review.result and review.resultHash. Never diagnose a failed update by comparing only the original resultHash.",
      context,
      async (args) => {
        await sessions.touchWorkflow(args);
        return api.request(jobsPath(args));
      },
      "compose",
      true,
    ),
    tool(
      "claim_job",
      "Claim a queued job or unclaimed suggestions when the user asks. Always read the latest revision first. Write the latest saved suggestions, context, schema and pinned files to a new private folder. After finish, release, disconnect or 30 minutes without job activity, claim again and read the new folder; never reuse an old result.json as the current draft.",
      { ...job, revision: z.number().int().min(1) },
      (args) => claimJob(api, args, sessions),
      "compose",
    ),
    tool(
      "submit_job",
      "Read, validate and save result.json while keeping this session's claim. savedDraft reports the stored hash, content path and claim state; submittedResultHash identifies the parsed file sent. Original result/resultHash stay unchanged; later drafts are in job.review.result with job.currentResultHash. Repeat for follow-up changes and wait for the user before finish_job. A person accepts separately in the dashboard.",
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
      "Read readiness blockers by topic for the current Semantic dossier revision.",
      context,
      (args) => readDossierReadiness(api, args),
      "compose",
      true,
    ),
  ];
}
