import { Ajv } from "ajv";
import {
  SEMANTIC_DOSSIER_TOPICS,
  scriptEffectSuggestionSchema,
  type ScriptEffectSuggestion,
  type FactoryPlan,
  type AuthoringLaneOutput,
} from "@realityjunky/badger";
import { objectInput, RequestError } from "../http/errors.js";
import {
  parseQuestion,
  textInput,
  type QuestionContent,
} from "../questionnaire/model.js";
import {
  parseStudyContent,
  parseSourceEvidence,
  type SourceFact,
  type SkillInterface,
  type SourceEvidence,
} from "../source-study.js";

import {
  parseResolution,
  type ResolutionInput,
} from "../questionnaire/resolutions.js";
export type DraftingKind =
  | "authoring-lane"
  | "review-vote"
  | "draft-questions"
  | "draft-follow-ups"
  | "draft-plan"
  | "source-study"
  | "restate-answer"
  | "translate-question"
  | "import-open-questions";
export interface ImportedQuestion {
  number: number;
  source: SourceEvidence;
  question: QuestionContent;
}
export type DraftResult =
  | { laneOutput: AuthoringLaneOutput }
  | { plan: FactoryPlan }
  | { questions: QuestionContent[] }
  | { questions: ImportedQuestion[] }
  | {
      facts: SourceFact[];
      interfaces: SkillInterface[];
      scriptEffects?: ScriptEffectSuggestion[];
    }
  | { facts: NonNullable<ResolutionInput["facts"]> }
  | { text: string; rationale: string };

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
          role: { enum: ["Workflow owner", "Field expert", "Engineer"] },
        }),
      ],
    },
  },
  priority: { type: "integer", minimum: 0, maximum: 100 },
});
// Optional so existing text-only job results retain their original shape.
const structuredQuestionSchema = {
  ...questionSchema,
  properties: {
    ...questionSchema.properties,
    answerType: {
      oneOf: [
        object({ kind: { enum: ["free-text", "yes-no", "file"] } }),
        object({
          kind: { enum: ["single-choice", "multiple-choice"] },
          options: {
            type: "array",
            minItems: 2,
            maxItems: 100,
            uniqueItems: true,
            items: text(200),
          },
        }),
        object({ kind: { const: "number" }, unit: text(100) }),
        object({
          kind: { const: "table" },
          columns: {
            type: "array",
            minItems: 1,
            maxItems: 20,
            uniqueItems: true,
            items: text(200),
          },
        }),
      ],
    },
  },
};
export const QUESTION_DRAFT_SCHEMA = object({
  questions: {
    type: "array",
    minItems: 1,
    maxItems: 20,
    items: structuredQuestionSchema,
  },
});

const hash = { type: "string", pattern: "^[a-f0-9]{64}$" };
const skillRef = object({ skillId: text(200), hash });
const evidence = {
  type: "array",
  minItems: 1,
  maxItems: 50,
  items: object({
    skillId: text(200),
    hash,
    path: text(1000),
    fileHash: hash,
    startLine: { type: "integer", minimum: 1 },
    endLine: { type: "integer", minimum: 1 },
  }),
};
const SOURCE_STUDY_SCHEMA = {
  ...object(
    {
      facts: {
        type: "array",
        maxItems: 100,
        items: object({ statement: text(8000), evidence }),
      },
      interfaces: {
        type: "array",
        maxItems: 0,
        description:
          "Legacy field: leave empty. Cross-Skill analysis belongs to workflow questionnaire discovery.",
        items: object({
          producer: skillRef,
          consumer: skillRef,
          artifact: text(4000),
          columns: { type: "array", maxItems: 100, items: text(256) },
          naming: text(4000),
          validation: text(4000),
          evidence,
        }),
      },
      scriptEffects: {
        type: "array",
        maxItems: 10000,
        items: scriptEffectSuggestionSchema(),
      },
    },
    ["facts", "interfaces"],
  ),
};
export const DRAFT_SCHEMAS = {
  "draft-questions": QUESTION_DRAFT_SCHEMA,
  "draft-follow-ups": QUESTION_DRAFT_SCHEMA,
  "authoring-lane": object({ laneOutput: { type: "object" } }),
  "review-vote": object({ laneOutput: { type: "object" } }),
  "source-study": SOURCE_STUDY_SCHEMA,
  "restate-answer": object({
    facts: {
      type: "array",
      minItems: 1,
      maxItems: 100,
      items: object({
        text: text(20000),
        answers: {
          type: "array",
          minItems: 1,
          maxItems: 100,
          items: object({
            personId: text(200),
            revision: { type: "integer", minimum: 1 },
          }),
        },
      }),
    },
  }),
  "translate-question": object({ text: text(20000), rationale: text(4000) }),
  "import-open-questions": object({
    questions: {
      type: "array",
      minItems: 1,
      maxItems: 20,
      items: object({
        number: { type: "integer", minimum: 1 },
        source: evidence.items,
        question: structuredQuestionSchema,
      }),
    },
  }),
};
export function draftResultFields(kind: DraftingKind) {
  if (kind === "draft-plan") return ["plan"];
  return Object.keys(DRAFT_SCHEMAS[kind].properties);
}

export function validateDraftResult(
  kind: DraftingKind,
  schema: object,
  result: unknown,
  studyPin?: { skillId: string; hash: string },
): DraftResult {
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
  if (kind === "authoring-lane" || kind === "review-vote")
    return { laneOutput: input.laneOutput as AuthoringLaneOutput };
  if (kind === "draft-plan") return { plan: input.plan as FactoryPlan };
  if (kind === "import-open-questions") {
    const questions = (input.questions as unknown[]).map(
      (raw): ImportedQuestion => {
        const item = objectInput(raw);
        const question = parseQuestion(objectInput(item.question));
        const source = parseSourceEvidence(item.source);
        return { number: item.number as number, source, question };
      },
    );
    if (
      new Set(questions.map((q) => `${q.source.path}:${q.number}`)).size !==
      questions.length
    )
      throw new RequestError(
        400,
        "Import each source question number once per file",
      );
    return { questions };
  }
  if (kind === "translate-question")
    return {
      text: textInput(input.text, "translated question", 20000),
      rationale: textInput(input.rationale, "translated rationale", 4000),
    };
  if (kind === "restate-answer")
    return {
      facts: parseResolution({
        revision: 1,
        kind: "confirmed",
        facts: input.facts,
      }).facts!,
    };
  if (kind === "source-study") {
    if ((input.interfaces as unknown[]).length > 0)
      throw new RequestError(
        400,
        "Single-Skill studies cannot generate cross-Skill interfaces. Use workflow questionnaire discovery.",
      );
    const facts = (input.facts as unknown[]).map(
      (fact) => parseStudyContent("fact", fact) as SourceFact,
    );
    if (
      studyPin &&
      facts.some((fact) =>
        fact.evidence.some(
          (citation) =>
            citation.skillId !== studyPin.skillId ||
            citation.hash !== studyPin.hash,
        ),
      )
    )
      throw new RequestError(
        400,
        "Study facts must cite only the job's exact pinned Skill version",
      );
    return {
      facts,
      interfaces: [],
      ...(input.scriptEffects === undefined
        ? {}
        : {
            scriptEffects: input.scriptEffects as ScriptEffectSuggestion[],
          }),
    };
  }
  return {
    questions: (input.questions as unknown[]).map((q) =>
      parseQuestion(objectInput(q)),
    ),
  };
}
