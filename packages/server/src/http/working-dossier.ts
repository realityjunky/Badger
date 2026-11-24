import { workflowCapabilities } from "../workflow-access.js";
import { listWorkflowVersions, readWorkflow } from "../workflows.js";
import { parseSourceEvidence } from "../source-study.js";
import { invalidateDossierApproval } from "../dossier.js";
import {
  MAX_DOSSIER_EDIT_BYTES,
  readWorkingDossier,
  saveWorkingDossier,
  workingDossierEvidence,
  workingDossierFiles,
  workingDossierJob,
} from "../working-dossier.js";
import type { AuthorizedRequest } from "./authorized-request.js";
import { readJsonBody } from "./body.js";
import { RequestError } from "./errors.js";

const PATH =
  /^\/api\/v1\/workflows\/([^/]+)\/versions\/([^/]+)\/working-dossier(?:\/(job|files|evidence))?$/u;

export function workingDossierMethods(path: string) {
  const match = PATH.exec(path);
  if (!match) return null;
  if (match[3] === "files") return "POST";
  return match[3] === undefined ? "GET, HEAD, PATCH" : "GET, HEAD";
}

export async function handleWorkingDossier(input: AuthorizedRequest) {
  const {
    path,
    method,
    database,
    person,
    access,
    context,
    dependencies,
    request,
    reply,
    url,
    blobs,
  } = input;
  const [, rawWorkflow, rawVersion, action] = PATH.exec(path)!;
  const methods = workingDossierMethods(path)!;
  if (!methods.split(", ").includes(method))
    return reply.error(405, "invalid", "Method not allowed", {
      allow: methods,
    });
  const workflowId = decodeURIComponent(rawWorkflow);
  const versionId = decodeURIComponent(rawVersion);
  const parsed =
    method === "PATCH" || method === "POST"
      ? await readJsonBody(
          request,
          method === "PATCH" ? MAX_DOSSIER_EDIT_BYTES : 64 * 1024,
        )
      : null;
  if (parsed && !parsed.ok)
    throw new RequestError(parsed.status ?? 400, parsed.message);
  const body = parsed?.value;
  const result = await database.transaction(async (tx) => {
    await tx.query(
      "select id from workflow_versions where id = $1 and workflow_id = $2 for no key update",
      [versionId, workflowId],
    );
    const workflow = await readWorkflow(tx, workflowId);
    const version =
      workflow &&
      (await listWorkflowVersions(tx, workflowId)).find(
        (version) => version.id === versionId,
      );
    if (!workflow || !version)
      throw new RequestError(404, "No such workflow version");
    const caps = await workflowCapabilities(tx, access, person, workflow);
    if (!caps.read)
      throw new RequestError(403, "This workflow is outside your roles");
    if (
      (action === "job" || action === "files" || method === "PATCH") &&
      !caps.editWorkingDossier
    )
      throw new RequestError(
        403,
        "Only the workflow's Engineer can draft the working dossier",
      );
    switch (action) {
      case "job":
        return workingDossierJob(tx, version, person.id);
      case "files":
        return workingDossierFiles(tx, blobs, version, body);
      case "evidence": {
        const revision = Number(url.searchParams.get("revision"));
        if (
          !Number.isSafeInteger(revision) ||
          revision < 1 ||
          revision > 2_147_483_647
        )
          throw new RequestError(400, "Quote the saved dossier revision");
        const get = (key: string) => url.searchParams.get(key);
        return workingDossierEvidence(
          tx,
          blobs,
          versionId,
          revision,
          parseSourceEvidence({
            skillId: get("skillId"),
            hash: get("hash"),
            path: get("path"),
            fileHash: get("fileHash"),
            startLine: Number(get("startLine")),
            endLine: Number(get("endLine")),
          }),
        );
      }
    }
    if (method === "PATCH") {
      const value = await saveWorkingDossier(
        tx,
        dependencies,
        context,
        blobs,
        version,
        body,
      );
      if (value.newRevision) {
        await invalidateDossierApproval(
          tx,
          dependencies,
          context,
          versionId,
          "A new working dossier revision was saved",
        );
        await tx.query(
          `update workflow_versions set stages = stages ||
            '{"source-study":"active","questionnaire":"active","dossier":"active"}'::jsonb,
            revision = revision + 1, updated_at = $2 where id = $1`,
          [versionId, dependencies.clock.now()],
        );
      }
      const { newRevision: _newRevision, ...view } = value;
      return view;
    }
    return readWorkingDossier(tx, version, person.id, caps.editWorkingDossier);
  });
  reply.json(200, result);
}
