import { createHash } from "node:crypto";
import { constants, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Ajv } from "ajv";
import { canonicalHash } from "@realityjunky/badger";
import type { BadgerApi } from "./api.js";
import { gitMetadata } from "./upload.js";
import type { LocalDraftingSessions } from "./drafting-sessions.js";

interface JobInput {
  workflowId: string;
  versionId: string;
  jobId: string;
}
interface ClaimedJob {
  id: string;
  kind:
    | "authoring-lane"
    | "review-vote"
    | "draft-questions"
    | "draft-follow-ups"
    | "draft-plan"
    | "source-study"
    | "restate-answer"
    | "translate-question"
    | "import-open-questions";
  roundId: string | null;
  skillId: string | null;
  questionId: string | null;
  locale: string | null;
  parentQuestionId: string | null;
  revision: number;
  status: string;
  contextHash: string;
  outputSchema: object;
  lease: { id: string; until: string };
  result: unknown;
  resultHash: string | null;
  currentResultHash?: string | null;
  currentResultPath?: string | null;
  review: { result: unknown; resultHash: string } | null;
}
interface LocalClaim extends JobInput {
  url: string;
  leaseId: string;
  contextHash: string;
}
export function jobsPath(input: { workflowId: string; versionId: string }) {
  return `/workflows/${encodeURIComponent(input.workflowId)}/versions/${encodeURIComponent(input.versionId)}/drafting-jobs`;
}

function safePath(value: string) {
  if (
    !value ||
    value.includes("\\") ||
    /[\u0000-\u001f:]/u.test(value) ||
    value.split("/").some((p) => !p || p === "." || p === "..")
  )
    throw new Error("The job bundle contains an unsafe file path");
  if (value.split("/").some(gitMetadata))
    throw new Error(
      "A pinned Skill contains a .git path; the MCP refuses to write Git metadata into a job folder",
    );
  return value;
}

/** A bounded descriptor read refuses links, special files, and replacements. */
async function readJson(
  folder: string,
  name: string,
  limit: number,
): Promise<unknown> {
  const directory = await fs.lstat(folder);
  if (!directory.isDirectory() || directory.isSymbolicLink())
    throw new Error("Select the regular job folder returned by claim_job");
  const root = await fs.realpath(folder);
  const target = path.join(root, name);
  const handle = await fs.open(
    target,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const info = await handle.stat();
    const current = await fs.lstat(target);
    if (
      !info.isFile() ||
      current.isSymbolicLink() ||
      info.ino !== current.ino ||
      info.dev !== current.dev ||
      info.size > limit ||
      (await fs.realpath(target)) !== target
    )
      throw new Error(
        "Job files must be regular, contained files within the size limit",
      );
    const bytes = Buffer.alloc(limit + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(
        bytes,
        offset,
        bytes.length - offset,
        null,
      );
      if (!bytesRead) break;
      offset += bytesRead;
    }
    const after = await fs.lstat(folder);
    if (
      offset > limit ||
      after.isSymbolicLink() ||
      after.ino !== directory.ino ||
      after.dev !== directory.dev
    )
      throw new Error("The job folder changed or exceeded the size limit");
    return JSON.parse(bytes.subarray(0, offset).toString("utf8"));
  } finally {
    await handle.close();
  }
}

export async function claimJob(
  api: BadgerApi,
  input: JobInput & { revision: number },
  sessions: LocalDraftingSessions,
) {
  const claimed = await api.request<{
    job: ClaimedJob;
    contextBundle: {
      authoring?: { files: { path: string; text: string; hash: string }[] };
      pins: {
        skillId: string;
        hash: string;
        inventory: { path: string; hash: string }[];
      }[];
    };
    skills: { skillId: string; versionHash: string }[];
    files: {
      skillId: string;
      versionHash: string;
      path: string;
      hash: string;
      contentBase64: string;
    }[];
    instructions?: string;
  }>(`${jobsPath(input)}/${input.jobId}/claim`, "POST", {
    revision: input.revision,
  });
  let folder: string | undefined;
  try {
    if (canonicalHash(claimed.contextBundle) !== claimed.job.contextHash)
      throw new Error("The job context hash does not match its bundle");
    // The kind decides which pinned Skills arrive; each arrives whole, and
    // every file is checked before anything is written.
    const expected = new Map<string, string>();
    for (const skill of claimed.skills) {
      const pin = claimed.contextBundle.pins.find(
        (p) => p.skillId === skill.skillId && p.hash === skill.versionHash,
      );
      if (!pin)
        throw new Error(
          "The job ships a Skill version its context does not pin",
        );
      for (const file of pin.inventory)
        expected.set(`${pin.skillId}/${pin.hash}/${file.path}`, file.hash);
    }
    const writes = claimed.files.map((file) => {
      const relative = safePath(
        `${file.skillId}/${file.versionHash}/${file.path}`,
      );
      const bytes = Buffer.from(file.contentBase64, "base64");
      if (
        expected.get(relative) !== file.hash ||
        createHash("sha256").update(bytes).digest("hex") !== file.hash
      )
        throw new Error("A pinned Skill file does not match its inventory");
      expected.delete(relative);
      return { relative, bytes };
    });
    if (expected.size)
      throw new Error("The job bundle is missing pinned Skill files");
    folder = await fs.mkdtemp(path.join(os.tmpdir(), "badger-drafting-"));
    await fs.chmod(folder, 0o700);
    for (const { relative, bytes } of writes) {
      const target = path.join(folder, "skills", relative);
      await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      await fs.writeFile(target, bytes, { mode: 0o600, flag: "wx" });
    }
    for (const file of claimed.contextBundle.authoring?.files ?? []) {
      const relative = safePath(file.path);
      if (
        !relative.startsWith("inputs/") ||
        createHash("sha256").update(file.text).digest("hex") !== file.hash
      )
        throw new Error("An Authoring input differs from its bounded context");
      const target = path.join(folder, relative);
      await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      await fs.writeFile(target, file.text, { mode: 0o600, flag: "wx" });
    }
    const claim: LocalClaim = {
      workflowId: input.workflowId,
      versionId: input.versionId,
      jobId: input.jobId,
      url: api.url,
      leaseId: claimed.job.lease.id,
      contextHash: claimed.job.contextHash,
    };
    for (const [name, value] of [
      ["context.json", claimed.contextBundle],
      ["output-schema.json", claimed.job.outputSchema],
      ["claim.json", claim],
      ["job.json", claimed.job],
    ] as const)
      await fs.writeFile(
        path.join(folder, name),
        JSON.stringify(value, null, 2),
        { mode: 0o600, flag: "wx" },
      );
    const previous = claimed.job.review?.result ?? claimed.job.result;
    if (previous !== null && previous !== undefined)
      await fs.writeFile(
        path.join(folder, "result.json"),
        JSON.stringify(previous, null, 2),
        { mode: 0o600, flag: "wx" },
      );
    if (claimed.instructions)
      await fs.writeFile(
        path.join(folder, "instructions.md"),
        claimed.instructions,
        { mode: 0o600, flag: "wx" },
      );
    sessions.remember(claim);
    return {
      folder,
      jobId: input.jobId,
      kind: claimed.job.kind,
      roundId: claimed.job.roundId,
      parentQuestionId: claimed.job.parentQuestionId,
      skillId: claimed.job.skillId,
      questionId: claimed.job.questionId,
      locale: claimed.job.locale,
      skills: claimed.skills,
      revision: claimed.job.revision,
      contextHash: claimed.job.contextHash,
      leaseUntil: claimed.job.lease.until,
      resultFile: path.join(folder, "result.json"),
      hasPreviousSuggestions: previous !== null && previous !== undefined,
      instructionsFile: claimed.instructions
        ? path.join(folder, "instructions.md")
        : null,
      message: claimed.instructions
        ? "Read instructions.md for the server's task instructions and template revision, then context.json, output-schema.json and the supplied pinned files. Follow the exact output schema; submit suggestions for a person's review."
        : claimed.job.kind === "source-study"
          ? "Read context.json and its versioned scriptEffectContract, output-schema.json, and the exact target Skill files under skills/, including invoked helpers and configuration. Never execute source code. Draft facts and scriptEffects in result.json, leaving interfaces empty. Cross-Skill analysis belongs to questionnaire discovery. Preserve uncertainty and omitted coverage as pending, then submit_job. People sign off in the dashboard."
          : "Read context.json, any bounded Authoring files under inputs/, and the Skill files under skills/; `skills` lists the pinned versions this kind reads. Write result.json using output-schema.json, then submit_job. Results remain suggestions until a person accepts them.",
    };
  } catch (error) {
    if (folder)
      await fs
        .rm(folder, { recursive: true, force: true })
        .catch(() => undefined);
    await api
      .request(`${jobsPath(input)}/${input.jobId}/release`, "POST", {
        leaseId: claimed.job.lease.id,
        contextHash: claimed.job.contextHash,
      })
      .catch(() => undefined);
    throw error;
  }
}

export async function finishJob(
  api: BadgerApi,
  input: JobInput & { folder: string },
  action: "submit" | "finish" | "release",
  sessions: LocalDraftingSessions,
) {
  const claim = (await readJson(
    input.folder,
    "claim.json",
    16384,
  )) as Partial<LocalClaim> | null;
  if (
    !claim ||
    claim.url !== api.url ||
    claim.workflowId !== input.workflowId ||
    claim.versionId !== input.versionId ||
    claim.jobId !== input.jobId ||
    typeof claim.leaseId !== "string" ||
    typeof claim.contextHash !== "string"
  )
    throw new Error("This folder belongs to another job or deployment");
  const session = claim as LocalClaim;
  if (!sessions.owns(session))
    throw new Error(
      "This claim belongs to another MCP session; claim the job again after that session finishes",
    );
  let result: unknown;
  let revision: number | undefined;
  if (action !== "release") {
    // Reload the authoritative schema; an edited local schema grants nothing.
    const { job } = await api.request<{ job: ClaimedJob }>(
      `${jobsPath(input)}/${input.jobId}`,
    );
    if (job.status !== "claimed" || job.contextHash !== claim.contextHash)
      throw new Error(
        "The job is no longer claimed or its inputs changed; list jobs again",
      );
    revision = job.revision;
    if (action === "submit") {
      result = await readJson(input.folder, "result.json", 1024 * 1024);
      const ajv = new Ajv({ strict: false });
      const valid = ajv.compile(job.outputSchema);
      if (!valid(result))
        throw new Error(
          `The result does not match the job's output schema: ${ajv.errorsText(valid.errors)}`,
        );
    }
  }
  const response = await api.request<{
    job: ClaimedJob;
    savedDraft?: {
      resultHash: string | null;
      resultPath: string;
      revision: number;
      claimRetained: boolean;
      legacySubmission: boolean;
    };
  }>(`${jobsPath(input)}/${input.jobId}/${action}`, "POST", {
    leaseId: claim.leaseId,
    contextHash: claim.contextHash,
    ...(revision === undefined ? {} : { revision }),
    ...(action === "submit" ? { result, keepClaim: true } : {}),
  });
  if (action !== "submit" || response.job.status !== "claimed")
    sessions.forget(session);
  const { savedDraft: serverSavedDraft, ...jobResponse } = response;
  const savedDraft =
    action === "submit"
      ? {
          ...(serverSavedDraft ?? {
            resultHash:
              response.job.currentResultHash ??
              response.job.review?.resultHash ??
              response.job.resultHash,
            resultPath: `job.${response.job.currentResultPath ?? (response.job.review ? "review.result" : "result")}`,
            revision: response.job.revision,
            claimRetained: response.job.status === "claimed",
            legacySubmission: false,
          }),
          submittedResultHash: canonicalHash(result),
        }
      : undefined;
  return action !== "release"
    ? {
        ...(savedDraft ? { savedDraft } : {}),
        ...jobResponse,
        requiresPerson: response.job.status === "submitted",
        dashboardUrl:
          response.job.kind === "authoring-lane" ||
          response.job.kind === "review-vote"
            ? `${api.url}/workflows/${encodeURIComponent(input.workflowId)}/versions/${encodeURIComponent(input.versionId)}#package`
            : response.job.kind === "draft-plan"
              ? `${api.url}/workflows/${encodeURIComponent(input.workflowId)}/versions/${encodeURIComponent(input.versionId)}#plan`
              : `${api.url}/questionnaire?workflow=${encodeURIComponent(input.workflowId)}&version=${encodeURIComponent(input.versionId)}&panel=suggestions`,
        message:
          action === "submit"
            ? `The latest draft was saved with hash ${savedDraft!.resultHash} at ${savedDraft!.resultPath}. job.result and job.resultHash preserve the first submission; use job.currentResultHash and job.currentResultPath for the current draft. ${savedDraft!.claimRetained ? "This MCP session keeps the job claimed for follow-up changes. Edit result.json and call submit_job again as needed. Call finish_job only when the person says the drafting session is finished." : "The claim was released. Update and restart the local Badger MCP before continuing an iterative drafting session."}`
            : "The drafting session is finished. A person can review and edit the suggestions in the dashboard, or claim the job again with an Agent. Only a person can accept or discard them.",
      }
    : response;
}
