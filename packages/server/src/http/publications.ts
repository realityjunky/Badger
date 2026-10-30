import { isAdministrator } from "../authorization.js";
import {
  acceptedAuthoring,
  reviewView,
  reviewGateState,
  recordPackageSignOff,
  listPublishedPackages,
  readPublishedPackage,
} from "../publications.js";
import { commitGate, invalidateGate } from "../gates.js";
import type { Queryable } from "../database/database.js";
import { workflowCapabilities } from "../workflow-access.js";
import { listWorkflowVersions, readWorkflow } from "../workflows.js";
import type { AuthorizedRequest } from "./authorized-request.js";
import { objectInput, RequestError } from "./errors.js";
import { readJsonBody } from "./body.js";
import { fields } from "../questionnaire/model.js";

const REVIEW =
  /^\/api\/v1\/workflows\/([^/]+)\/versions\/([^/]+)\/review(?:\/(approve-preview|approve|publish-preview|publish))?$/u;
const PUBLISHED =
  /^\/api\/v1\/workflows\/([^/]+)\/publications(?:\/([^/]+)\/package)?$/u;
export const publicationMethods = (path: string) => {
  const match = REVIEW.exec(path);
  return match
    ? match[3]
      ? "POST"
      : "GET, HEAD"
    : PUBLISHED.test(path)
      ? "GET, HEAD"
      : null;
};
export async function handlePublications(input: AuthorizedRequest) {
  const methods = publicationMethods(input.path)!;
  if (!methods.split(", ").includes(input.method))
    return input.reply.error(405, "invalid", "Method not allowed", {
      allow: methods,
    });
  const published = PUBLISHED.exec(input.path);
  if (published) {
    const workflowId = decodeURIComponent(published[1]);
    const result = await input.database.transaction(async (tx) => {
      const workflow = await readWorkflow(tx, workflowId);
      if (!workflow) throw new RequestError(404, "No such workflow");
      const caps = await workflowCapabilities(
        tx,
        input.access,
        input.person,
        workflow,
      );
      if (!caps.read || !caps.readPublished)
        throw new RequestError(
          403,
          "Published packages require workflow visibility and an Operator or test Engineer role for tokens",
        );
      return published[2]
        ? readPublishedPackage(
            tx,
            workflowId,
            decodeURIComponent(published[2]),
            input.url.searchParams.get("packageHash") ?? undefined,
          )
        : { publications: await listPublishedPackages(tx, workflowId) };
    });
    return input.reply.json(200, result);
  }
  const [, rawWorkflow, rawVersion, action] = REVIEW.exec(input.path)!;
  const workflowId = decodeURIComponent(rawWorkflow),
    versionId = decodeURIComponent(rawVersion);
  let body: Record<string, unknown> = {};
  if (action) {
    const parsed = await readJsonBody(input.request);
    if (!parsed.ok) throw new RequestError(400, parsed.message);
    body = objectInput(parsed.value);
    fields(
      body,
      action.endsWith("preview")
        ? ["overrideReason"]
        : ["confirmed", "confirmationHash", "requestId", "overrideReason"],
    );
  }
  const reason = body.overrideReason;
  if (
    reason !== undefined &&
    (typeof reason !== "string" ||
      reason.trim().length === 0 ||
      reason.trim().length > 2000)
  )
    throw new RequestError(
      400,
      "An override reason must contain 1 to 2000 characters",
    );
  const overrideReason = typeof reason === "string" ? reason.trim() : null;
  const approve = action?.startsWith("approve") ?? false;
  const authorize = async (tx: Queryable, independence: boolean) => {
    const workflow = await readWorkflow(tx, workflowId);
    if (
      !workflow ||
      !(await listWorkflowVersions(tx, workflowId)).some(
        (v) => v.id === versionId,
      )
    )
      throw new RequestError(404, "No such workflow version");
    const caps = await workflowCapabilities(
      tx,
      input.access,
      input.person,
      workflow,
    );
    if (!caps.read)
      throw new RequestError(403, "This workflow is outside your roles");
    const administrator =
      isAdministrator(input.access) && input.access.tokenScopes === undefined;
    if (action) {
      if (!(approve ? caps.approvePackage : caps.publish))
        throw new RequestError(
          403,
          approve
            ? "Only a signed-in Reviewer approves a package"
            : "Only a signed-in Workflow owner publishes a package",
        );
      if (reason !== undefined && (!approve || !administrator))
        throw new RequestError(
          403,
          "Only an Administrator may override Reviewer independence",
        );
      if (
        independence &&
        approve &&
        (await acceptedAuthoring(tx, versionId, input.person.id)) &&
        !(administrator && overrideReason)
      )
        throw new RequestError(
          403,
          "A Reviewer who accepted any Authoring lane for this Workflow version cannot approve it; an Administrator must record an override reason",
        );
    }
    return { caps, administrator };
  };
  const loadState = async (tx: Queryable) => {
    await authorize(tx, true);
    return reviewGateState(
      tx,
      input.config,
      versionId,
      input.person.id,
      approve ? "package" : "publication",
      overrideReason,
    );
  };
  if (action && !action.endsWith("preview")) {
    if (
      body.confirmed !== true ||
      typeof body.confirmationHash !== "string" ||
      !/^[a-f0-9]{64}$/u.test(body.confirmationHash) ||
      typeof body.requestId !== "string" ||
      !/^[A-Za-z0-9._-]{1,100}$/u.test(body.requestId)
    )
      throw new RequestError(
        400,
        "Confirm sign-off with the exact preview confirmationHash and a request ID",
      );
    await authorize(input.database, false);
    const result = await commitGate(
      input.database,
      input.dependencies,
      input.context,
      versionId,
      approve ? "package" : "publication",
      { confirmationHash: body.confirmationHash, requestId: body.requestId },
      loadState,
      async (tx, active, state) => {
        if (
          !approve ||
          [
            "package",
            "generation",
            "creatorState",
            "evaluation",
            "readiness",
          ].every(
            (key) => active.boundHashes[key] === state.preview.boundHashes[key],
          )
        )
          return false;
        for (const gate of ["package", "publication"])
          await invalidateGate(
            tx,
            input.dependencies,
            input.context,
            versionId,
            gate,
            "Current package review evidence changed",
            ["Reviewer", "Workflow owner"],
          );
        return true;
      },
      (tx, confirmation) =>
        recordPackageSignOff(
          tx,
          input.config,
          input.dependencies,
          input.context,
          versionId,
          confirmation,
          input.person.displayName,
          overrideReason,
        ),
    );
    if (result.kind === "conflict")
      throw new RequestError(
        409,
        "The package or its evidence changed; preview sign-off again",
      );
    if (result.kind === "rejected")
      throw new RequestError(409, result.findings[0].message, {
        findings: result.findings,
      });
    return input.reply.json(200, result.result);
  }
  const result = await input.database.transaction(async (tx) => {
    if (action) {
      await tx.query(
        "select id from workflow_versions where id=$1 for no key update",
        [versionId],
      );
      const state = await loadState(tx);
      if (state.findings.length)
        throw new RequestError(409, state.findings[0].message, {
          findings: state.findings,
        });
      return { preview: state.preview };
    }
    const { caps, administrator } = await authorize(tx, false);
    return {
      ...(await reviewView(tx, input.config, versionId)),
      publications: await listPublishedPackages(tx, workflowId),
      canReview: caps.approvePackage,
      canPublish: caps.publish,
      requiresOverride: await acceptedAuthoring(tx, versionId, input.person.id),
      canOverride: administrator,
    };
  });
  input.reply.json(200, result);
}
