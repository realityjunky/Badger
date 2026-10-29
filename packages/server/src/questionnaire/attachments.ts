import type { WriteContext } from "../audit.js";
import type { Queryable } from "../database/database.js";
import type { ServiceDependencies } from "../dependencies.js";
import { RequestError } from "../http/errors.js";
import type { BlobStore } from "../skills/blobs.js";
import { normalizeUploadPath } from "../skills/paths.js";
import type { AnswerAttachment } from "./answer-types.js";
import { fields, revisionInput, textInput } from "./model.js";
import { readQuestions, recordQuestionnaireAudit } from "./store.js";

export const ATTACHMENT_LIMITS = {
  maxFileBytes: 5 * 1024 * 1024,
  maxAnswerBytes: 20 * 1024 * 1024,
  maxFiles: 8,
  mediaTypes: [
    "text/plain",
    "text/csv",
    "application/json",
    "application/pdf",
    "image/png",
    "image/jpeg",
  ],
};
export const MAX_ATTACHMENT_BODY_BYTES =
  Math.ceil(ATTACHMENT_LIMITS.maxFileBytes / 3) * 4 + 4096;

interface AttachmentRow {
  id: string;
  question_id: string;
  person_id: string;
  name: string;
  media_type: string;
  size: number;
  hash: string;
}
function receipt(row: AttachmentRow): AnswerAttachment {
  return {
    id: row.id,
    name: row.name,
    mediaType: row.media_type,
    size: row.size,
    hash: row.hash,
  };
}
function validateFile(content: Buffer, type: string) {
  const head = content.subarray(0, 8);
  if (
    type === "application/pdf" &&
    content.subarray(0, 5).toString("ascii") === "%PDF-"
  )
    return;
  if (
    type === "image/png" &&
    head.equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    return;
  if (
    type === "image/jpeg" &&
    content[0] === 255 &&
    content[1] === 216 &&
    content[2] === 255
  )
    return;
  if (
    type === "text/plain" ||
    type === "text/csv" ||
    type === "application/json"
  ) {
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(content);
      if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(text))
        throw new Error();
      if (type === "application/json") JSON.parse(text);
      return;
    } catch {
      /* Report the same validation error for malformed text and JSON. */
    }
  }
  throw new RequestError(
    400,
    "Attachment content does not match an allowed file type",
  );
}

export async function uploadAttachment(
  tx: Queryable,
  deps: ServiceDependencies,
  blobs: BlobStore,
  context: WriteContext,
  versionId: string,
  questionId: string,
  input: Record<string, unknown>,
) {
  fields(input, ["questionRevision", "name", "mediaType", "contentBase64"]);
  const question = (
    await readQuestions(tx, versionId, context.personId, false)
  ).find((q) => q.id === questionId);
  if (!question?.canAnswer)
    throw new RequestError(
      403,
      "Only a current assignee may attach files to an answer",
    );
  if (question.revision !== revisionInput(input.questionRevision))
    throw new RequestError(409, "Read the current question before uploading");
  const name = normalizeUploadPath(textInput(input.name, "name", 255));
  if (name.includes("/"))
    throw new RequestError(400, "Attachments need a file name without folders");
  const mediaType = textInput(input.mediaType, "mediaType", 100);
  if (!ATTACHMENT_LIMITS.mediaTypes.includes(mediaType))
    throw new RequestError(400, "This attachment file type is not allowed");
  const encoded = input.contentBase64;
  if (
    typeof encoded !== "string" ||
    encoded.length > Math.ceil(ATTACHMENT_LIMITS.maxFileBytes / 3) * 4
  )
    throw new RequestError(413, "Attachments are limited to 5 MiB per file");
  const content = Buffer.from(encoded, "base64");
  if (content.length > ATTACHMENT_LIMITS.maxFileBytes)
    throw new RequestError(413, "Attachments are limited to 5 MiB per file");
  if (content.length === 0 || content.toString("base64") !== encoded)
    throw new RequestError(400, "Provide a nonempty file encoded as base64");
  validateFile(content, mediaType);
  const hash = await blobs.put(content);
  const id = deps.ids.next();
  await tx.query(
    `insert into answer_attachments (id, question_id, person_id, name, media_type, size, hash, created_at)
    values ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      id,
      questionId,
      context.personId,
      name,
      mediaType,
      content.length,
      hash,
      deps.clock.now(),
    ],
  );
  await recordQuestionnaireAudit(
    tx,
    deps,
    context,
    "answer.attachment-uploaded",
    "attachment",
    id,
    1,
    null,
  );
  return { id, name, mediaType, size: content.length, hash };
}

/** Only the answering person can incorporate their own uploads into a revision. */
export async function answerAttachments(
  tx: Queryable,
  questionId: string,
  personId: string,
  input: unknown,
): Promise<AnswerAttachment[]> {
  const ids = input ?? [];
  if (
    !Array.isArray(ids) ||
    ids.length > ATTACHMENT_LIMITS.maxFiles ||
    new Set(ids).size !== ids.length ||
    ids.some((id) => typeof id !== "string")
  )
    throw new RequestError(400, "Choose up to 8 distinct attachments");
  const attachments = [];
  for (const id of ids) {
    const row = (
      await tx.query<AttachmentRow>(
        "select * from answer_attachments where id = $1 and question_id = $2 and person_id = $3",
        [id, questionId, personId],
      )
    ).rows[0];
    if (!row)
      throw new RequestError(
        400,
        "Attachments must be your uploads for this question",
      );
    attachments.push(receipt(row));
  }
  if (
    attachments.reduce((sum, file) => sum + file.size, 0) >
    ATTACHMENT_LIMITS.maxAnswerBytes
  )
    throw new RequestError(
      400,
      "An answer's attachments are limited to 20 MiB in total",
    );
  return attachments;
}

/** Workflow readers see only uploads used by a submitted revision. Drafts stay private. */
export async function readAttachment(
  tx: Queryable,
  versionId: string,
  personId: string,
  id: string,
) {
  const row = (
    await tx.query<AttachmentRow>(
      `select a.* from answer_attachments a join questions q on q.id = a.question_id
    where a.id = $1 and q.workflow_version_id = $2 and (a.person_id = $3 or exists (
      select 1 from answer_revisions r where r.question_id = a.question_id and r.person_id = a.person_id and r.state = 'submitted'
      and r.attachments @> jsonb_build_array(jsonb_build_object('id', a.id))))`,
      [id, versionId, personId],
    )
  ).rows[0];
  if (!row) throw new RequestError(404, "No such visible attachment");
  return receipt(row);
}
