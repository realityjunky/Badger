import { z } from "zod";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { randomUUID } from "node:crypto";
import type { BadgerApi } from "./api.js";
import { uploadSkillVersion } from "./upload.js";
import { SKILL_SCRIPT_SIDE_EFFECTS } from "@realityjunky/badger";

export interface ExpertTool {
  definition: Tool;
  permission?: string;
  run(args: unknown): Promise<unknown>;
}

const id = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9_-]+$/u);
const context = { workflowId: id, versionId: id };
const question = { ...context, questionId: id };
const answer = {
  ...question,
  revision: z.number().int().min(0),
  questionRevision: z.number().int().min(1),
};

function tool<S extends z.ZodRawShape>(
  name: string,
  description: string,
  shape: S,
  run: (args: z.infer<z.ZodObject<S>>) => Promise<unknown>,
  permission?: string,
): ExpertTool {
  const schema = z.object(shape).strict();
  return {
    definition: {
      name,
      description,
      inputSchema: z.toJSONSchema(schema) as Tool["inputSchema"],
      annotations: {
        readOnlyHint: permission === undefined,
        openWorldHint: true,
      },
    },
    permission,
    run: (args) => run(schema.parse(args)),
  };
}

export function questionnairePath(input: {
  workflowId: string;
  versionId: string;
}) {
  return `/workflows/${encodeURIComponent(input.workflowId)}/versions/${encodeURIComponent(input.versionId)}/questionnaire`;
}

interface QuestionView {
  questions: { id: string }[];
}

function currentAnswer({
  revisions: _history,
  ...answer
}: Record<string, unknown>) {
  return answer;
}

export function expertTools(api: BadgerApi, server: Server): ExpertTool[] {
  return [
    tool(
      "whoami",
      "Show whose personal access token this Agent uses.",
      {},
      () => api.request("/me"),
    ),
    tool(
      "inbox",
      "List the person's inbox items and dashboard links; use the returned cursor for the next page.",
      {
        limit: z.number().int().min(1).max(50).optional(),
        cursor: z.string().max(2000).optional(),
      },
      async (args) => {
        const query = new URLSearchParams({ limit: String(args.limit ?? 20) });
        if (args.cursor) query.set("cursor", args.cursor);
        const inbox = await api.request<{ items: { href: string }[] }>(
          `/me/inbox?${query}`,
        );
        return {
          ...inbox,
          items: inbox.items.map((item) => ({
            ...item,
            href: `${api.url}${item.href}`,
          })),
        };
      },
    ),
    tool(
      "my_questions",
      "Read open questions assigned to this person, with their current answers and comments. Optionally select a workflow version.",
      { workflowId: id.optional(), versionId: id.optional() },
      async (args) => {
        if (Boolean(args.workflowId) !== Boolean(args.versionId))
          throw new Error("Supply workflowId and versionId together");
        const query = new URLSearchParams();
        if (args.workflowId && args.versionId) {
          query.set("workflowId", args.workflowId);
          query.set("versionId", args.versionId);
        }
        return api.request(`/me/questions?${query}`);
      },
    ),
    tool(
      "save_answer",
      "Save the user's own words as a draft answer; quote the revisions you read. Use revision 0 for the first draft.",
      { ...answer, text: z.string().max(50000) },
      async (args) => {
        const { answer } = await api.request<{
          answer: Record<string, unknown>;
        }>(
          `${questionnairePath(args)}/questions/${args.questionId}/answer`,
          "PUT",
          {
            revision: args.revision,
            questionRevision: args.questionRevision,
            text: args.text,
          },
        );
        return { answer: currentAnswer(answer) };
      },
      "answer",
    ),
    tool(
      "submit_answer",
      "Submit a saved answer only when the user asks to send it; quote the saved answer and question revisions.",
      answer,
      async (args) => {
        const { answers } = await api.request<{
          answers: Record<string, unknown>[];
        }>(
          `${questionnairePath(args)}/questions/${args.questionId}/submit`,
          "POST",
          { revision: args.revision, questionRevision: args.questionRevision },
        );
        return { answers: answers.map(currentAnswer) };
      },
      "answer",
    ),
    tool(
      "comment",
      "Post the user's comment to a question's discussion thread.",
      { ...question, text: z.string().min(1).max(20000) },
      (args) =>
        api.request(
          `${questionnairePath(args)}/questions/${args.questionId}/comments`,
          "POST",
          { text: args.text },
        ),
      "comment",
    ),
    tool(
      "raise_concern",
      "Send workflow knowledge or a concern the user volunteered to the Engineer.",
      { ...context, text: z.string().min(1).max(20000) },
      (args) =>
        api.request(`${questionnairePath(args)}/concerns`, "POST", {
          text: args.text,
        }),
      "raiseConcern",
    ),
    tool(
      "upload_skill_version",
      "Preview a local Skill folder, then upload its exact reviewed hash after the user confirms. Never upload real data. Declare each script's side effects.",
      {
        skillId: id,
        folder: z.string().min(1).max(4096),
        scripts: z
          .record(z.string(), z.array(z.enum(SKILL_SCRIPT_SIDE_EFFECTS)))
          .default({}),
        confirmed: z.boolean().optional(),
        expectedHash: z
          .string()
          .regex(/^[a-f0-9]{64}$/u)
          .optional(),
      },
      (args) => uploadSkillVersion(api, args),
      "uploadSkillVersion",
    ),
    tool(
      "open_dashboard",
      "Give the person a dashboard link to confirm, acknowledge, dispute, approve, publish, or answer a gate themselves. Opening it never signs off.",
      {
        ...context,
        questionId: id.optional(),
        action: z.enum([
          "confirm",
          "acknowledge",
          "dispute",
          "approve",
          "publish",
          "answer_gate",
        ]),
      },
      async (args) => {
        const view = await api.request<QuestionView>(questionnairePath(args));
        if (
          ["confirm", "acknowledge", "dispute"].includes(args.action) &&
          !args.questionId
        )
          throw new Error("Select the question to review");
        if (
          args.questionId &&
          !view.questions.some((q) => q.id === args.questionId)
        )
          throw new Error(
            "This question is outside the selected workflow version",
          );
        const url = args.questionId
          ? `${api.url}/questionnaire/questions/${args.questionId}`
          : `${api.url}/workflows/${args.workflowId}/versions/${args.versionId}`;
        if (server.getClientCapabilities()?.elicitation?.url !== undefined) {
          // Host dismissal or failure never turns into a sign-off or loses the link.
          await server
            .elicitInput({
              mode: "url",
              message:
                "Review and complete this action yourself in the Badger dashboard.",
              elicitationId: randomUUID(),
              url,
            })
            .catch(() => undefined);
        }
        return {
          url,
          requiresPerson: true,
          message:
            "Sign in and review the action in the dashboard. The Agent has not signed off.",
        };
      },
    ),
  ];
}
