import { composeFactoryPlan } from "@realityjunky/badger";
import {
  planInputs,
  planView,
  requirePlanInputs,
  storePlan,
} from "../plans.js";
import { workflowCapabilities } from "../workflow-access.js";
import { listWorkflowVersions, readWorkflow } from "../workflows.js";
import { fields } from "../questionnaire/model.js";
import type { AuthorizedRequest } from "./authorized-request.js";
import { readJsonBody } from "./body.js";
import { objectInput, RequestError } from "./errors.js";

const PATH =
  /^\/api\/v1\/workflows\/([^/]+)\/versions\/([^/]+)\/plan(?:\/(preview|save))?$/u;
export function planMethods(path: string): string | null {
  const match = PATH.exec(path);
  return match === null ? null : match[3] ? "POST" : "GET, HEAD";
}
export async function handlePlan(input: AuthorizedRequest) {
  const { database, person, access, context, dependencies, reply } = input;
  const methods = planMethods(input.path)!;
  if (!methods.split(", ").includes(input.method))
    return reply.error(405, "invalid", "Method not allowed", {
      allow: methods,
    });
  const [, rawWorkflow, rawVersion, action] = PATH.exec(input.path)!;
  const workflowId = decodeURIComponent(rawWorkflow!);
  const versionId = decodeURIComponent(rawVersion!);
  let value: Record<string, unknown> = {};
  if (action) {
    const parsed = await readJsonBody(input.request, 1024 * 1024 + 16384);
    if (!parsed.ok)
      throw new RequestError(parsed.status ?? 400, parsed.message);
    value = objectInput(parsed.value);
    fields(value, [
      "plan",
      "dossierHash",
      ...(action === "save" ? ["confirmationHash", "expectedVersionId"] : []),
    ]);
  }
  const result = await database.transaction(async (tx) => {
    await tx.query(
      "select id from workflow_versions where id = $1 for update",
      [versionId],
    );
    const workflow = await readWorkflow(tx, workflowId);
    if (
      !workflow ||
      !(await listWorkflowVersions(tx, workflowId)).some(
        (v) => v.id === versionId,
      )
    )
      throw new RequestError(404, "No such workflow version");
    const caps = await workflowCapabilities(tx, access, person, workflow);
    if (!caps.read)
      throw new RequestError(403, "This workflow is outside your roles");
    if (!action)
      return { status: 200, value: await planView(tx, versionId, person.id) };
    if (!caps.editPlan)
      throw new RequestError(
        403,
        "Only a signed-in Engineer or Administrator edits a plan",
      );
    const inputs = requirePlanInputs(
      await planInputs(tx, versionId, person.id),
      value.dossierHash,
    );
    const composition = composeFactoryPlan(inputs, value.plan);
    if (action === "preview") return { status: 200, value: { composition } };
    if (composition.hash !== value.confirmationHash)
      throw new RequestError(409, "The plan changed; preview it again");
    const stored = await storePlan(
      tx,
      dependencies,
      context,
      composition,
      value.expectedVersionId,
    );
    return {
      status: stored.changed ? 201 : 200,
      value: { version: stored.version },
    };
  });
  reply.json(result.status, result.value);
}
