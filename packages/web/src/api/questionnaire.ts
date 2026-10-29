import { apiUrl } from "../app/paths.js";

export interface QuestionContent {
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
}
export interface Round {
  id: string;
  title: string;
  number: number;
  revision: number;
  state: "draft" | "published";
}
export interface AnswerRevision {
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
export interface QuestionnaireView {
  personId: string;
  workflow: { id: string; name: string };
  version: { id: string; number: number; locale: string };
  capabilities: { compose: boolean; resolve: boolean; acknowledge: boolean };
  settings: { revision: number; roundSizeLimit: number | null };
  assignees: { personId: string | null; name: string; role: string }[];
  pins: { skillId: string; skillName: string; hash: string }[];
  rounds: Round[];
  questions: Question[];
  answers: Answer[];
  resolutions: Resolution[];
  facts: ConfirmedFact[];
}
export interface QuestionnaireVersion {
  workflowId: string;
  workflowName: string;
  versionId: string;
  number: number;
}
export interface RoundPreview {
  confirmationHash: string;
  questions: { id: string; text: string; priority: number }[];
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
