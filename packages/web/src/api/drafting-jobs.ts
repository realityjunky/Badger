import type { QuestionContent } from "./questionnaire.js";
export interface DraftingJob {
  id: string;
  kind: "draft-questions" | "draft-follow-ups";
  roundId: string;
  parentQuestionId: string | null;
  status:
    "queued" | "claimed" | "submitted" | "accepted" | "rejected" | "cancelled";
  revision: number;
  contextHash: string;
  result: { questions: QuestionContent[] } | null;
}
export interface DraftingDecisionPreview {
  jobId: string;
  revision: number;
  action: "accept" | "reject";
  decision: { questions: QuestionContent[] } | { reason: string };
  confirmationHash: string;
}
