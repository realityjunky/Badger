import {
  reviewView,
  reviewGateState,
  recordPackageSignOff,
  listPublishedPackages,
  readPublishedPackage,
} from "../publications.js";
import { commitGate, invalidateGate } from "../gates.js";
import type { Queryable } from "../database/database.js";
import { workflowCapabilities } from "../workflow-access.js";
import {
  listWorkflows,
  listWorkflowVersions,
  readWorkflow,
} from "../workflows.js";
import type { AuthorizedRequest } from "./authorized-request.js";
import { objectInput, RequestError } from "./errors.js";
import { readJsonBody } from "./body.js";
import { fields } from "../questionnaire/model.js";

const REVIEW =
  /^\/api\/v1\/workflows\/([^/]+)\/versions\/([^/]+)\/review(?:\/(approve-preview|approve|publish-preview|publish))?$/u;
const PUBLISHED =
  /^\/api\/v1\/workflows\/([^/]+)\/publications(?:\/([^/]+)\/package)?$/u;
export const publicationMethods = (path: string) => {
  if (path === "/api/v1/publications") return "GET, HEAD";
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
  if (input.path === "/api/v1/publications") {
    const result = await input.database.transaction(async (tx) => {
      const available = [];
      for (const workflow of await listWorkflows(
        tx,
        input.access,
        input.person,
      )) {
        const caps = await workflowCapabilities(
          tx,
          input.access,
          input.person,
          workflow,
        );
        if (!caps.read || !caps.readPublished) continue;
        const publications = await listPublishedPackages(tx, workflow.id);
        if (publications.length)
          available.push({
            id: workflow.id,
            name: workflow.name,
            publications,
          });
      }
      return { workflows: available };
    });
    return input.reply.json(200, result);
  }
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
        ? []
        : ["confirmed", "confirmationHash", "requestId"],
    );
  }
  const approve = action?.startsWith("approve") ?? false;
  const authorize = async (tx: Queryable) => {
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
    if (action && !caps.publish)
      throw new RequestError(
        403,
        "Only a signed-in Workflow owner or Administrator approves or publishes a package",
      );
    return caps;
  };
  const loadState = async (tx: Queryable) => {
    await authorize(tx);
    return reviewGateState(
      tx,
      input.config,
      versionId,
      input.person.id,
      approve ? "package" : "publication",
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
    await authorize(input.database);
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
            ["Workflow owner"],
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
    const caps = await authorize(tx);
    return {
      ...(await reviewView(tx, input.config, versionId)),
      publications: await listPublishedPackages(tx, workflowId),
      canPublish: caps.publish,
    };
  });
  input.reply.json(200, result);
}
