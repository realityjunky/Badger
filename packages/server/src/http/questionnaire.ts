import {
  parseResolution,
  resolutionPreview,
  resolveQuestion,
  readResolutions,
  readFacts,
  parseAcknowledgement,
  acknowledgementPreview,
  acknowledgeFact,
} from "../questionnaire/resolutions.js";
import { isAdministrator } from "../authorization.js";
import { readLedger, snapshotRoundLedger } from "../questionnaire/ledger.js";
import { readDraft, readDrafts, saveDraft } from "../questionnaire/drafts.js";
import { RequestError, objectInput } from "./errors.js";
import { readJsonBody } from "./body.js";
import type { AuthorizedRequest } from "./authorized-request.js";
import { workflowCapabilities } from "../workflow-access.js";
import {
  readWorkflow,
  listWorkflows,
  listWorkflowVersions,
} from "../workflows.js";
import {
  fields,
  parseQuestion,
  parseConcernDecision,
  revisionInput,
  textInput,
} from "../questionnaire/model.js";
import {
  createRound,
  publicationPreview,
  publishRound,
  readQuestions,
  saveQuestion,
  toRound,
  readSettings,
  saveSettings,
  type RoundRow,
} from "../questionnaire/store.js";
import {
  readAnswers,
  saveAnswer,
  submitAnswers,
  type AnswerInput,
} from "../questionnaire/answers.js";
import { firstHeader } from "../identity/identity.js";
import { listWorkflowPins } from "../workflow-source.js";
import { readComments, saveComment } from "../questionnaire/comments.js";
import {
  raiseConcern,
  readConcerns,
  concernResolutionPreview,
  resolveConcern,
} from "../questionnaire/concerns.js";

const PATH =
  /^\/api\/v1\/workflows\/([^/]+)\/versions\/([^/]+)\/questionnaire(?:\/(rounds|questions|settings|facts|comments|concerns|ledger|inferences|assumptions)(?:\/([^/]+)(?:\/(questions|publish-preview|publish|answer|submit|resolution-preview|resolve|acknowledgement-preview|acknowledge|comments|resolve-preview))?)?)?$/u;
const RECORD_CONTEXT =
  /^\/api\/v1\/questionnaire\/(questions|concerns)\/([^/]+)$/u;

export function questionnaireMethods(path: string): string | null {
  if (path === "/api/v1/questionnaire" || RECORD_CONTEXT.test(path))
    return "GET, HEAD";
  const match = PATH.exec(path);
  if (!match) return null;
  const [, , , resource, id, action] = match;
  if (!resource) return "GET, HEAD";
  if (resource === "ledger" && !id) return "GET, HEAD";
  if (["inferences", "assumptions"].includes(resource) && !action)
    return id ? "GET, HEAD, PATCH, DELETE" : "GET, HEAD, POST";
  if (resource === "settings" && !id) return "PUT";
  if (resource === "rounds" && !id) return "POST";
  if (resource === "questions" && id && !action) return "PATCH";
  if (resource === "rounds" && action === "publish-preview") return "GET, HEAD";
  if (
    resource === "rounds" &&
    ["questions", "publish", "submit"].includes(action ?? "")
  )
    return "POST";
  if (resource === "questions" && action === "answer") return "PUT";
  if (resource === "questions" && action === "submit") return "POST";
  if (
    resource === "questions" &&
    id &&
    ["resolution-preview", "resolve"].includes(action ?? "")
  )
    return "POST";
  if (
    resource === "facts" &&
    id &&
    ["acknowledgement-preview", "acknowledge"].includes(action ?? "")
  )
    return "POST";
  if (resource === "questions" && action === "comments") return "POST";
  if (resource === "comments" && id && !action) return "PATCH";
  if (resource === "concerns" && !id) return "POST";
  if (
    resource === "concerns" &&
    id &&
    ["resolve-preview", "resolve"].includes(action ?? "")
  )
    return "POST";
  return null;
}

/** Every questionnaire mutation locks its workflow and version before reading. */
export async function handleQuestionnaire(
  input: AuthorizedRequest,
): Promise<void> {
  const {
    database,
    path,
    method,
    reply,
    request,
    access,
    person,
    dependencies: deps,
    context,
    url,
  } = input;
  if (path === "/api/v1/questionnaire") {
    const versions = [];
    for (const workflow of await listWorkflows(database, access, person)) {
      for (const version of await listWorkflowVersions(database, workflow.id))
        versions.push({
          workflowId: workflow.id,
          workflowName: workflow.name,
          versionId: version.id,
          number: version.number,
        });
    }
    return reply.json(200, { versions });
  }
  const linked = RECORD_CONTEXT.exec(path);
  if (linked) {
    const row = (
      await database.query<{
        workflow_id: string;
        workflow_version_id: string;
        state: string;
      }>(
        linked[1] === "questions"
          ? `select v.workflow_id, q.workflow_version_id, q.state from questions q join workflow_versions v on v.id = q.workflow_version_id where q.id = $1`
          : `select v.workflow_id, c.workflow_version_id, 'open' as state from questionnaire_concerns c join workflow_versions v on v.id = c.workflow_version_id where c.id = $1`,
        [decodeURIComponent(linked[2])],
      )
    ).rows[0];
    const workflow = row && (await readWorkflow(database, row.workflow_id));
    if (!row || !workflow)
      throw new RequestError(404, "No such questionnaire record");
    const caps = await workflowCapabilities(database, access, person, workflow);
    const roles = await database.query<{ role: string }>(
      "select role from role_bindings where workflow_id = $1 and person_id = $2",
      [workflow.id, person.id],
    );
    if (
      !caps.read ||
      (row.state === "draft" &&
        !isAdministrator(access) &&
        !roles.rows.some((r) => r.role === "Engineer"))
    )
      throw new RequestError(403, "This question is outside your roles");
    return reply.json(200, {
      workflowId: workflow.id,
      versionId: row.workflow_version_id,
    });
  }
  const match = PATH.exec(path)!;
  const [, rawWorkflow, rawVersion, resource, rawId, action] = match;
  const workflowId = decodeURIComponent(rawWorkflow);
  const versionId = decodeURIComponent(rawVersion);
  const id = rawId === undefined ? null : decodeURIComponent(rawId);
  const methods = questionnaireMethods(path)!;
  if (!methods.split(", ").includes(method))
    return reply.error(405, "invalid", "Method not allowed", {
      allow: methods,
    });
  const reads = method === "GET" || method === "HEAD";
  let body: Record<string, unknown> = {};
  if (!reads) {
    const parsed = await readJsonBody(request);
    if (!parsed.ok) return reply.error(400, "invalid", parsed.message);
    body = objectInput(parsed.value);
  }
  const result = await database
    .transaction(async (tx) => {
      if (
        !reads ||
        ["ledger", "inferences", "assumptions"].includes(resource ?? "")
      ) {
        await tx.query("select id from workflows where id = $1 for update", [
          workflowId,
        ]);
        await tx.query(
          "select id from workflow_versions where id = $1 and workflow_id = $2 for update",
          [versionId, workflowId],
        );
      }
      const workflow = await readWorkflow(tx, workflowId);
      const version =
        workflow &&
        (await listWorkflowVersions(tx, workflowId)).find(
          (v) => v.id === versionId,
        );
      if (!workflow || !version)
        throw new RequestError(404, "No such workflow version");
      const caps = await workflowCapabilities(tx, access, person, workflow);
      if (!caps.read)
        throw new RequestError(403, "This workflow is outside your roles");
      const grants = await tx.query<{ role: string }>(
        "select role from role_bindings where workflow_id = $1 and person_id = $2",
        [workflowId, person.id],
      );
      const compose =
        (isAdministrator(access) ||
          grants.rows.some((g) => g.role === "Engineer")) &&
        (access.tokenScopes === undefined ||
          access.tokenScopes.includes("engineer"));
      const answering = action === "answer" || action === "submit";
      const commenting = resource === "comments" || action === "comments";
      const comment =
        isAdministrator(access) ||
        grants.rows.some((g) => g.role !== "Observer");
      const canRaiseConcern =
        (isAdministrator(access) ||
          grants.rows.some((g) => g.role === "Field expert")) &&
        (access.tokenScopes === undefined ||
          access.tokenScopes.includes("expert"));
      if (commenting && !comment)
        throw new RequestError(
          403,
          "A workflow role other than Observer is required to comment",
        );
      const canResolveConcern = compose && access.tokenScopes === undefined;
      if (resource === "ledger")
        return {
          status: 200,
          value: await readLedger(
            tx,
            versionId,
            person.id,
            compose,
            url.searchParams.get("sinceRound"),
          ),
        };
      if (resource === "inferences" || resource === "assumptions") {
        const kind = resource === "inferences" ? "inference" : "assumption";
        if (reads)
          return {
            status: 200,
            value: id
              ? await readDraft(tx, versionId, id, kind)
              : {
                  records: (await readDrafts(tx, versionId)).filter(
                    (r) => r.kind === kind,
                  ),
                },
          };
        if (!compose)
          throw new RequestError(
            403,
            "Only an Engineer drafts inferences and assumptions",
          );
        return {
          status: method === "POST" ? 201 : 200,
          value: {
            record: await saveDraft(
              tx,
              deps,
              context,
              versionId,
              kind,
              id,
              body,
              method === "DELETE",
            ),
          },
        };
      }
      if (resource === "concerns" && !id && !canRaiseConcern)
        throw new RequestError(403, "Only a Field expert raises a concern");
      if (resource === "concerns" && id && !canResolveConcern)
        throw new RequestError(
          403,
          "Only a signed-in Engineer resolves a concern",
        );
      const acknowledging = resource === "facts";
      const canAcknowledge =
        access.tokenScopes === undefined &&
        grants.rows.some(
          (g) => g.role === "Field expert" || g.role === "Workflow owner",
        );
      if (acknowledging && !canAcknowledge)
        throw new RequestError(
          403,
          "A current Field expert or Workflow owner role is required to acknowledge an answer",
        );
      if (
        resource &&
        resource !== "concerns" &&
        !answering &&
        !acknowledging &&
        !commenting &&
        !compose
      )
        throw new RequestError(
          403,
          "Only an Engineer drafts and publishes questions",
        );
      if (!resource) {
        const rounds = await tx.query<RoundRow>(
          "select * from question_rounds where workflow_version_id = $1 and ($2::boolean or state = 'published') order by number",
          [versionId, compose],
        );
        const assignees = await tx.query<{
          person_id: string | null;
          display_name: string | null;
          email: string;
          role: string;
        }>(
          `select b.person_id, p.display_name, b.email, b.role from role_bindings b left join people p on p.id = b.person_id where b.workflow_id = $1 and b.role in ('Field expert', 'Workflow owner') order by b.email, b.role`,
          [workflowId],
        );
        return {
          status: 200,
          value: {
            personId: person.id,
            workflow,
            version,
            capabilities: {
              compose,
              comment,
              raiseConcern: canRaiseConcern,
              resolveConcern: canResolveConcern,
              resolve: compose && access.tokenScopes === undefined,
              acknowledge: canAcknowledge,
            },
            settings: await readSettings(tx, workflowId),
            pins: await listWorkflowPins(tx, versionId),
            assignees: assignees.rows.map((a) => ({
              personId: a.person_id,
              name: a.display_name ?? a.email,
              role: a.role,
            })),
            rounds: rounds.rows.map(toRound),
            questions: await readQuestions(tx, versionId, person.id, compose),
            answers: await readAnswers(tx, versionId, person.id),
            resolutions: await readResolutions(tx, versionId),
            facts: await readFacts(tx, versionId),
            comments: await readComments(tx, versionId, compose),
            concerns: await readConcerns(tx, versionId),
          },
        };
      }
      if (resource === "concerns") {
        if (id) {
          const decision = parseConcernDecision(body, action === "resolve");
          if (action === "resolve-preview")
            return {
              status: 200,
              value: {
                preview: await concernResolutionPreview(
                  tx,
                  versionId,
                  id,
                  decision,
                ),
              },
            };
          if (body.confirmed !== true)
            throw new RequestError(
              400,
              "Confirm the reviewed concern resolution",
            );
          return {
            status: 200,
            value: await resolveConcern(
              tx,
              deps,
              context,
              versionId,
              id,
              decision,
              textInput(body.confirmationHash, "confirmationHash", 64),
            ),
          };
        }
        fields(body, ["text"]);
        return {
          status: 201,
          value: {
            concern: await raiseConcern(
              tx,
              deps,
              context,
              versionId,
              textInput(body.text, "text", 20000),
            ),
          },
        };
      }
      if (commenting && id) {
        fields(body, resource === "comments" ? ["text", "revision"] : ["text"]);
        return {
          status: resource === "comments" ? 200 : 201,
          value: {
            comment: await saveComment(
              tx,
              deps,
              context,
              versionId,
              compose,
              textInput(body.text, "text", 20000),
              resource === "comments"
                ? { commentId: id, revision: revisionInput(body.revision) }
                : { questionId: id },
            ),
          },
        };
      }
      if (
        id &&
        [
          "resolution-preview",
          "resolve",
          "acknowledgement-preview",
          "acknowledge",
        ].includes(action ?? "")
      ) {
        if (access.tokenScopes !== undefined || context.channel !== "web")
          throw new RequestError(
            403,
            "Sign off in the dashboard as a signed-in person",
          );
        const commit = action === "resolve" || action === "acknowledge";
        if (commit && body.confirmed !== true)
          throw new RequestError(400, "Confirm the reviewed sign-off");
        const hash = commit
          ? textInput(body.confirmationHash, "confirmationHash", 64)
          : "";
        const requestId = commit
          ? textInput(body.requestId, "requestId", 200)
          : "";
        if (resource === "questions") {
          const input = parseResolution(body);
          const value = commit
            ? await resolveQuestion(
                tx,
                deps,
                context,
                versionId,
                id,
                input,
                hash,
                requestId,
              )
            : {
                preview: await resolutionPreview(
                  tx,
                  versionId,
                  id,
                  person.id,
                  input,
                ),
              };
          if (commit && input.kind === "followed-up") {
            const child = (
              await tx.query<{ round_id: string }>(
                `select q.round_id from questions q join question_resolutions r on r.child_question_id = q.id
              where r.question_id = $1 and r.request_id = $2 and r.actor_id = $3`,
                [id, requestId, person.id],
              )
            ).rows[0];
            if (child)
              await snapshotRoundLedger(
                tx,
                versionId,
                child.round_id,
                person.id,
              );
          }
          return { status: 200, value };
        }
        const input = parseAcknowledgement(body);
        return {
          status: 200,
          value: commit
            ? await acknowledgeFact(
                tx,
                deps,
                context,
                versionId,
                id,
                input,
                hash,
                requestId,
              )
            : {
                preview: await acknowledgementPreview(
                  tx,
                  versionId,
                  id,
                  person.id,
                  input,
                ),
              },
        };
      }
      if (resource === "settings") {
        fields(body, ["roundSizeLimit", "revision"]);
        const limit = body.roundSizeLimit;
        if (
          limit !== null &&
          (!Number.isSafeInteger(limit) || (limit as number) < 1)
        )
          throw new RequestError(
            400,
            "roundSizeLimit must be a positive integer, or null for no limit",
          );
        return {
          status: 200,
          value: {
            settings: await saveSettings(
              tx,
              deps,
              context,
              workflowId,
              revisionInput(body.revision, 0),
              limit as number | null,
            ),
          },
        };
      }
      if (answering && id) {
        const agentHost =
          context.channel === "mcp"
            ? textInput(
                firstHeader(request.headers, "x-badger-agent-host"),
                "x-badger-agent-host",
                200,
              )
            : null;
        const answerInput = (
          value: Record<string, unknown>,
          questionId: string,
        ): AnswerInput => ({
          questionId,
          revision: revisionInput(value.revision, 0),
          questionRevision: revisionInput(value.questionRevision),
        });
        if (resource === "questions" && action === "answer") {
          fields(body, ["revision", "questionRevision", "text"]);
          if (typeof body.text !== "string" || body.text.length > 50000)
            throw new RequestError(
              400,
              "Answer text must contain at most 50000 characters",
            );
          return {
            status: 200,
            value: {
              answer: await saveAnswer(
                tx,
                deps,
                context,
                versionId,
                answerInput(body, id),
                body.text,
                agentHost,
              ),
            },
          };
        }
        if (resource === "questions") {
          fields(body, ["revision", "questionRevision"]);
          return {
            status: 200,
            value: {
              answers: await submitAnswers(
                tx,
                deps,
                context,
                versionId,
                [answerInput(body, id)],
                agentHost,
              ),
            },
          };
        }
        fields(body, ["answers"]);
        if (!Array.isArray(body.answers))
          throw new RequestError(
            400,
            "answers must be an array of saved draft revisions",
          );
        const inputs = body.answers.map((raw) => {
          const value = objectInput(raw);
          fields(value, ["questionId", "revision", "questionRevision"]);
          return answerInput(
            value,
            textInput(value.questionId, "questionId", 200),
          );
        });
        return {
          status: 200,
          value: {
            answers: await submitAnswers(
              tx,
              deps,
              context,
              versionId,
              inputs,
              agentHost,
              id,
            ),
          },
        };
      }
      if (resource === "rounds" && id === null) {
        fields(body, ["title"]);
        return {
          status: 201,
          value: {
            round: await createRound(
              tx,
              deps,
              context,
              versionId,
              textInput(body.title, "title", 200),
            ),
          },
        };
      }
      if (resource === "rounds" && action === "questions" && id) {
        return {
          status: 201,
          value: {
            question: await saveQuestion(
              tx,
              deps,
              context,
              versionId,
              id,
              parseQuestion(body),
            ),
          },
        };
      }
      if (resource === "questions" && id && !action) {
        const question = (
          await readQuestions(tx, versionId, person.id, true)
        ).find((q) => q.id === id);
        if (!question) throw new RequestError(404, "No such question");
        if (access.tokenScopes !== undefined && question.state !== "draft")
          throw new RequestError(
            403,
            "Only a signed-in person revises a published question",
          );
        return {
          status: 200,
          value: {
            question: await saveQuestion(
              tx,
              deps,
              context,
              versionId,
              question.roundId,
              parseQuestion(body),
              { id, revision: revisionInput(body.revision) },
            ),
          },
        };
      }
      if (resource === "rounds" && action === "publish-preview" && id) {
        return {
          status: 200,
          value: {
            preview: await publicationPreview(tx, versionId, id, person.id),
          },
        };
      }
      if (resource === "rounds" && action === "publish" && id) {
        fields(body, ["confirmed", "confirmationHash"]);
        if (body.confirmed !== true)
          throw new RequestError(
            400,
            "Confirm the reviewed round before publishing",
          );
        const round = await publishRound(
          tx,
          deps,
          context,
          versionId,
          id,
          textInput(body.confirmationHash, "confirmationHash", 64),
        );
        await snapshotRoundLedger(tx, versionId, id, person.id);
        return { status: 200, value: { round } };
      }
      throw new RequestError(404, "No such questionnaire resource");
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
          "This sign-off request ID was already used",
        );
      throw error;
    });
  reply.json(result.status, result.value);
}
