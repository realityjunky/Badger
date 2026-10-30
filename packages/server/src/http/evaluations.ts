import { evaluationView, enqueueEvaluation } from "../evaluations.js";
import { workflowCapabilities } from "../workflow-access.js";
import { listWorkflowVersions, readWorkflow } from "../workflows.js";
import type { AuthorizedRequest } from "./authorized-request.js";
import { objectInput, RequestError } from "./errors.js";
import { readJsonBody } from "./body.js";
import { fields } from "../questionnaire/model.js";
const PATH = /^\/api\/v1\/workflows\/([^/]+)\/versions\/([^/]+)\/evaluations$/u;
export const evaluationMethods = (path: string) =>
  PATH.test(path) ? "GET, HEAD, POST" : null;
export async function handleEvaluations(input: AuthorizedRequest) {
  if (!["GET", "HEAD", "POST"].includes(input.method))
    return input.reply.error(405, "invalid", "Method not allowed", {
      allow: "GET, HEAD, POST",
    });
  const [, workflow, version] = PATH.exec(input.path)!;
  const workflowId = decodeURIComponent(workflow),
    versionId = decodeURIComponent(version);
  let request: { packageHash: string; requestId: string } | undefined;
  if (input.method === "POST") {
    const parsed = await readJsonBody(input.request);
    if (!parsed.ok) throw new RequestError(400, parsed.message);
    const body = objectInput(parsed.value);
    fields(body, ["confirmed", "packageHash", "requestId"]);
    if (
      body.confirmed !== true ||
      typeof body.packageHash !== "string" ||
      !/^[a-f0-9]{64}$/u.test(body.packageHash) ||
      typeof body.requestId !== "string" ||
      !/^[A-Za-z0-9._-]{1,100}$/u.test(body.requestId)
    )
      throw new RequestError(
        400,
        "Confirm evaluation with the package hash and a request ID",
      );
    request = { packageHash: body.packageHash, requestId: body.requestId };
  }
  const result = await input.database
    .transaction(async (tx) => {
      if (request)
        await tx.query(
          "select id from workflow_versions where id=$1 for no key update",
          [versionId],
        );
      const record = await readWorkflow(tx, workflowId);
      if (
        !record ||
        !(await listWorkflowVersions(tx, workflowId)).some(
          (version) => version.id === versionId,
        )
      )
        throw new RequestError(404, "No such workflow version");
      const caps = await workflowCapabilities(
        tx,
        input.access,
        input.person,
        record,
      );
      if (!caps.read)
        throw new RequestError(403, "This workflow is outside your roles");
      if (request) {
        if (!caps.generate)
          throw new RequestError(
            403,
            "Only a signed-in Engineer starts an evaluation",
          );
        return {
          job: await enqueueEvaluation(
            tx,
            input.config,
            input.dependencies,
            input.context,
            versionId,
            request,
          ),
        };
      }
      return {
        ...(await evaluationView(tx, input.config, versionId)),
        canEvaluate: caps.generate,
      };
    })
    .catch((error: unknown) => {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "23505"
      )
        throw new RequestError(
          409,
          "The evaluation request ID was already used; reload its job",
        );
      throw error;
    });
  input.reply.json(request ? 202 : 200, result);
}
