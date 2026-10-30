import { SEMANTIC_DOSSIER_TOPICS } from "./questionnaire.js";
import { stableValue } from "../util.js";
import {
  validateQuestionnaireRecords,
  type DEFERRED_KINDS,
  type QUESTION_STATES,
  type RESOLUTION_KINDS,
} from "./questionnaire-record-validation.js";

export type QuestionnaireTopic =
  "scope" | (typeof SEMANTIC_DOSSIER_TOPICS)[number];
export interface QuestionnaireRecordReference {
  type: string;
  id: string;
  revision: number;
  hash?: string;
}
export interface QuestionnaireLedgerItem {
  origin?: { workflowVersionId: string; recordId: string; revision: number };
  record: QuestionnaireRecordReference;
  topic: QuestionnaireTopic;
  statement: string;
  state:
    | "draft"
    | "open"
    | "answered"
    | "confirmed"
    | "followed-up"
    | "deferred"
    | "withdrawn"
    | "needs-reconfirmation"
    | "superseded"
    | "disputed"
    | "pending-acknowledgement"
    | "retired"
    | "stale"
    | "source"
    | "studied"
    | "unstudied";
  resolved: boolean;
  relatedRecords: QuestionnaireRecordReference[];
  resolution?: {
    id: string;
    revision: number;
    kind: (typeof RESOLUTION_KINDS)[number];
    reason: string | null;
    deferredKind: (typeof DEFERRED_KINDS)[number] | null;
    skillId: string | null;
  };
}
export interface QuestionnaireQuestionRecord {
  origin?: QuestionnaireLedgerItem["origin"] | null;
  id: string;
  revision: number;
  topic: QuestionnaireTopic;
  text: string;
  state: (typeof QUESTION_STATES)[number];
  resolution?: QuestionnaireLedgerItem["resolution"];
  answers?: { personId: string; revision: number }[];
}
export interface QuestionnaireRecords {
  questions: QuestionnaireQuestionRecord[];
  facts?: {
    origin?: QuestionnaireLedgerItem["origin"] | null;
    id: string;
    questionId: string;
    resolutionId: string;
    resolutionRevision: number;
    questionRevision: number;
    statement: string;
    active: boolean;
    current: boolean;
    actorId: string;
    answers: { personId: string; revision: number }[];
    acknowledgements: {
      id: string;
      personId: string;
      decision: "acknowledged" | "disputed";
    }[];
  }[];
  drafts?: {
    origin?: QuestionnaireLedgerItem["origin"] | null;
    id: string;
    revision: number;
    kind: "inference" | "assumption";
    statement: string;
    topic: QuestionnaireTopic;
    questionId: string | null;
    questionRevision: number | null;
    status: "active" | "retired";
  }[];
  sourceRecords?: {
    origin?: QuestionnaireLedgerItem["origin"] | null;
    id: string;
    revision: number;
    kind: "fact" | "interface";
    statement: string;
    status: "active" | "retired";
    stale: boolean;
  }[];
  pins?: {
    skillId: string;
    skillName: string;
    revision: number;
    hash: string;
    studied: boolean;
  }[];
}
export interface QuestionnaireBlocker {
  code:
    | "unresolved-question"
    | "unconfirmed-inference"
    | "unresolved-assumption"
    | "pending-acknowledgement"
    | "dispute"
    | "stale-source-evidence"
    | "unstudied-pin";
  record: QuestionnaireRecordReference | null;
}
export interface QuestionnaireRecordHandoff {
  schemaVersion: 1;
  kind: "badger-questionnaire-handoff";
  status: "complete" | "incomplete";
  ledger: Record<
    | "confirmedUserFacts"
    | "sourceDerivedFacts"
    | "agentInferences"
    | "unresolvedAssumptions"
    | "remainingQuestions",
    QuestionnaireLedgerItem[]
  >;
  readiness: {
    topic: QuestionnaireTopic;
    ready: boolean;
    blockers: QuestionnaireBlocker[];
  }[];
  items: QuestionnaireLedgerItem[];
  deferredQuestions: QuestionnaireLedgerItem[];
}

/**
 * Ledger items feed round baselines and dossier hashes, so they carry only an
 * origin's three fields, never other keys a caller's record holds.
 */
function itemOrigin(origin: QuestionnaireLedgerItem["origin"] | null) {
  return origin
    ? {
        origin: {
          workflowVersionId: origin.workflowVersionId,
          recordId: origin.recordId,
          revision: origin.revision,
        },
      }
    : {};
}

/** The kernel owns the questionnaire's record-based readiness rules. */
export function questionnaireRecordHandoff(
  records: QuestionnaireRecords,
): QuestionnaireRecordHandoff {
  validateQuestionnaireRecords(records);
  const items = records.questions.map((q): QuestionnaireLedgerItem => ({
    ...itemOrigin(q.origin),
    record: { type: "question", id: q.id, revision: q.revision },
    topic: q.topic,
    statement: q.text,
    state: q.state,
    resolved: ["confirmed", "followed-up", "deferred", "withdrawn"].includes(
      q.state,
    ),
    // Only the resolution's immutable fields enter the item, so round
    // baselines compare equal until the resolution itself changes.
    ...(q.resolution
      ? {
          resolution: {
            id: q.resolution.id,
            revision: q.resolution.revision,
            kind: q.resolution.kind,
            reason: q.resolution.reason ?? null,
            deferredKind: q.resolution.deferredKind ?? null,
            skillId: q.resolution.skillId ?? null,
          },
        }
      : {}),
    relatedRecords: [
      ...(q.resolution
        ? [
            {
              type: "resolution",
              id: q.resolution.id,
              revision: q.resolution.revision,
            },
          ]
        : []),
      ...(q.answers ?? []).map((answer) => ({
        type: "answer",
        id: `${q.id}:${answer.personId}`,
        revision: answer.revision,
      })),
    ],
  }));
  const remainingQuestions = items.filter((q) => !q.resolved);
  const acceptedQuestions = new Set<string>();
  const facts = (records.facts ?? []).map((f): QuestionnaireLedgerItem => {
    const acknowledged =
      f.answers.length > 0 &&
      f.answers.every((a) =>
        f.acknowledgements.some(
          (ack) =>
            ack.personId === a.personId && ack.decision === "acknowledged",
        ),
      );
    const disputed = f.acknowledgements.some((a) => a.decision === "disputed");
    return {
      ...itemOrigin(f.origin),
      record: { type: "confirmed-fact", id: f.id, revision: 1 },
      topic: records.questions.find((q) => q.id === f.questionId)!.topic,
      statement: f.statement,
      state: !f.current
        ? "superseded"
        : disputed
          ? "disputed"
          : !f.active
            ? "superseded"
            : acknowledged
              ? "confirmed"
              : "pending-acknowledgement",
      resolved: f.active && acknowledged && !disputed,
      relatedRecords: [
        {
          type: "question",
          id: f.questionId,
          revision: f.questionRevision,
        },
        {
          type: "resolution",
          id: f.resolutionId,
          revision: f.resolutionRevision,
        },
        ...f.answers.map((a) => ({
          type: "answer",
          id: `${f.questionId}:${a.personId}`,
          revision: a.revision,
        })),
        ...f.acknowledgements.map((a) => ({
          type: "acknowledgement",
          id: a.id,
          revision: 1,
        })),
      ],
    };
  });
  for (const q of records.questions) {
    const current = (records.facts ?? []).filter(
      (f) => f.questionId === q.id && f.current,
    );
    if (
      q.state === "confirmed" &&
      current.length > 0 &&
      current.every((f) =>
        facts.some(
          (item) => item.record.id === f.id && item.state === "confirmed",
        ),
      )
    )
      acceptedQuestions.add(q.id);
  }
  const drafts = (records.drafts ?? []).map((d): QuestionnaireLedgerItem => ({
    ...itemOrigin(d.origin),
    record: { type: d.kind, id: d.id, revision: d.revision },
    topic: d.topic,
    statement: d.statement,
    // A linked draft follows its question's revisions: the resolution
    // preview that a person signs off lists and binds every linked draft,
    // and a resolved question accepts no new link or changed meaning.
    // questionRevision records the revision the draft was linked at.
    state:
      d.status === "retired"
        ? "retired"
        : d.questionId !== null &&
            acceptedQuestions.has(d.questionId) &&
            records.questions.some(
              (q) => q.id === d.questionId && q.topic === d.topic,
            )
          ? "confirmed"
          : "draft",
    resolved: false,
    relatedRecords:
      d.questionId === null ||
      !records.questions.some((q) => q.id === d.questionId)
        ? []
        : [
            {
              type: "question",
              id: d.questionId,
              revision: d.questionRevision!,
            },
          ],
  }));
  for (const d of drafts) d.resolved = d.state !== "draft";
  const activeDrafts = drafts.filter((d) => d.state !== "retired");
  const sources = (records.sourceRecords ?? []).map(
    (r): QuestionnaireLedgerItem => ({
      ...itemOrigin(r.origin),
      record: {
        type: r.kind === "fact" ? "source-fact" : "source-interface",
        id: r.id,
        revision: r.revision,
      },
      topic: r.kind === "interface" ? "interfaces" : "scope",
      statement: r.statement,
      state: r.status === "retired" ? "retired" : r.stale ? "stale" : "source",
      resolved: !r.stale || r.status === "retired",
      relatedRecords: [],
    }),
  );
  const pins = (records.pins ?? []).map((p): QuestionnaireLedgerItem => ({
    record: {
      type: "skill-pin",
      id: p.skillId,
      revision: p.revision,
      hash: p.hash,
    },
    topic: "scope",
    statement: p.skillName,
    state: p.studied ? "studied" : "unstudied",
    resolved: p.studied,
    relatedRecords: [],
  }));
  items.push(...facts, ...drafts, ...sources, ...pins);
  const readiness = (["scope", ...SEMANTIC_DOSSIER_TOPICS] as const).map(
    (topic) => {
      const blockers: QuestionnaireBlocker[] = remainingQuestions
        .filter((q) => q.topic === topic)
        .map((q) => ({ code: "unresolved-question", record: q.record }));
      blockers.push(
        ...activeDrafts
          .filter((d) => d.topic === topic && !d.resolved)
          .map((d): QuestionnaireBlocker => ({
            code:
              d.record.type === "inference"
                ? "unconfirmed-inference"
                : "unresolved-assumption",
            record: d.record,
          })),
      );
      blockers.push(
        ...facts
          .filter(
            (f) =>
              f.topic === topic &&
              ["pending-acknowledgement", "disputed"].includes(f.state),
          )
          .map((f): QuestionnaireBlocker => ({
            code:
              f.state === "disputed" ? "dispute" : "pending-acknowledgement",
            record: f.record,
          })),
      );
      blockers.push(
        ...sources
          .filter((s) => s.topic === topic && s.state === "stale")
          .map((s): QuestionnaireBlocker => ({
            code: "stale-source-evidence",
            record: s.record,
          })),
      );
      blockers.push(
        ...pins
          .filter((p) => !p.resolved)
          .map((p): QuestionnaireBlocker => ({
            code: "unstudied-pin",
            record: p.record,
          })),
      );
      return { topic, ready: blockers.length === 0, blockers };
    },
  );
  return structuredClone({
    schemaVersion: 1,
    kind: "badger-questionnaire-handoff",
    status: readiness.every((r) => r.ready) ? "complete" : "incomplete",
    ledger: {
      confirmedUserFacts: facts.filter((f) => f.state === "confirmed"),
      sourceDerivedFacts: sources.filter(
        (s) => s.record.type === "source-fact" && s.state !== "retired",
      ),
      agentInferences: activeDrafts.filter(
        (d) => d.record.type === "inference",
      ),
      unresolvedAssumptions: activeDrafts.filter(
        (d) => d.record.type === "assumption" && !d.resolved,
      ),
      remainingQuestions,
    },
    readiness,
    items,
    deferredQuestions: items.filter(
      (i) => i.record.type === "question" && i.state === "deferred",
    ),
  });
}

/** Compare immutable publication baselines by record identity, including sign-off changes. */
export function questionnaireLedgerChanges(
  before: QuestionnaireLedgerItem[],
  after: QuestionnaireLedgerItem[],
) {
  const identity = (item: QuestionnaireLedgerItem) =>
    `${item.record.type}:${item.record.id}`;
  const previous = new Map(before.map((item) => [identity(item), item]));
  const current = new Map(after.map((item) => [identity(item), item]));
  const added: QuestionnaireLedgerItem[] = [];
  const changed: {
    before: QuestionnaireLedgerItem;
    after: QuestionnaireLedgerItem | null;
  }[] = [];
  const resolved: {
    before: QuestionnaireLedgerItem;
    after: QuestionnaireLedgerItem;
  }[] = [];
  for (const item of after) {
    const old = previous.get(identity(item));
    if (!old) added.push(item);
    else if (
      JSON.stringify(stableValue(old)) !== JSON.stringify(stableValue(item))
    ) {
      if (!old.resolved && item.resolved)
        resolved.push({ before: old, after: item });
      else changed.push({ before: old, after: item });
    }
  }
  for (const item of before)
    if (!current.has(identity(item)))
      changed.push({ before: item, after: null });
  return { added, changed, resolved };
}
