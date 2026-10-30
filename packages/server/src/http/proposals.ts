import {
  enqueueInitialization,
  proposalView,
  type InitializationInput,
} from "../proposals.js";
import { workflowCapabilities } from "../workflow-access.js";
import { listWorkflowVersions, readWorkflow } from "../workflows.js";
import type { AuthorizedRequest } from "./authorized-request.js";
import { objectInput, RequestError } from "./errors.js";
import { readJsonBody } from "./body.js";
import { fields } from "../questionnaire/model.js";

const PATH =
  /^\/api\/v1\/workflows\/([^/]+)\/versions\/([^/]+)\/proposal(?:\/(initialize))?$/u;

export function proposalMethods(path: string): string | null {
  const match = PATH.exec(path);
  return match ? (match[3] ? "POST" : "GET, HEAD") : null;
}

export async function handleProposal(input: AuthorizedRequest) {
  const { database, person, access, config } = input;
  const methods = proposalMethods(input.path)!;
  if (!methods.split(", ").includes(input.method))
    return input.reply.error(405, "invalid", "Method not allowed", {
      allow: methods,
    });
  const [, rawWorkflow, rawVersion, action] = PATH.exec(input.path)!;
  const workflowId = decodeURIComponent(rawWorkflow!);
  const versionId = decodeURIComponent(rawVersion!);
  let initialization: InitializationInput | undefined;
  if (action) {
    const parsed = await readJsonBody(input.request);
    if (!parsed.ok) throw new RequestError(400, parsed.message);
    const value = objectInput(parsed.value);
    fields(value, [
      "proposalHash",
      "replaceStateHash",
      "requestId",
      "confirmed",
    ]);
    if (
      value.confirmed !== true ||
      typeof value.proposalHash !== "string" ||
      !/^[a-f0-9]{64}$/u.test(value.proposalHash) ||
      typeof value.requestId !== "string" ||
      !/^[A-Za-z0-9._-]{1,100}$/u.test(value.requestId) ||
      (value.replaceStateHash !== undefined &&
        (typeof value.replaceStateHash !== "string" ||
          !/^[a-f0-9]{64}$/u.test(value.replaceStateHash)))
    )
      throw new RequestError(
        400,
        "Confirm initialization with proposalHash, requestId, and the current replaceStateHash when replacing state",
      );
    initialization = value as unknown as InitializationInput;
  }
  const view = await database
    .transaction(async (tx) => {
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
      if (initialization) {
        if (!caps.initialize)
          throw new RequestError(
            403,
            "Only a signed-in Engineer or Administrator initializes a project",
          );
        return {
          job: await enqueueInitialization(
            tx,
            config,
            input.dependencies,
            input.context,
            versionId,
            initialization,
          ),
        };
      }
      return proposalView(tx, config, versionId, person.id);
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
          "The initialization request ID was already used; reload its job",
        );
      throw error;
    });
  input.reply.json(action ? 202 : 200, view);
}
