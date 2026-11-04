import { apiUrl } from "../app/paths.js";
import type { EvidenceChange, RecordOrigin } from "./version-changes.js";

export type AnswerType =
  | { kind: "free-text" | "yes-no" | "file" }
  | { kind: "single-choice" | "multiple-choice"; options: string[] }
  | { kind: "number"; unit: string }
  | { kind: "table"; columns: string[] };
export type AnswerValue =
  string | string[] | boolean | number | string[][] | null;
export interface AnswerAttachment {
  id: string;
  name: string;
  mediaType: string;
  size: number;
  hash: string;
}

export interface QuestionContent {
  answerType?: AnswerType;
  text: string;
  topic: string;
  targets: { kind: "workflow" | "node" | "skill" | "interface"; id: string }[];
  rationale: string;
  evidence: {
    skillId: string;
    versionHash: string;
    path: string;
    startLine: number;
    endLine: number;
  }[];
  assignees: (
    | { kind: "person"; personId: string }
    | { kind: "role"; role: "Workflow owner" | "Field expert" }
  )[];
  priority: number;
}
export interface Question extends QuestionContent {
  origin?: RecordOrigin | null;
  evidenceChanges?: EvidenceChange[];
  id: string;
  roundId: string;
  revision: number;
  state:
    | "draft"
    | "open"
    | "answered"
    | "confirmed"
    | "followed-up"
    | "deferred"
    | "withdrawn"
    | "needs-reconfirmation";
  parentQuestionId: string | null;
  resolutionRevision: number;
  resolvedAt: string | null;
  canAnswer: boolean;
  revisions: (QuestionContent & {
    revision: number;
    actorId: string;
    createdAt: string;
  })[];
  translations?: {
    id: string;
    questionRevision: number;
    locale: string;
    text: string;
    rationale: string;
  }[];
  source?:
    | (import("./source-study.js").SourceEvidence & {
        questionRevision: number;
        number: number;
      })
    | null;
}
export interface Round {
  id: string;
  title: string;
  number: number;
  revision: number;
  state: "draft" | "published";
}
export interface AnswerRevision {
  value: AnswerValue;
  attachments: AnswerAttachment[];
  revision: number;
  questionRevision: number;
  text: string;
  state: "draft" | "submitted";
  channel: "web" | "mcp";
  agentHost: string | null;
  createdAt: string;
}
export interface Answer extends AnswerRevision {
  questionId: string;
  personId: string;
  personName: string;
  eligibleForResolution: boolean;
  revisions: AnswerRevision[];
}
export interface CommentRevision {
  revision: number;
  text: string;
  actorId: string;
  createdAt: string;
}
export interface QuestionComment extends CommentRevision {
  id: string;
  questionId: string;
  personId: string;
  personName: string;
  revisions: CommentRevision[];
}
export type ConcernOutcome = "question" | "fact-source" | "declined";
export interface Concern {
  id: string;
  text: string;
  personId: string;
  personName: string;
  createdAt: string;
  revision: number;
  state: "open" | ConcernOutcome;
  resolution: {
    outcome: ConcernOutcome;
    reason: string | null;
    questionId: string | null;
    actorId: string;
    createdAt: string;
  } | null;
}
export type ConcernDecision = { revision: number } & (
  | { outcome: "question"; roundId: string; question: QuestionContent }
  | { outcome: "fact-source" }
  | { outcome: "declined"; reason: string }
);
export interface ConcernResolutionPreview {
  concern: Concern;
  decision: ConcernDecision;
  confirmationHash: string;
}
export interface ConcernResolutionResult {
  concern: Concern;
  question: Question | null;
}
export interface QuestionnaireView {
  attachmentLimits: {
    maxFileBytes: number;
    maxAnswerBytes: number;
    maxFiles: number;
    mediaTypes: string[];
  };
  personId: string;
  workflow: { id: string; name: string };
  version: {
    id: string;
    number: number;
    locale: string;
    semanticVersion?: string | null;
  };
  capabilities: {
    compose: boolean;
    reviewSuggestions: boolean;
    resolve: boolean;
    acknowledge: boolean;
    comment: boolean;
    raiseConcern: boolean;
    resolveConcern: boolean;
  };
  settings: { revision: number; roundSizeLimit: number | null };
  assignees: { personId: string | null; name: string; role: string }[];
  pins: { skillId: string; skillName: string; hash: string }[];
  rounds: Round[];
  questions: Question[];
  answers: Answer[];
  resolutions: Resolution[];
  facts: ConfirmedFact[];
  comments: QuestionComment[];
  concerns: Concern[];
}
export interface QuestionnaireVersion {
  workflowId: string;
  workflowName: string;
  versionId: string;
  number: number;
  semanticVersion?: string | null;
}
export interface RoundPreview {
  confirmationHash: string;
  questions: {
    id: string;
    text: string;
    priority: number;
    answerType?: AnswerType;
  }[];
}
export class QuestionnaireError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function questionnairePath(workflowId: string, versionId: string) {
  return `/workflows/${encodeURIComponent(workflowId)}/versions/${encodeURIComponent(versionId)}/questionnaire`;
}

/** One JSON boundary, including revision conflicts the editor must not retry blindly. */
export async function questionnaireRequest<T>(
  basePath: string,
  path: string,
  method = "GET",
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(apiUrl(basePath, path), {
    method,
    credentials: "same-origin",
    signal,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const value = await response.json();
  if (!response.ok)
    throw new QuestionnaireError(
      response.status,
      value.error?.message ?? "The request failed",
    );
  return value as T;
}

export interface Resolution {
  origin?: RecordOrigin | null;
  actorName: string;
  id: string;
  questionId: string;
  kind: "confirmed" | "followed-up" | "deferred" | "withdrawn";
  actorId: string;
  reason: string | null;
  deferredKind: string | null;
  skillId: string | null;
  childQuestionId: string | null;
  createdAt: string;
  revision: number;
}
export interface ConfirmedFact {
  origin?: RecordOrigin | null;
  evidenceChanges?: EvidenceChange[];
  attachments?: AnswerAttachment[];
  actorName: string;
  id: string;
  questionId: string;
  resolutionId: string;
  text: string;
  locale: string;
  active: boolean;
  actorId: string;
  createdAt: string;
  hash: string;
  answers: { personId: string; revision: number }[];
  evidence: (QuestionContent["evidence"][number] & { fileHash: string })[];
  acknowledgements: {
    personId: string;
    personName: string;
    decision: "acknowledged" | "disputed";
    reason: string | null;
    createdAt: string;
  }[];
}
