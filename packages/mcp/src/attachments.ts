import { promises as fs } from "node:fs";
import path from "node:path";
import { BadgerTimeoutError, type BadgerApi } from "./api.js";
import { readRegularFile, uploadTimeoutSeconds } from "./upload.js";

/** The service names each allowed type; an extension only suggests one. */
const EXTENSION_TYPES: Record<string, string> = {
  ".txt": "text/plain",
  ".csv": "text/csv",
  ".json": "application/json",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
};

interface QuestionnaireView {
  attachmentLimits: { maxFileBytes: number; mediaTypes: string[] };
  questions: { id: string; revision: number; canAnswer: boolean }[];
}

/**
 * Check the service's assignment, revision, type, and size limits before a
 * byte is sent. The service still validates the content and owns the receipt.
 */
export async function uploadAttachment(
  api: BadgerApi,
  questionnaire: string,
  input: {
    questionId: string;
    questionRevision: number;
    file: string;
    name?: string;
    mediaType?: string;
  },
) {
  const { attachmentLimits: limits, questions } =
    await api.request<QuestionnaireView>(questionnaire);
  const question = questions.find((q) => q.id === input.questionId);
  if (!question?.canAnswer)
    throw new Error("Only a current assignee may attach files to this answer");
  if (question.revision !== input.questionRevision)
    throw new Error(
      `The Engineer revised the question; read it before uploading (currentRevision: ${question.revision})`,
    );
  const name = input.name ?? path.basename(input.file);
  const mediaType =
    input.mediaType ?? EXTENSION_TYPES[path.extname(name).toLowerCase()];
  if (mediaType === undefined || !limits.mediaTypes.includes(mediaType))
    throw new Error(
      `Attach a file of an allowed type and name its mediaType: ${limits.mediaTypes.join(", ")}`,
    );
  const target = path.resolve(input.file);
  const info = await fs.lstat(target);
  if (!info.isFile() || info.isSymbolicLink())
    throw new Error("Select a regular file; symbolic links are refused");
  const content = await readRegularFile(
    target,
    limits.maxFileBytes,
    `Attachments are limited to ${limits.maxFileBytes} bytes per file`,
  );
  if (content.length === 0) throw new Error("Attach a nonempty file");
  const contentBase64 = content.toString("base64");
  try {
    return await api.request<{ attachment: unknown }>(
      `${questionnaire}/questions/${input.questionId}/attachments`,
      "POST",
      {
        questionRevision: input.questionRevision,
        name,
        mediaType,
        contentBase64,
      },
      uploadTimeoutSeconds(contentBase64.length),
    );
  } catch (error) {
    if (error instanceof BadgerTimeoutError)
      throw new Error(
        `Badger did not answer within ${error.seconds} s. The file may have been stored privately; uploading it again stores another private copy, and only attachments a saved answer lists join it.`,
      );
    throw error;
  }
}
