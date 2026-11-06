import type { QuestionContent } from "./questionnaire.js";
import type { FactoryPlan } from "./plans.js";
import type {
  ScriptEffectSuggestion,
  SkillScriptSideEffect,
} from "@realityjunky/badger";
import { isRecord } from "../util/records.js";
import type {
  SourceEvidence,
  SourceFact,
  SkillInterface,
} from "./source-study.js";
export type DraftingKind =
  | "draft-questions"
  | "draft-follow-ups"
  | "source-study"
  | "restate-answer"
  | "translate-question"
  | "import-open-questions";
export interface ImportedQuestion {
  number: number;
  source: SourceEvidence;
  question: QuestionContent;
}
export type DraftingResult =
  | { questions: QuestionContent[] | ImportedQuestion[] }
  | {
      facts: SourceFact[];
      interfaces: SkillInterface[];
      scriptEffects?: ScriptEffectSuggestion[];
    }
  | {
      facts: {
        text: string;
        answers: { personId: string; revision: number }[];
      }[];
    }
  | { text: string; rationale: string };
export interface DraftingJob {
  id: string;
  kind: DraftingKind;
  roundId: string | null;
  skillId: string | null;
  questionId: string | null;
  locale: string | null;
  outputLocale?: string | null;
  parentQuestionId: string | null;
  status:
    "queued" | "claimed" | "submitted" | "accepted" | "rejected" | "cancelled";
  revision: number;
  contextHash: string;
  outputSchema?: object;
  result: DraftingResult | null;
  review: {
    result: DraftingResult;
    resultHash: string;
    revision: number;
    personId: string;
    updatedAt: string;
  } | null;
}
export interface DraftingDecisionPreview {
  jobId: string;
  revision: number;
  action: "accept" | "reject";
  decision: DraftingResult | { reason: string };
  confirmationHash: string;
}
export interface PlanDraftingJob extends Omit<
  DraftingJob,
  "kind" | "roundId" | "result"
> {
  kind: "draft-plan";
  roundId: null;
  result: { plan: FactoryPlan } | null;
}
export interface AuthoringDraftingJob extends Omit<
  DraftingJob,
  "kind" | "result"
> {
  kind: "authoring-lane" | "review-vote";
  laneId: string;
  result: {
    laneOutput: import("@realityjunky/badger").AuthoringLaneOutput;
  } | null;
}
export type AnyDraftingJob =
  DraftingJob | PlanDraftingJob | AuthoringDraftingJob;

export function draftingEffectLabels(
  job: DraftingJob,
): SkillScriptSideEffect[] {
  let value: unknown = job.outputSchema;
  for (const key of [
    "properties",
    "scriptEffects",
    "items",
    "properties",
    "effects",
    "items",
    "enum",
  ]) {
    if (!isRecord(value)) return [];
    value = value[key];
  }
  return Array.isArray(value) &&
    value.every((label) => typeof label === "string")
    ? (value as SkillScriptSideEffect[])
    : [];
}
