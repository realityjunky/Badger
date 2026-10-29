import { SEMANTIC_DOSSIER_TOPICS } from "@realityjunky/badger";
import { objectInput, RequestError } from "../http/errors.js";

export interface QuestionTarget {
  kind: "workflow" | "node" | "skill" | "interface";
  id: string;
}
export interface QuestionEvidence {
  skillId: string;
  versionHash: string;
  path: string;
  startLine: number;
  endLine: number;
}
export type QuestionAssignee =
  | { kind: "person"; personId: string }
  | { kind: "role"; role: "Workflow owner" | "Field expert" };
export interface QuestionContent {
  text: string;
  topic: string;
  targets: QuestionTarget[];
  rationale: string;
  evidence: QuestionEvidence[];
  assignees: QuestionAssignee[];
  priority: number;
}
export interface QuestionRevision extends QuestionContent {
  revision: number;
  actorId: string;
  createdAt: string;
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
  position: number | null;
  resolvedAt: string | null;
  revisions: QuestionRevision[];
  canAnswer: boolean;
}
export interface QuestionRound {
  id: string;
  number: number;
  title: string;
  state: "draft" | "published";
  revision: number;
  publishedAt: string | null;
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
  personId: string;
  personName: string;
  text: string;
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

export function parseConcernDecision(
  input: Record<string, unknown>,
  commit: boolean,
): ConcernDecision {
  const extra = commit ? ["confirmed", "confirmationHash"] : [];
  const revision = revisionInput(input.revision);
  if (input.outcome === "question") {
    fields(input, ["outcome", "revision", "roundId", "question", ...extra]);
    const question = objectInput(input.question);
    if ("revision" in question)
      throw new RequestError(400, "A concern creates a new draft question");
    return {
      revision,
      outcome: "question",
      roundId: textInput(input.roundId, "roundId", 200),
      question: parseQuestion(question),
    };
  }
  if (input.outcome === "fact-source") {
    fields(input, ["outcome", "revision", ...extra]);
    return { revision, outcome: "fact-source" };
  }
  if (input.outcome === "declined") {
    fields(input, ["outcome", "revision", "reason", ...extra]);
    return {
      revision,
      outcome: "declined",
      reason: textInput(input.reason, "reason"),
    };
  }
  throw new RequestError(
    400,
    "Turn the concern into a question, accept it as a fact source, or decline it with a reason",
  );
}

export function textInput(value: unknown, name: string, max = 4000): string {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw new RequestError(400, `${name} must contain 1 to ${max} characters`);
  return value;
}
export function revisionInput(value: unknown, minimum = 1): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum)
    throw new RequestError(400, "Quote the current record revision");
  return value as number;
}
export function fields(input: Record<string, unknown>, allowed: string[]) {
  const unknown = Object.keys(input).find((key) => !allowed.includes(key));
  if (unknown !== undefined)
    throw new RequestError(400, `Unknown field ${unknown}`);
}
function arrayInput(value: unknown, name: string): unknown[] {
  if (!Array.isArray(value))
    throw new RequestError(400, `${name} must be an array`);
  return value;
}

export function parseQuestion(input: Record<string, unknown>): QuestionContent {
  fields(input, [
    "text",
    "topic",
    "targets",
    "rationale",
    "evidence",
    "assignees",
    "priority",
    "revision",
  ]);
  const topic = textInput(input.topic, "topic", 100);
  if (!["scope", ...SEMANTIC_DOSSIER_TOPICS].includes(topic))
    throw new RequestError(400, "Use a dossier topic or scope");
  if (
    !Number.isSafeInteger(input.priority) ||
    (input.priority as number) < 0 ||
    (input.priority as number) > 100
  )
    throw new RequestError(400, "priority must be an integer from 0 to 100");
  const targets = arrayInput(input.targets, "targets").map((raw) => {
    const target = objectInput(raw);
    fields(target, ["kind", "id"]);
    if (
      !["workflow", "node", "skill", "interface"].includes(
        target.kind as string,
      )
    )
      throw new RequestError(
        400,
        "Use a workflow, node, skill, or interface target",
      );
    return {
      kind: target.kind as QuestionTarget["kind"],
      id: textInput(target.id, "target id", 200),
    };
  });
  const assignees = arrayInput(input.assignees, "assignees").map((raw) => {
    const assignee = objectInput(raw);
    fields(assignee, ["kind", "personId", "role"]);
    if (assignee.kind === "person")
      return {
        kind: "person" as const,
        personId: textInput(assignee.personId, "personId", 200),
      };
    if (
      assignee.kind !== "role" ||
      !["Workflow owner", "Field expert"].includes(assignee.role as string)
    )
      throw new RequestError(
        400,
        "Assign a named expert, the Workflow owner, or Field experts",
      );
    return {
      kind: "role" as const,
      role: assignee.role as "Workflow owner" | "Field expert",
    };
  });
  if (targets.length === 0 || assignees.length === 0)
    throw new RequestError(400, "A question needs targets and assignees");
  const evidence = arrayInput(input.evidence, "evidence").map((raw) => {
    const link = objectInput(raw);
    fields(link, ["skillId", "versionHash", "path", "startLine", "endLine"]);
    const path = textInput(link.path, "evidence path", 1024);
    if (
      path.startsWith("/") ||
      path.includes("\\") ||
      path
        .split("/")
        .some((part) => part === ".." || part === "." || part === "")
    )
      throw new RequestError(
        400,
        "Evidence paths must be relative Skill file paths",
      );
    const startLine = revisionInput(link.startLine);
    const endLine = revisionInput(link.endLine);
    if (
      endLine < startLine ||
      typeof link.versionHash !== "string" ||
      !/^[a-f0-9]{64}$/u.test(link.versionHash)
    )
      throw new RequestError(
        400,
        "Evidence needs a version hash and an ordered line range",
      );
    return {
      skillId: textInput(link.skillId, "skillId", 200),
      versionHash: link.versionHash,
      path,
      startLine,
      endLine,
    };
  });
  return {
    text: textInput(input.text, "text", 20000),
    topic,
    targets,
    rationale: textInput(input.rationale, "rationale"),
    evidence,
    assignees,
    priority: input.priority as number,
  };
}
