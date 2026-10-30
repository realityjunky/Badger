import { commitGate, readGateConfirmations } from "../gates.js";
import { workflowCapabilities } from "../workflow-access.js";
import { sourcesGateState } from "../workflow-gates.js";
import { sourceStudyGateState } from "../source-study-gates.js";
import { studyGateName } from "../source-study-invalidation.js";
import { listWorkflowVersions, readWorkflow } from "../workflows.js";
import type { AuthorizedRequest } from "./authorized-request.js";
import { readJsonBody } from "./body.js";
import { objectInput, RequestError } from "./errors.js";
import type { Queryable } from "../database/database.js";
import { dossierGateState } from "../dossier.js";
import { planGateState } from "../plans.js";
import { proposalGateState } from "../proposals.js";

const GATE_PATH =
  /^\/api\/v1\/workflows\/([^/]+)\/versions\/([^/]+)\/gates\/(sources|dossier|plan|proposal|source-study\/([^/]+))(?:\/(preview|commit))?$/u;

export function gateMethods(path: string): string | null {
  const match = GATE_PATH.exec(path);
  return match === null ? null : match[5] === undefined ? "GET, HEAD" : "POST";
}

export async function handleGate(input: AuthorizedRequest): Promise<void> {
  const {
    path,
    method,
    database,
    access,
    person,
    reply,
    request,
    dependencies,
    context,
  } = input;
  const match = GATE_PATH.exec(path)!;
  const methods = gateMethods(path)!;
  if (!methods.split(", ").includes(method))
    return reply.error(405, "invalid", "Method not allowed", {
      allow: methods,
    });
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
  const skillId =
    match[4] === undefined ? undefined : decodeURIComponent(match[4]);
  const gate = skillId === undefined ? match[3] : studyGateName(skillId);
  const loadState = (tx: Queryable) =>
    gate === "proposal"
      ? proposalGateState(tx, input.config, versionId, person.id)
      : gate === "plan"
        ? planGateState(tx, versionId, person.id)
        : gate === "dossier"
          ? dossierGateState(tx, versionId, person.id)
          : skillId === undefined
            ? sourcesGateState(tx, versionId)
            : sourceStudyGateState(tx, versionId, skillId);
  if (
    !(await listWorkflowVersions(database, workflow.id)).some(
      (version) => version.id === versionId,
    )
  )
    return reply.error(404, "invalid", "No such workflow version");
  if (match[5] === undefined) {
    const confirmations = await readGateConfirmations(
      database,
      versionId,
      gate,
    );
    return reply.json(200, {
      confirmation: confirmations[0] ?? null,
      confirmations,
    });
  }
  if (
    !(gate === "proposal"
      ? capabilities.approveProposal
      : gate === "plan"
        ? capabilities.approvePlan
        : gate === "dossier"
          ? capabilities.approveDossier
          : skillId === undefined
            ? capabilities.confirmSources
            : capabilities.manageSourceStudy)
  )
    return reply.error(
      403,
      "denied",
      gate === "proposal"
        ? "Only a signed-in Workflow owner or Administrator approves a proposal"
        : gate === "plan"
          ? "Only a signed-in Workflow owner or Administrator approves a plan"
          : gate === "dossier"
            ? "Only a signed-in Workflow owner or Administrator approves a dossier"
            : "Only a signed-in Administrator or Engineer confirms a source or study gate",
    );
  const body = await readJsonBody(request);
  if (!body.ok) return reply.error(400, "invalid", body.message);
  const value = objectInput(body.value);
  if (match[5] === "preview") {
    if (Object.keys(value).length > 0)
      throw new RequestError(400, "The preview takes an empty object");
    const state = await database.transaction(async (tx) => {
      await tx.query(
        "select id from workflow_versions where id = $1 for update",
        [versionId],
      );
      return loadState(tx);
    });
    if (state.findings.length > 0)
      return reply.json(409, {
        error: { code: "rejected", message: state.findings[0]!.message },
        findings: state.findings,
        requestId: reply.requestId,
      });
    return reply.json(200, { preview: state.preview });
  }
  if (
    Object.keys(value).some(
      (key) => !["confirmationHash", "requestId"].includes(key),
    ) ||
    typeof value.confirmationHash !== "string" ||
    !/^[a-f0-9]{64}$/u.test(value.confirmationHash) ||
    typeof value.requestId !== "string" ||
    !/^[A-Za-z0-9._-]{1,100}$/u.test(value.requestId)
  )
    throw new RequestError(
      400,
      "Quote confirmationHash and a client requestId of 1 to 100 letters, digits, dots, underscores, or hyphens",
    );
  const result = await commitGate(
    database,
    dependencies,
    context,
    versionId,
    gate,
    { confirmationHash: value.confirmationHash, requestId: value.requestId },
    loadState,
  );
  if (result.kind === "conflict")
    return reply.error(
      409,
      "conflict",
      "The gate or its bound records changed, or the request ID was already used; preview again",
    );
  if (result.kind === "rejected")
    return reply.json(409, {
      error: { code: "rejected", message: result.findings[0]!.message },
      findings: result.findings,
      requestId: reply.requestId,
    });
  return reply.json(200, result.result);
}
