import { isAdministrator } from "../authorization.js";
import {
  configurationView,
  readConfiguration,
  readConfigurationFile,
  saveConfiguration,
} from "../llm/store.js";
import { callModel, RESPONSE_RULES } from "../llm/provider.js";
import type { AuthorizedRequest } from "./authorized-request.js";
import { readJsonBody } from "./body.js";
import { objectInput, RequestError } from "./errors.js";

export function llmMethods(path: string): string | null {
  if (path === "/api/v1/admin/llm") return "GET, HEAD, PUT";
  if (/^\/api\/v1\/admin\/llm\/(reload|test)$/u.test(path)) return "POST";
  return null;
}

export async function handleLlm(input: AuthorizedRequest) {
  const {
    database,
    config,
    dependencies,
    context,
    access,
    reply,
    path,
    method,
    request,
  } = input;
  if (!isAdministrator(access) || context.credential.kind === "token")
    throw new RequestError(
      403,
      "Only a signed-in Organization Administrator may manage or test LLM configuration",
    );
  if (method === "GET" || method === "HEAD")
    return reply.json(200, await configurationView(database, config));
  const read = await readJsonBody(request, 262144);
  if (!read.ok) return reply.error(read.status ?? 400, "invalid", read.message);
  let body = objectInput(read.value);
  if (path.endsWith("/reload")) {
    const file = await readConfigurationFile(config);
    if (file.revision !== body.revision)
      throw new RequestError(
        409,
        "The file and dashboard must quote the same current revision",
      );
    body = file;
  }
  if (path.endsWith("/test")) {
    const current = await readConfiguration(database);
    if (body.revision !== current.revision)
      throw new RequestError(
        409,
        "Configuration changed; reload before testing",
      );
    const model = current.configuration.models.find(
      (model) => model.id === body.modelId,
    );
    if (!model)
      throw new RequestError(400, "Select a saved model connection to test");
    const result = await callModel(
      database,
      config,
      current.configuration,
      model,
      context.personId,
      [
        { role: "system", content: RESPONSE_RULES },
        {
          role: "user",
          content:
            'Connection test with no source scripts: return exactly {"scripts":[]}.',
        },
      ],
    );
    if (JSON.stringify(result) !== '{"scripts":[]}')
      throw new RequestError(
        400,
        "Connection responded but did not follow the required JSON response; check provider structured-output support",
      );
    if ((await readConfiguration(database)).revision !== current.revision)
      throw new RequestError(
        409,
        "Configuration changed during the test; test the current revision",
      );
    return reply.json(200, {
      revision: current.revision,
      status: "accepted",
      message:
        "The provider accepted the configured request and returned valid JSON. Confirm effective upstream settings in the deployment; live capability verification is separate.",
    });
  }
  return reply.json(
    200,
    await saveConfiguration(
      database,
      config,
      dependencies,
      { ...context, personId: context.personId },
      body,
    ),
  );
}
