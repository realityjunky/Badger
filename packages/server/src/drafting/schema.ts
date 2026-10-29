import { Ajv } from "ajv";
import { SEMANTIC_DOSSIER_TOPICS } from "@realityjunky/badger";
import { objectInput, RequestError } from "../http/errors.js";
import { parseQuestion, type QuestionContent } from "../questionnaire/model.js";

const text = (maxLength: number) => ({
  type: "string",
  minLength: 1,
  maxLength,
});
const object = (
  properties: Record<string, unknown>,
  required = Object.keys(properties),
) => ({ type: "object", additionalProperties: false, properties, required });
const questionSchema = object({
  text: text(20000),
  topic: { enum: ["scope", ...SEMANTIC_DOSSIER_TOPICS] },
  targets: {
    type: "array",
    minItems: 1,
    maxItems: 100,
    items: object({
      kind: { enum: ["workflow", "node", "skill", "interface"] },
      id: text(200),
    }),
  },
  rationale: text(4000),
  evidence: {
    type: "array",
    maxItems: 100,
    items: object({
      skillId: text(200),
      versionHash: { type: "string", pattern: "^[a-f0-9]{64}$" },
      path: text(1024),
      startLine: { type: "integer", minimum: 1 },
      endLine: { type: "integer", minimum: 1 },
    }),
  },
  assignees: {
    type: "array",
    minItems: 1,
    maxItems: 100,
    items: {
      oneOf: [
        object({ kind: { const: "person" }, personId: text(200) }),
        object({
          kind: { const: "role" },
          role: { enum: ["Workflow owner", "Field expert"] },
        }),
      ],
    },
  },
  priority: { type: "integer", minimum: 0, maximum: 100 },
});
export const QUESTION_DRAFT_SCHEMA = object({
  questions: {
    type: "array",
    minItems: 1,
    maxItems: 20,
    items: questionSchema,
  },
});

export function validateDraftResult(
  schema: object,
  result: unknown,
): { questions: QuestionContent[] } {
  if (Buffer.byteLength(JSON.stringify(result) ?? "") > 1024 * 1024)
    throw new RequestError(413, "The job result exceeds 1 MiB");
  const ajv = new Ajv({ strict: false });
  const valid = ajv.compile(schema);
  if (!valid(result))
    throw new RequestError(
      400,
      `The result does not match the job's output schema: ${ajv.errorsText(valid.errors)}`,
    );
  const input = objectInput(result);
  return {
    questions: (input.questions as unknown[]).map((q) =>
      parseQuestion(objectInput(q)),
    ),
  };
}
