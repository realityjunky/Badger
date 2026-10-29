import { workflowCapabilities } from "../workflow-access.js";
import { listWorkflowVersions, readWorkflow } from "../workflows.js";
import {
  saveStudyRecord,
  evidenceLines,
  parseStudyContent,
  readSourceStudy,
  studyRecords,
  studyRevisions,
  type SourceEvidence,
} from "../source-study.js";
import type { AuthorizedRequest } from "./authorized-request.js";
import { readJsonBody } from "./body.js";
import { objectInput, RequestError } from "./errors.js";

const STUDY_PATH =
  /^\/api\/v1\/workflows\/([^/]+)\/versions\/([^/]+)\/source-study(?:\/(facts|interfaces)(?:\/([^/]+)(?:\/(evidence)\/(\d+))?)?)?$/u;
export function sourceStudyMethods(path: string): string | null {
  const match = STUDY_PATH.exec(path);
  if (match === null) return null;
  if (match[3] !== undefined && match[4] === undefined)
    return "GET, HEAD, POST";
  return match[4] !== undefined && match[5] === undefined
    ? "GET, HEAD, PATCH, DELETE"
    : "GET, HEAD";
}
export async function handleSourceStudy(
  input: AuthorizedRequest,
): Promise<void> {
  const {
    path,
    method,
    database,
    dependencies,
    context,
    blobs,
    access,
    person,
    reply,
    request,
    url,
  } = input;
  const match = STUDY_PATH.exec(path)!;
  const workflow = await readWorkflow(database, decodeURIComponent(match[1]));
  if (workflow === null) return reply.error(404, "invalid", "No such workflow");
  const capabilities = await workflowCapabilities(
    database,
    access,
    person,
    workflow,
  );
  if (!capabilities.read)
    return reply.error(403, "denied", "This workflow is outside your roles");
  const versionId = decodeURIComponent(match[2]);
  if (
    !(await listWorkflowVersions(database, workflow.id)).some(
      (v) => v.id === versionId,
    )
  )
    return reply.error(404, "invalid", "No such workflow version");
  const kind = match[3] === "interfaces" ? "interface" : "fact";
  if (["POST", "PATCH", "DELETE"].includes(method)) {
    if (!capabilities.manageSourceStudy)
      return reply.error(
        403,
        "denied",
        "Only a signed-in Administrator or Engineer records source study",
      );
    const body = await readJsonBody(request);
    if (!body.ok) return reply.error(400, "invalid", body.message);
    const value = objectInput(body.value);
    const { revision, ...content } = value;
    if (
      method === "POST"
        ? revision !== undefined
        : !Number.isSafeInteger(revision) || (revision as number) < 1
    )
      throw new RequestError(
        400,
        "Quote the current revision when editing or retiring a record; omit it for a new record",
      );
    if (method === "DELETE" && Object.keys(content).length > 0)
      throw new RequestError(400, "Retiring takes only the current revision");
    return reply.json(method === "POST" ? 201 : 200, {
      record: await saveStudyRecord(
        database,
        dependencies,
        context,
        blobs,
        versionId,
        kind,
        {
          id: match[4] === undefined ? undefined : decodeURIComponent(match[4]),
          revision: revision as number | undefined,
          content:
            method === "DELETE" ? null : parseStudyContent(kind, content),
        },
      ),
    });
  }
  if (match[4] === undefined) {
    const study = await readSourceStudy(database, versionId);
    return reply.json(
      200,
      match[3] === undefined
        ? study
        : { records: match[3] === "facts" ? study.facts : study.interfaces },
    );
  }
  const record = (await studyRecords(database, versionId)).find(
    (r) => r.id === decodeURIComponent(match[4]) && r.kind === kind,
  );
  if (record === undefined)
    return reply.error(404, "invalid", "No such source study record");
  if (match[5] !== undefined) {
    const revision = Number(url.searchParams.get("revision"));
    if (!Number.isSafeInteger(revision) || revision < 1)
      throw new RequestError(400, "Quote the cited record revision");
    const result = await database.query<{
      content: { evidence: SourceEvidence[] };
    }>(
      "select content from source_study_revisions where record_id = $1 and revision = $2",
      [record.id, revision],
    );
    const evidence = result.rows[0]?.content.evidence[Number(match[6])];
    if (evidence === undefined)
      return reply.error(
        404,
        "invalid",
        "No such citation at this record revision",
      );
    return reply.json(200, await evidenceLines(database, blobs, evidence));
  }
  return reply.json(200, {
    record,
    revisions: await studyRevisions(database, record.id),
  });
}
