import { publicDraftingJob } from "../drafting/jobs.js";
import {
  authoringView,
  requestLaneJobs,
  assemblyPreview,
  assembleCurrentPackage,
} from "../authoring.js";
import {
  enqueueGeneration,
  packageFile,
  packageView,
  type GenerationInput,
} from "../packages.js";
import { workflowCapabilities } from "../workflow-access.js";
import { listWorkflowVersions, readWorkflow } from "../workflows.js";
import type { AuthorizedRequest } from "./authorized-request.js";
import { objectInput, RequestError } from "./errors.js";
import { readJsonBody } from "./body.js";
import { fields } from "../questionnaire/model.js";

const PATH =
  /^\/api\/v1\/workflows\/([^/]+)\/versions\/([^/]+)\/package(?:\/(generate|file|authoring|authoring-jobs|assemble-preview|assemble))?$/u;
export function packageMethods(path: string): string | null {
  const match = PATH.exec(path);
  return match
    ? ["generate", "authoring-jobs", "assemble-preview", "assemble"].includes(
        match[3] ?? "",
      )
      ? "POST"
      : "GET, HEAD"
    : null;
}
export async function handlePackage(input: AuthorizedRequest) {
  const { database, person, access, config } = input;
  const methods = packageMethods(input.path)!;
  if (!methods.split(", ").includes(input.method))
    return input.reply.error(405, "invalid", "Method not allowed", {
      allow: methods,
    });
  const [, workflow, version, action] = PATH.exec(input.path)!;
  const workflowId = decodeURIComponent(workflow),
    versionId = decodeURIComponent(version);
  let generation: GenerationInput | undefined;
  let authoringInput: Record<string, unknown> = {};
  if (
    ["authoring-jobs", "assemble-preview", "assemble"].includes(action ?? "")
  ) {
    const parsed = await readJsonBody(input.request);
    if (!parsed.ok) throw new RequestError(400, parsed.message);
    authoringInput = objectInput(parsed.value);
    fields(
      authoringInput,
      action === "assemble-preview"
        ? []
        : action === "assemble"
          ? ["confirmed", "confirmationHash", "requestId"]
          : ["confirmed"],
    );
  }
  if (action === "generate") {
    const parsed = await readJsonBody(input.request);
    if (!parsed.ok) throw new RequestError(400, parsed.message);
    const value = objectInput(parsed.value);
    fields(value, ["confirmationHash", "stateHash", "confirmed", "requestId"]);
    if (
      value.confirmed !== true ||
      ![value.confirmationHash, value.stateHash].every(
        (v) => typeof v === "string" && /^[a-f0-9]{64}$/u.test(v),
      ) ||
      typeof value.requestId !== "string" ||
      !/^[A-Za-z0-9._-]{1,100}$/u.test(value.requestId)
    )
      throw new RequestError(
        400,
        "Confirm generation with confirmationHash, stateHash, and requestId",
      );
    generation = value as unknown as GenerationInput;
  }
  const result = await database
    .transaction(async (tx) => {
      if (action === "assemble")
        await tx.query("select id from people where id=$1 for no key update", [
          person.id,
        ]);
      await tx.query(
        "select id from workflow_versions where id = $1 for no key update",
        [versionId],
      );
      const record = await readWorkflow(tx, workflowId);
      if (
        !record ||
        !(await listWorkflowVersions(tx, workflowId)).some(
          (v) => v.id === versionId,
        )
      )
        throw new RequestError(404, "No such workflow version");
      const caps = await workflowCapabilities(tx, access, person, record);
      if (!caps.read)
        throw new RequestError(403, "This workflow is outside your roles");
      if (
        [
          "authoring",
          "authoring-jobs",
          "assemble-preview",
          "assemble",
        ].includes(action ?? "")
      ) {
        if (action === "authoring") return authoringView(tx, config, versionId);
        if (!caps.generate)
          throw new RequestError(
            403,
            "Only a signed-in Engineer manages Authoring and assembly",
          );
        if (action === "assemble-preview")
          return {
            preview: await assemblyPreview(tx, config, versionId, person.id),
          };
        if (authoringInput.confirmed !== true)
          throw new RequestError(400, "Confirm the Authoring action");
        if (action === "authoring-jobs")
          return {
            jobs: (
              await requestLaneJobs(
                tx,
                config,
                input.dependencies,
                { ...input.context, agentHost: null },
                workflowId,
                versionId,
              )
            ).map((j) => publicDraftingJob(j)),
          };
        if (
          typeof authoringInput.confirmationHash !== "string" ||
          typeof authoringInput.requestId !== "string" ||
          !/^[A-Za-z0-9._-]{1,100}$/u.test(authoringInput.requestId)
        )
          throw new RequestError(
            400,
            "Quote the assembly confirmation hash and a request ID",
          );
        return assembleCurrentPackage(
          tx,
          config,
          input.dependencies,
          input.context,
          versionId,
          {
            confirmationHash: authoringInput.confirmationHash,
            requestId: authoringInput.requestId,
          },
        );
      }
      if (generation) {
        if (!caps.generate)
          throw new RequestError(
            403,
            "Only a signed-in Engineer or Administrator generates a package",
          );
        return {
          job: await enqueueGeneration(
            tx,
            config,
            input.dependencies,
            input.context,
            versionId,
            generation,
          ),
        };
      }
      if (action === "file")
        return packageFile(
          tx,
          config,
          versionId,
          input.url.searchParams.get("path") ?? "",
        );
      return packageView(tx, config, versionId, person.id);
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
          "The generation request ID was already used; reload its job",
        );
      throw error;
    });
  input.reply.json(
    generation ? 202 : action === "authoring-jobs" ? 201 : 200,
    result,
  );
}
