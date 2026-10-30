import type {
  QuestionnaireQuestionRecord,
  QuestionnaireRecords,
} from "./questionnaire-records.js";
import { SEMANTIC_DOSSIER_TOPICS } from "./questionnaire.js";

// The record types take their unions from these lists, so a record that
// type-checks is never refused for one of these fields.
export const QUESTION_STATES = [
  "draft",
  "open",
  "answered",
  "confirmed",
  "followed-up",
  "deferred",
  "withdrawn",
  "needs-reconfirmation",
] as const;
export const RESOLUTION_KINDS = [
  "confirmed",
  "followed-up",
  "deferred",
  "withdrawn",
] as const;
export const DEFERRED_KINDS = ["skill-internal", "out-of-scope"] as const;

type FieldRule = readonly [(value: unknown) => boolean, string];
const text: FieldRule = [
  (value) => typeof value === "string" && value.trim() !== "",
  "a non-empty string",
];
const object: FieldRule = [
  (value) =>
    value !== null && typeof value === "object" && !Array.isArray(value),
  "an object",
];
const array: FieldRule = [Array.isArray, "an array"];
const boolean: FieldRule = [(value) => typeof value === "boolean", "a boolean"];
const revision: FieldRule = [
  (value) =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= 1,
  "a positive integer",
];

function choice(values: readonly string[]): FieldRule {
  return [
    (value) => typeof value === "string" && values.includes(value),
    values.join(" or "),
  ];
}

function nullable(rule: FieldRule): FieldRule {
  return [(value) => value === null || rule[0](value), `null or ${rule[1]}`];
}

function invalid(kind: string, id: unknown, problem: string): never {
  throw new Error(
    `Invalid ${kind} "${typeof id === "string" ? id : "<missing ID>"}": ${problem}`,
  );
}

function fields(
  kind: string,
  record: unknown,
  rules: Record<string, FieldRule>,
  idField = "id",
): asserts record is Record<string, unknown> {
  if (!object[0](record)) invalid(kind, undefined, "record must be an object");
  const value = record as Record<string, unknown>;
  for (const [field, [valid, description]] of Object.entries(rules))
    if (!valid(value[field]))
      invalid(kind, value[idField], `${field} must be ${description}`);
}

function optional(rule: FieldRule): FieldRule {
  return [(value) => value === undefined || rule[0](value), rule[1]];
}

function recordOrigin(kind: string, record: { id: string; origin?: unknown }) {
  if (record.origin === undefined || record.origin === null) return;
  if (!object[0](record.origin))
    invalid(kind, record.id, "origin must be an object or null");
  const origin = record.origin as Record<string, unknown>;
  for (const [field, [valid, description]] of Object.entries({
    workflowVersionId: text,
    recordId: text,
    revision,
  }))
    if (!valid(origin[field]))
      invalid(kind, record.id, `origin.${field} must be ${description}`);
}

function uniqueIdentities(kind: string, ids: readonly string[]) {
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) invalid(kind, id, "duplicate record identity");
    seen.add(id);
  }
}

export function validateQuestionnaireRecords(records: QuestionnaireRecords) {
  fields("questionnaire", records, {
    questions: array,
    facts: optional(array),
    drafts: optional(array),
    sourceRecords: optional(array),
    pins: optional(array),
  });
  for (const question of records.questions) {
    fields("question", question, {
      id: text,
      state: [
        (value) =>
          typeof value === "string" &&
          (QUESTION_STATES as readonly string[]).includes(value),
        "a question state",
      ],
      answers: optional(array),
      resolution: optional(object),
    });
    recordOrigin("question", question);
    if (!Number.isSafeInteger(question.revision) || question.revision < 1)
      throw new Error(
        `Invalid question "${question.id}": revision must be a positive integer`,
      );
    if (typeof question.text !== "string" || question.text.trim() === "")
      throw new Error(
        `Invalid question "${question.id}": text must be a non-empty string`,
      );
    if (
      !(["scope", ...SEMANTIC_DOSSIER_TOPICS] as string[]).includes(
        question.topic,
      )
    )
      throw new Error(
        `Invalid question "${question.id}": topic "${String(question.topic)}" is unknown`,
      );
    if (question.resolution !== undefined)
      fields("resolution", question.resolution, {
        id: text,
        revision,
        kind: choice(RESOLUTION_KINDS),
        reason: nullable(text),
        deferredKind: nullable(choice(DEFERRED_KINDS)),
        skillId: nullable(text),
      });
    for (const answer of question.answers ?? [])
      fields(
        `answer for question "${question.id}"`,
        answer,
        {
          personId: text,
          revision,
        },
        "personId",
      );
    uniqueIdentities(
      `answer for question "${question.id}"`,
      (question.answers ?? []).map((answer) => answer.personId),
    );
  }
  // References resolve through indexes built once, so the checks below stay
  // linear in the records. Like a scan, they keep the first question with an
  // ID; a duplicate is refused at the end.
  const questions = new Map<string, QuestionnaireQuestionRecord>();
  const answerHeads = new Map<string, Map<string, { revision: number }>>();
  for (const question of records.questions) {
    if (questions.has(question.id)) continue;
    questions.set(question.id, question);
    if (question.answers !== undefined)
      answerHeads.set(
        question.id,
        new Map(question.answers.map((answer) => [answer.personId, answer])),
      );
  }
  for (const fact of records.facts ?? []) {
    fields("fact", fact, {
      id: text,
      questionId: text,
      resolutionId: text,
      resolutionRevision: revision,
      questionRevision: revision,
      statement: text,
      active: boolean,
      current: boolean,
      actorId: text,
      answers: array,
      acknowledgements: array,
    });
    recordOrigin("fact", fact);
    for (const answer of fact.answers)
      fields(
        `answer for fact "${fact.id}"`,
        answer,
        {
          personId: text,
          revision,
        },
        "personId",
      );
    for (const acknowledgement of fact.acknowledgements)
      fields("acknowledgement", acknowledgement, {
        id: text,
        personId: text,
        decision: choice(["acknowledged", "disputed"]),
      });
    uniqueIdentities(
      `answer for fact "${fact.id}"`,
      fact.answers.map((answer) => answer.personId),
    );
    const question = questions.get(fact.questionId);
    if (!question)
      throw new Error(
        `Invalid fact "${fact.id}": questionId "${fact.questionId}" names a missing question`,
      );
    if (fact.questionRevision > question.revision)
      invalid(
        "fact",
        fact.id,
        "questionRevision names a missing question revision",
      );
    // Only current resolution and submitted-answer heads are projected by
    // the service. Superseded facts retain references to their older records.
    if (fact.current) {
      if (fact.resolutionId !== question.resolution?.id)
        invalid(
          "fact",
          fact.id,
          `resolutionId "${fact.resolutionId}" does not name the question's current resolution`,
        );
      if (fact.resolutionRevision !== question.resolution?.revision)
        invalid(
          "fact",
          fact.id,
          "resolutionRevision does not name the question's current resolution revision",
        );
    }
    const heads = answerHeads.get(question.id);
    if (heads !== undefined)
      for (const answer of fact.answers) {
        const head = heads.get(answer.personId);
        if (!head)
          invalid(
            `answer for fact "${fact.id}"`,
            answer.personId,
            "personId does not name an answer to the linked question",
          );
        if (answer.revision > head.revision)
          invalid(
            `answer for fact "${fact.id}"`,
            answer.personId,
            "revision names a missing answer revision",
          );
      }
    const cited = new Set(fact.answers.map((answer) => answer.personId));
    for (const acknowledgement of fact.acknowledgements)
      if (!cited.has(acknowledgement.personId))
        invalid(
          "acknowledgement",
          acknowledgement.id,
          `personId "${acknowledgement.personId}" does not name an answer cited by fact "${fact.id}"`,
        );
  }
  for (const draft of records.drafts ?? []) {
    fields("draft", draft, {
      id: text,
      revision,
      kind: choice(["inference", "assumption"]),
      statement: text,
      topic: choice(["scope", ...SEMANTIC_DOSSIER_TOPICS]),
      questionId: nullable(text),
      questionRevision: nullable(revision),
      status: choice(["active", "retired"]),
    });
    recordOrigin("draft", draft);
    const question =
      draft.questionId === null ? undefined : questions.get(draft.questionId);
    if (draft.questionId !== null && !question)
      invalid(
        "draft",
        draft.id,
        `questionId "${draft.questionId}" names a missing question`,
      );
    // Older links retain the topic of that historical question revision.
    // The handoff leaves them unresolved if the current topic has changed.
    if (
      question &&
      draft.questionRevision === question.revision &&
      draft.topic !== question.topic
    )
      invalid(
        "draft",
        draft.id,
        `topic must match linked question "${question.id}"`,
      );
    if (
      (draft.questionId === null) !== (draft.questionRevision === null) ||
      (question && draft.questionRevision! > question.revision)
    )
      invalid(
        "draft",
        draft.id,
        "questionRevision must identify an existing revision of the linked question, or be null without a questionId",
      );
  }
  for (const source of records.sourceRecords ?? []) {
    fields("source record", source, {
      id: text,
      revision,
      kind: choice(["fact", "interface"]),
      statement: text,
      status: choice(["active", "retired"]),
      stale: boolean,
    });
    recordOrigin("source record", source);
  }
  for (const pin of records.pins ?? [])
    fields(
      "skill pin",
      pin,
      {
        skillId: text,
        skillName: text,
        revision,
        hash: text,
        studied: boolean,
      },
      "skillId",
    );
  uniqueIdentities(
    "question",
    records.questions.map((q) => q.id),
  );
  uniqueIdentities(
    "resolution",
    records.questions.flatMap((q) => (q.resolution ? [q.resolution.id] : [])),
  );
  uniqueIdentities(
    "fact",
    (records.facts ?? []).map((f) => f.id),
  );
  uniqueIdentities(
    "acknowledgement",
    (records.facts ?? []).flatMap((f) => f.acknowledgements.map((a) => a.id)),
  );
  uniqueIdentities(
    "draft",
    (records.drafts ?? []).map((d) => d.id),
  );
  uniqueIdentities(
    "source record",
    (records.sourceRecords ?? []).map((s) => s.id),
  );
  uniqueIdentities(
    "skill pin",
    (records.pins ?? []).map((p) => p.skillId),
  );
}
