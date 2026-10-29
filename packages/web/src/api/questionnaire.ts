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
  state: "draft" | "open" | "answered";
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
  revisions: AnswerRevision[];
}
export interface QuestionnaireView {
  personId: string;
  workflow: { id: string; name: string };
  version: { id: string; number: number };
  capabilities: { compose: boolean };
  settings: { revision: number; roundSizeLimit: number | null };
  assignees: { personId: string | null; name: string; role: string }[];
  pins: { skillId: string; skillName: string; hash: string }[];
  rounds: Round[];
  questions: Question[];
  answers: Answer[];
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
