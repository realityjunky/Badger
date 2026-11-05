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
import { questionnaireCapabilities } from "../questionnaire/access.js";
import {
  isQuestionnaireDraftingJob,
  publicDraftingJob,
  reconcileDraftingJobs,
} from "../drafting/jobs.js";
import { isAdministrator } from "../authorization.js";
import { readLedger, snapshotRoundLedger } from "../questionnaire/ledger.js";
import { readDraft, readDrafts, saveDraft } from "../questionnaire/drafts.js";
import { RequestError, objectInput } from "./errors.js";
import {
  uploadAttachment,
  readAttachment,
  ATTACHMENT_LIMITS,
  MAX_ATTACHMENT_BODY_BYTES,
} from "../questionnaire/attachments.js";
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
import { draftingContext } from "../drafting/context.js";
import { createDraftingJob } from "../drafting/jobs.js";
import { listWorkflowPins } from "../workflow-source.js";
import { readComments, saveComment } from "../questionnaire/comments.js";
import { withVersionLabels } from "../workflow-version-labels.js";
import {
  raiseConcern,
  readConcerns,
  concernResolutionPreview,
  resolveConcern,
} from "../questionnaire/concerns.js";

const PATH =
  /^\/api\/v1\/workflows\/([^/]+)\/versions\/([^/]+)\/questionnaire(?:\/(rounds|questions|settings|facts|comments|concerns|ledger|inferences|assumptions|attachments)(?:\/([^/]+)(?:\/(questions|publish-preview|publish|answer|submit|resolution-preview|resolve|acknowledgement-preview|acknowledge|comments|resolve-preview|attachments))?)?)?$/u;
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
  if (resource === "attachments" && id && !action) return "GET, HEAD";
  if (resource === "questions" && action === "attachments") return "POST";
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
  const agentHost =
    context.credential.kind === "token"
      ? (context.credential.agentHost ?? null)
      : null;
  if (path === "/api/v1/questionnaire") {
    const versions = [];
    for (const workflow of await listWorkflows(database, access, person)) {
      for (const version of await withVersionLabels(
        database,
        await listWorkflowVersions(database, workflow.id),
      ))
        versions.push({
          workflowId: workflow.id,
          workflowName: workflow.name,
          versionId: version.id,
          number: version.number,
          semanticVersion: version.semanticVersion,
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
    const parsed = await readJsonBody(
      request,
      action === "attachments"
        ? MAX_ATTACHMENT_BODY_BYTES
        : action === "answer"
          ? 256 * 1024
          : undefined,
    );
    if (!parsed.ok)
      return reply.error(parsed.status ?? 400, "invalid", parsed.message);
    body = objectInput(parsed.value);
  }
  const result = await database
    .transaction(async (tx) => {
      if (
        !reads ||
        !resource ||
        ["ledger", "inferences", "assumptions", "attachments"].includes(
          resource ?? "",
        )
      ) {
        await tx.query(
          "select id from workflows where id = $1 for no key update",
          [workflowId],
        );
        await tx.query(
          "select id from workflow_versions where id = $1 and workflow_id = $2 for no key update",
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
      const capabilities = await questionnaireCapabilities(
        tx,
        access,
        person,
        workflowId,
      );
      if (resource === "attachments" && id) {
        const attachment = await readAttachment(tx, versionId, person.id, id);
        return {
          status: 200,
          value: attachment,
          file: await input.blobs.get(attachment.hash),
        };
      }
      if (resource === "questions" && action === "attachments" && id) {
        return {
          status: 201,
          value: {
            attachment: await uploadAttachment(
              tx,
              deps,
              input.blobs,
              context,
              versionId,
              id,
              body,
            ),
          },
        };
      }
      const {
        compose,
        comment,
        raiseConcern: canRaiseConcern,
        resolveConcern: canResolveConcern,
        acknowledge: canAcknowledge,
      } = capabilities;
      const answering = action === "answer" || action === "submit";
      const commenting = resource === "comments" || action === "comments";
      if (commenting && !comment)
        throw new RequestError(
          403,
          "A workflow role other than Observer is required to comment",
        );
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
        if (reads) {
          // Readers who cannot compose never learn a draft question's ID.
          const hidden = new Set(
            compose
              ? []
              : (
                  await tx.query<{ id: string }>(
                    "select id from questions where workflow_version_id = $1 and state = 'draft'",
                    [versionId],
                  )
                ).rows.map((row) => row.id),
          );
          const redact = <
            T extends { questionId: string | null; questionRevision: unknown },
          >(
            record: T,
          ): T =>
            record.questionId !== null && hidden.has(record.questionId)
              ? { ...record, questionId: null, questionRevision: null }
              : record;
          if (id) {
            const draft = await readDraft(tx, versionId, id, kind);
            return {
              status: 200,
              value: {
                record: redact(draft.record),
                revisions: draft.revisions.map(redact),
              },
            };
          }
          return {
            status: 200,
            value: {
              records: (await readDrafts(tx, versionId))
                .filter((r) => r.kind === kind)
                .map(redact),
            },
          };
        }
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
          `select b.person_id, p.display_name, b.email, b.role from role_bindings b left join people p on p.id = b.person_id where b.workflow_id = $1 and b.role in ('Field expert', 'Workflow owner', 'Engineer') order by b.email, b.role`,
          [workflowId],
        );
        return {
          status: 200,
          value: {
            personId: person.id,
            attachmentLimits: ATTACHMENT_LIMITS,
            workflow,
            version: (await withVersionLabels(tx, [version]))[0],
            capabilities,
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
            suggestions:
              compose || capabilities.reviewSuggestions
                ? (
                    await reconcileDraftingJobs(
                      tx,
                      deps,
                      {
                        ...context,
                        agentHost,
                      },
                      workflowId,
                      versionId,
                    )
                  ).jobs
                    .filter(
                      (job) =>
                        job.status === "submitted" &&
                        (compose || isQuestionnaireDraftingJob(job)),
                    )
                    .map(publicDraftingJob)
                : [],
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
          // A replayed request returns its first response; only a new
          // follow-up round gets a publication baseline.
          const replay =
            commit &&
            (
              await tx.query(
                "select 1 from question_resolutions where actor_id = $1 and request_id = $2",
                [person.id, requestId],
              )
            ).rows.length > 0;
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
          if (commit && !replay && input.kind === "followed-up") {
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
        const answerInput = (
          value: Record<string, unknown>,
          questionId: string,
        ): AnswerInput => ({
          questionId,
          revision: revisionInput(value.revision, 0),
          questionRevision: revisionInput(value.questionRevision),
        });
        if (resource === "questions" && action === "answer") {
          fields(body, [
            "revision",
            "questionRevision",
            "text",
            "value",
            "attachments",
          ]);
          return {
            status: 200,
            value: {
              answer: await saveAnswer(
                tx,
                deps,
                context,
                versionId,
                answerInput(body, id),
                body,
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
        fields(body, ["title", "draftQuestions"]);
        if (
          body.draftQuestions !== undefined &&
          typeof body.draftQuestions !== "boolean"
        )
          throw new RequestError(400, "draftQuestions must be a boolean");
        const round = await createRound(
          tx,
          deps,
          context,
          versionId,
          textInput(body.title, "title", 200),
        );
        const job =
          body.draftQuestions === true
            ? await createDraftingJob(
                tx,
                deps,
                { ...context, agentHost },
                versionId,
                {
                  kind: "draft-questions",
                  roundId: round.id,
                  parentQuestionId: null,
                  skillId: null,
                  questionId: null,
                  locale: null,
                },
                await draftingContext(tx, workflowId, versionId, person.id),
              )
            : null;
        return {
          status: 201,
          value: {
            round,
            ...(job ? { job: publicDraftingJob(job) } : {}),
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
        // A repeated publication must not invent a baseline for a round
        // published before ledger history existed.
        const wasPublished =
          (
            await tx.query<{ state: string }>(
              "select state from question_rounds where id = $1 and workflow_version_id = $2",
              [id, versionId],
            )
          ).rows[0]?.state === "published";
        const round = await publishRound(
          tx,
          deps,
          context,
          versionId,
          id,
          textInput(body.confirmationHash, "confirmationHash", 64),
        );
        if (!wasPublished)
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
  if ("file" in result && result.file) {
    const attachment = result.value;
    return reply.send({
      status: 200,
      contentType: "application/octet-stream",
      body: result.file,
      headers: {
        "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(attachment.name).replace(/['()*]/gu, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)}`,
      },
    });
  }
  reply.json(result.status, result.value);
}
