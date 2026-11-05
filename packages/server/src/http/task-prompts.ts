import { PROMPT_STAGES, promptTemplateCatalog } from "@realityjunky/badger";
import { isAdministrator } from "../authorization.js";
import { readQuestions } from "../questionnaire/store.js";
import { readAnswers } from "../questionnaire/answers.js";
import { questionnaireCapabilities } from "../questionnaire/access.js";
import { readWorkflow, listWorkflowVersions } from "../workflows.js";
import { workflowCapabilities } from "../workflow-access.js";
import { listWorkflowPins } from "../workflow-source.js";
import { readVersion } from "../skills/library.js";
import { assemblePrompt, readPromptTemplate } from "../prompt-templates.js";
import type { AuthorizedRequest } from "./authorized-request.js";
import { RequestError } from "./errors.js";

const ANSWER =
  /^\/api\/v1\/workflows\/([^/]+)\/versions\/([^/]+)\/questionnaire\/questions\/([^/]+)\/prompt$/u;
const STAGE =
  /^\/api\/v1\/workflows\/([^/]+)\/versions\/([^/]+)\/stage-prompts\/([^/]+)$/u;

export function taskPromptMethods(path: string) {
  return ANSWER.test(path) || STAGE.test(path) ? "GET, HEAD" : null;
}

export async function handleTaskPrompts(input: AuthorizedRequest) {
  const answerMatch = ANSWER.exec(input.path);
  const match = answerMatch ?? STAGE.exec(input.path)!;
  const workflowId = decodeURIComponent(match[1]!);
  const versionId = decodeURIComponent(match[2]!);
  const target = decodeURIComponent(match[3]!);
  const result = await input.database.transaction(async (tx) => {
    await tx.query("select id from workflows where id = $1 for no key update", [
      workflowId,
    ]);
    await tx.query(
      "select id from workflow_versions where id = $1 and workflow_id = $2 for no key update",
      [versionId, workflowId],
    );
    const workflow = await readWorkflow(tx, workflowId);
    const version = (await listWorkflowVersions(tx, workflowId)).find(
      (entry) => entry.id === versionId,
    );
    if (!workflow || !version)
      throw new RequestError(404, "No such workflow version");
    if (
      !(await workflowCapabilities(tx, input.access, input.person, workflow))
        .read
    )
      throw new RequestError(403, "This workflow is outside your access");
    if (answerMatch) {
      const capabilities = await questionnaireCapabilities(
        tx,
        input.access,
        input.person,
        workflowId,
      );
      const question = (
        await readQuestions(tx, versionId, input.person.id, false)
      ).find((entry) => entry.id === target);
      if (!question) throw new RequestError(404, "No such published question");
      if (!capabilities.answer || !question.canAnswer)
        throw new RequestError(
          403,
          "Only a current assignee may get answer assistance for this question",
        );
      const answer =
        (await readAnswers(tx, versionId, input.person.id)).find(
          (entry) =>
            entry.questionId === target && entry.personId === input.person.id,
        ) ?? null;
      const template = await readPromptTemplate(tx, "answer-assistance");
      const task = {
        workflowId,
        versionId,
        questionId: question.id,
        questionRevision: question.revision,
        answerRevision: answer?.revision ?? 0,
        workflow: {
          name: version.name,
          goal: version.goal,
          locale: version.locale,
        },
        question,
        answer,
      };
      return {
        ...task,
        template,
        prompt: assemblePrompt(
          template,
          task,
          "The user requests help answering this exact assigned question. Start with answer_context to refresh its revisions. Ask for their knowledge before drafting; saving or submitting requires their instruction. Do not answer on their behalf from assumptions.",
        ),
      };
    }
    if (input.context.credential.kind === "token")
      throw new RequestError(
        403,
        "Stage review guidance is for signed-in people",
      );
    if (!(PROMPT_STAGES as readonly string[]).includes(target))
      throw new RequestError(404, "No such stage");
    const roles = (
      await tx.query<{ role: string }>(
        "select role from role_bindings where workflow_id = $1 and person_id = $2",
        [workflowId, input.person.id],
      )
    ).rows.map((entry) => entry.role);
    if (target === "source-study") {
      for (const pin of await listWorkflowPins(tx, versionId))
        if (
          (await readVersion(tx, pin.skillId, pin.hash)).uploadedBy ===
          input.person.id
        ) {
          roles.push("Skill uploader");
          break;
        }
    }
    const definitions = promptTemplateCatalog().filter(
      (entry) =>
        entry.stage === target &&
        entry.scenario === "human-review" &&
        (isAdministrator(input.access) ||
          entry.audience.some((role) => roles.includes(role))),
    );
    if (!definitions.length)
      throw new RequestError(
        403,
        "This stage's review guidance is outside your role",
      );
    const guidance = [];
    for (const definition of definitions)
      guidance.push(await readPromptTemplate(tx, definition.id));
    return {
      guidance,
      stage: version.stages.find((stage) => stage.id === target),
    };
  });
  input.reply.json(200, result);
}
