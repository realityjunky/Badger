import {
  canonicalHash,
  promptTemplateCatalog,
  PROMPT_GUARDRAILS,
} from "@realityjunky/badger";
import { isAdministrator } from "../authorization.js";
import { recordAudit } from "../audit.js";
import { readPromptTemplate } from "../prompt-templates.js";
import { fields, revisionInput, textInput } from "../questionnaire/model.js";
import type { AuthorizedRequest } from "./authorized-request.js";
import { readJsonBody } from "./body.js";
import { objectInput, RequestError } from "./errors.js";

const PATH =
  /^\/api\/v1\/admin\/prompt-templates(?:\/([^/]+)(?:\/(preview|history))?)?$/u;

export function promptTemplateMethods(path: string) {
  const match = PATH.exec(path);
  if (!match) return null;
  return match[2] === "preview"
    ? "POST"
    : match[1] && !match[2]
      ? "GET, HEAD, PUT"
      : "GET, HEAD";
}

export async function handlePromptTemplates(input: AuthorizedRequest) {
  if (
    input.context.credential.kind === "token" ||
    !isAdministrator(input.access)
  )
    throw new RequestError(
      403,
      "Only signed-in Administrators manage prompt templates",
    );
  const [, rawId, action] = PATH.exec(input.path)!;
  const id = rawId ? decodeURIComponent(rawId) : null;
  if (!id) {
    const templates = [];
    for (const definition of promptTemplateCatalog())
      templates.push(await readPromptTemplate(input.database, definition.id));
    input.reply.json(200, { templates, guardrails: PROMPT_GUARDRAILS });
    return;
  }
  if (input.method === "GET" || input.method === "HEAD") {
    const template = await readPromptTemplate(input.database, id);
    const history =
      action === "history"
        ? (
            await input.database.query(
              'select revision, body, content_hash as hash, person_id as "personId", created_at as "createdAt" from prompt_template_revisions where template_id = $1 order by revision desc',
              [id],
            )
          ).rows
        : undefined;
    input.reply.json(200, { template, ...(history ? { history } : {}) });
    return;
  }
  const parsed = await readJsonBody(input.request, 160000);
  if (!parsed.ok) throw new RequestError(parsed.status ?? 400, parsed.message);
  const body = objectInput(parsed.value);
  fields(
    body,
    action === "preview"
      ? ["revision", "body"]
      : ["revision", "body", "confirmed", "confirmationHash"],
  );
  const revision = revisionInput(body.revision, 0);
  const content = textInput(body.body, "template body", 30000);
  const result = await input.database.transaction(async (tx) => {
    if (action !== "preview") {
      await tx.query(
        "insert into prompt_template_heads (template_id, revision) values ($1,0) on conflict do nothing",
        [id],
      );
      await tx.query(
        "select template_id from prompt_template_heads where template_id = $1 for update",
        [id],
      );
    }
    const current = await readPromptTemplate(tx, id);
    if (revision !== current.revision)
      throw new RequestError(
        409,
        "The template changed. Reload before saving your edits.",
      );
    const confirmationHash = canonicalHash({
      id,
      revision,
      previousHash: current.hash,
      body: content,
    });
    if (action === "preview")
      return { template: { ...current, body: content }, confirmationHash };
    if (body.confirmed !== true || body.confirmationHash !== confirmationHash)
      throw new RequestError(
        409,
        "Preview and explicitly confirm this exact template revision before saving",
      );
    const nextRevision = revision + 1;
    const hash = canonicalHash({ id, revision: nextRevision, body: content });
    await tx.query(
      "insert into prompt_template_revisions (template_id, revision, body, content_hash, person_id, created_at) values ($1,$2,$3,$4,$5,$6)",
      [
        id,
        nextRevision,
        content,
        hash,
        input.person.id,
        input.dependencies.clock.now(),
      ],
    );
    await tx.query(
      "update prompt_template_heads set revision = $2 where template_id = $1",
      [id, nextRevision],
    );
    await recordAudit(tx, input.dependencies, {
      actor: input.context,
      channel: input.context.channel,
      requestId: input.context.requestId,
      action: "prompt-template.saved",
      target: { type: "prompt-template", id, label: current.title },
      before: {
        revision: revision === 0 ? null : revision,
        hash: current.hash,
      },
      after: { revision: nextRevision, hash },
      reason: null,
    });
    return {
      template: { ...current, revision: nextRevision, body: content, hash },
    };
  });
  input.reply.json(200, result);
}
