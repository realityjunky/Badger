import type {
  QuestionnaireLedgerItem,
  QuestionnaireRecordHandoff,
  QuestionnaireRecordReference,
  QuestionnaireTopic,
} from "@realityjunky/badger";

export type {
  QuestionnaireLedgerItem as LedgerItem,
  QuestionnaireRecordReference as RecordReference,
  QuestionnaireTopic as LedgerTopic,
};
export interface LedgerView {
  handoff: QuestionnaireRecordHandoff;
  baselines: { id: string; number: number; title: string }[];
  sinceRound: string | null;
  changes: {
    added: QuestionnaireLedgerItem[];
    changed: {
      before: QuestionnaireLedgerItem;
      after: QuestionnaireLedgerItem | null;
    }[];
    resolved: {
      before: QuestionnaireLedgerItem;
      after: QuestionnaireLedgerItem;
    }[];
  } | null;
}
export interface LedgerDraft {
  id: string;
  revision: number;
  kind: "inference" | "assumption";
  statement: string;
  topic: QuestionnaireTopic;
  questionId: string | null;
  questionRevision: number | null;
  status: "active" | "retired";
}
