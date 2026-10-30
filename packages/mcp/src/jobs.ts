import { createHash } from "node:crypto";
import { constants, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Ajv } from "ajv";
import { canonicalHash } from "@realityjunky/badger";
import type { BadgerApi } from "./api.js";

interface JobInput {
  workflowId: string;
  versionId: string;
  jobId: string;
}
interface ClaimedJob {
  id: string;
  kind:
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
}
interface LocalClaim extends JobInput {
  url: string;
  leaseId: string;
  contextHash: string;
}
export function jobsPath(input: { workflowId: string; versionId: string }) {
  return `/workflows/${encodeURIComponent(input.workflowId)}/versions/${encodeURIComponent(input.versionId)}/drafting-jobs`;
}

/**
 * Git runs commands a repository configures, so no `.git` entry lands in any
 * letter case, including with the code points HFS+ ignores or the trailing
 * dots and spaces Windows trims.
 */
function gitMetadata(segment: string) {
  const name = segment
    .replace(/[\u200c-\u200f\u202a-\u202e\u206a-\u206f\ufeff]/gu, "")
    .replace(/[. ]+$/u, "");
  return name.toLowerCase() === ".git" || name.toUpperCase() === ".GIT";
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
) {
  const claimed = await api.request<{
    job: ClaimedJob;
    contextBundle: {
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
      message:
        "Read context.json and the Skill files under skills/; `skills` lists the pinned versions this kind reads. Write result.json using output-schema.json, then submit_job. Results remain suggestions until a person accepts them.",
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
  action: "submit" | "release",
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
  let result: unknown;
  if (action === "submit") {
    // Reload the authoritative schema; an edited local schema grants nothing.
    const { job } = await api.request<{ job: ClaimedJob }>(
      `${jobsPath(input)}/${input.jobId}`,
    );
    if (job.status !== "claimed" || job.contextHash !== claim.contextHash)
      throw new Error(
        "The job is no longer claimed or its inputs changed; list jobs again",
      );
    result = await readJson(input.folder, "result.json", 1024 * 1024);
    const ajv = new Ajv({ strict: false });
    const valid = ajv.compile(job.outputSchema);
    if (!valid(result))
      throw new Error(
        `The result does not match the job's output schema: ${ajv.errorsText(valid.errors)}`,
      );
  }
  const response = await api.request<{ job: ClaimedJob }>(
    `${jobsPath(input)}/${input.jobId}/${action}`,
    "POST",
    {
      leaseId: claim.leaseId,
      contextHash: claim.contextHash,
      ...(action === "submit" ? { result } : {}),
    },
  );
  return action === "submit"
    ? {
        ...(response as object),
        requiresPerson: true,
        dashboardUrl:
          response.job.kind === "draft-plan"
            ? `${api.url}/workflows/${encodeURIComponent(input.workflowId)}/versions/${encodeURIComponent(input.versionId)}#plan`
            : `${api.url}/questionnaire?workflow=${encodeURIComponent(input.workflowId)}&version=${encodeURIComponent(input.versionId)}&panel=suggestions`,
        message:
          "The result is a suggestion. Ask the person to review, edit, accept, or discard it in the dashboard.",
      }
    : response;
}
