import { describe, expect, it } from "vitest";
import {
  createQuestionnaireHandoff,
  type QuestionnaireRecords,
} from "../src/index.js";
import { validateQuestionnaireRecords } from "../src/factory/questionnaire-record-validation.js";

describe("questionnaire record handoff validation", () => {
  const question = {
    id: "question-1",
    revision: 1,
    topic: "scope" as const,
    text: "Which workflow?",
    state: "open" as const,
  };
  const fact = {
    id: "fact-1",
    questionId: question.id,
    resolutionId: "resolution-1",
    resolutionRevision: 1,
    questionRevision: 1,
    statement: "The workflow studies samples.",
    active: false,
    current: false,
    actorId: "engineer-1",
    answers: [{ personId: "expert-1", revision: 1 }],
    acknowledgements: [],
  };
  const resolution = {
    id: "resolution-1",
    revision: 1,
    kind: "confirmed",
    reason: null,
    deferredKind: null,
    skillId: null,
  };
  const draft = {
    id: "inference-1",
    revision: 1,
    kind: "inference" as const,
    statement: "Use the supplied samples.",
    topic: "scope" as const,
    questionId: null,
    questionRevision: null,
    status: "active" as const,
  };
  const sourceRecord = {
    id: "source-fact-1",
    revision: 1,
    kind: "fact" as const,
    statement: "Sources describe sample inputs.",
    status: "active" as const,
    stale: false,
  };
  const pin = {
    skillId: "skill-1",
    skillName: "Source Skill",
    revision: 1,
    hash: "a".repeat(64),
    studied: true,
  };

  it("names a question whose required text is missing", () => {
    const records = {
      questions: [
        { id: "question-1", revision: 1, topic: "scope", state: "open" },
      ],
    };

    expect(() =>
      createQuestionnaireHandoff({
        records: records as unknown as QuestionnaireRecords,
      }),
    ).toThrow(/question "question-1".*text.*string/u);
  });

  it("names a question whose revision has the wrong type", () => {
    expect(() =>
      createQuestionnaireHandoff({
        records: {
          questions: [{ ...question, revision: "1" }],
        } as unknown as QuestionnaireRecords,
      }),
    ).toThrow(/question "question-1".*revision.*positive integer/u);
  });

  it.each([
    ["workflowVersionId", 4],
    ["recordId", null],
    ["revision", "wrong"],
  ])("names a question with a malformed origin %s", (field, value) => {
    expect(() =>
      createQuestionnaireHandoff({
        records: {
          questions: [
            {
              ...question,
              origin: {
                workflowVersionId: "previous-version",
                recordId: "previous-question",
                revision: 1,
                [field]: value,
              },
            },
          ],
        } as unknown as QuestionnaireRecords,
      }),
    ).toThrow(new RegExp(`question "question-1".*origin\\.${field}`, "u"));
  });

  for (const [collection, kind, record] of [
    ["questions", "question", question],
    ["facts", "fact", fact],
    ["drafts", "draft", draft],
    ["sourceRecords", "source record", sourceRecord],
  ] as const) {
    it.each([
      false,
      [],
      {},
      {
        workflowVersionId: "previous-version",
        recordId: "previous-record",
        revision: 0,
      },
    ])(`refuses malformed origin on a ${kind}: %j`, (origin) => {
      expect(() =>
        createQuestionnaireHandoff({
          records: {
            questions: [question],
            [collection]: [{ ...record, origin }],
          } as unknown as QuestionnaireRecords,
        }),
      ).toThrow(new RegExp(`${kind} "${record.id}".*origin`, "u"));
    });

    it.each([
      undefined,
      null,
      {
        workflowVersionId: "previous-version",
        recordId: "previous-record",
        revision: 2,
      },
    ])(`accepts supported origin on a ${kind}: %j`, (origin) => {
      expect(() =>
        createQuestionnaireHandoff({
          records: {
            questions: [question],
            [collection]: [{ ...record, origin }],
          },
        }),
      ).not.toThrow();
    });
  }

  it("copies only an origin's version, record, and revision into ledger items", () => {
    const origin = {
      workflowVersionId: "previous-version",
      recordId: "previous-record",
      revision: 2,
    };
    // Ledger items feed round baselines and dossier hashes, so a key the
    // contract does not name must not reach them.
    const handoff = (recorded: typeof origin) =>
      createQuestionnaireHandoff({
        records: {
          questions: [{ ...question, origin: recorded }],
          facts: [{ ...fact, origin: recorded }],
          drafts: [{ ...draft, origin: recorded }],
          sourceRecords: [{ ...sourceRecord, origin: recorded }],
        },
      });
    const annotated = { ...origin, copiedBy: "engineer-1" };
    const extended = handoff(annotated);

    expect(extended.items.map((item) => item.origin)).toEqual(
      Array(4).fill(origin),
    );
    expect(extended).toEqual(handoff(origin));
  });

  it.each(["unknown-topic", Symbol("unknown-topic")])(
    "refuses an unknown topic %s before computing the ledger",
    (topic) => {
      expect(() =>
        createQuestionnaireHandoff({
          records: {
            questions: [{ ...question, topic }],
          } as unknown as QuestionnaireRecords,
        }),
      ).toThrow(/question "question-1".*topic.*unknown-topic/u);
    },
  );

  it("names a fact whose question does not exist", () => {
    expect(() =>
      createQuestionnaireHandoff({
        records: {
          questions: [question],
          facts: [{ ...fact, questionId: "missing-question" }],
        },
      }),
    ).toThrow(/fact "fact-1".*questionId.*missing-question/u);
  });

  it.each([
    ["id", undefined],
    ["id", 12],
    ["revision", 0],
    ["revision", 1.5],
    ["text", false],
    ["state", "unknown-state"],
    ["answers", {}],
    ["resolution", null],
  ])("refuses a malformed question %s field", (field, value) => {
    expect(() =>
      createQuestionnaireHandoff({
        records: {
          questions: [{ ...question, [field as string]: value }],
        } as unknown as QuestionnaireRecords,
      }),
    ).toThrow(new RegExp(`question .*${field as string}`, "u"));
  });

  it.each([
    ["id", undefined],
    ["revision", "1"],
    ["kind", "invented"],
    ["reason", false],
    ["deferredKind", 1],
    ["skillId", {}],
  ])("names a malformed resolution %s field", (field, value) => {
    expect(() =>
      createQuestionnaireHandoff({
        records: {
          questions: [
            {
              ...question,
              resolution: { ...resolution, [field as string]: value },
            },
          ],
        } as unknown as QuestionnaireRecords,
      }),
    ).toThrow(new RegExp(`resolution .*${field as string}`, "u"));
  });

  it.each([
    ["personId", undefined],
    ["revision", false],
  ])("names a malformed answer %s field and its question", (field, value) => {
    expect(() =>
      createQuestionnaireHandoff({
        records: {
          questions: [
            {
              ...question,
              answers: [
                { personId: "expert-1", revision: 1, [field as string]: value },
              ],
            },
          ],
        } as unknown as QuestionnaireRecords,
      }),
    ).toThrow(new RegExp(`answer .*question-1.*${field as string}`, "u"));
  });

  it.each([
    ["id", null],
    ["questionId", undefined],
    ["resolutionId", null],
    ["resolutionRevision", 0],
    ["questionRevision", false],
    ["statement", []],
    ["active", "false"],
    ["current", "false"],
    ["actorId", undefined],
    ["answers", null],
    ["acknowledgements", null],
  ])("names a malformed fact %s field", (field, value) => {
    expect(() =>
      createQuestionnaireHandoff({
        records: {
          questions: [question],
          facts: [{ ...fact, [field as string]: value }],
        } as unknown as QuestionnaireRecords,
      }),
    ).toThrow(new RegExp(`fact .*${field as string}`, "u"));
  });

  it("names a malformed answer in a fact's provenance", () => {
    expect(() =>
      createQuestionnaireHandoff({
        records: {
          questions: [question],
          facts: [
            { ...fact, answers: [{ personId: "expert-1", revision: "1" }] },
          ],
        } as unknown as QuestionnaireRecords,
      }),
    ).toThrow(/answer .*fact-1.*expert-1.*revision/u);
  });

  it.each([
    ["id", undefined],
    ["personId", false],
    ["decision", "approved"],
  ])("names a malformed acknowledgement %s field", (field, value) => {
    expect(() =>
      createQuestionnaireHandoff({
        records: {
          questions: [question],
          facts: [
            {
              ...fact,
              acknowledgements: [
                {
                  id: "ack-1",
                  personId: "expert-1",
                  decision: "acknowledged",
                  [field as string]: value,
                },
              ],
            },
          ],
        } as unknown as QuestionnaireRecords,
      }),
    ).toThrow(new RegExp(`acknowledgement .*${field as string}`, "u"));
  });

  it.each([
    ["id", undefined],
    ["revision", -1],
    ["kind", "fact"],
    ["statement", false],
    ["topic", "unknown-topic"],
    ["questionId", 1],
    ["questionRevision", "1"],
    ["status", "accepted"],
  ])("names a malformed draft %s field", (field, value) => {
    expect(() =>
      createQuestionnaireHandoff({
        records: {
          questions: [question],
          drafts: [{ ...draft, [field as string]: value }],
        } as unknown as QuestionnaireRecords,
      }),
    ).toThrow(new RegExp(`draft .*${field as string}`, "u"));
  });

  it.each(["inference", "assumption"] as const)(
    "refuses a %s linked to a missing question",
    (kind) => {
      expect(() =>
        createQuestionnaireHandoff({
          records: {
            questions: [question],
            drafts: [
              {
                ...draft,
                kind,
                questionId: "missing-question",
                questionRevision: 1,
              },
            ],
          },
        }),
      ).toThrow(/draft "inference-1".*questionId.*missing-question/u);
    },
  );

  it.each([
    { questionId: question.id, questionRevision: null },
    { questionId: null, questionRevision: 1 },
    { questionId: question.id, questionRevision: 2 },
  ])("refuses an inconsistent draft link %j", (link) => {
    expect(() =>
      createQuestionnaireHandoff({
        records: { questions: [question], drafts: [{ ...draft, ...link }] },
      }),
    ).toThrow(/draft "inference-1".*questionRevision/u);
  });

  it("refuses a draft that borrows confirmation from another topic", () => {
    expect(() =>
      createQuestionnaireHandoff({
        records: {
          questions: [
            {
              ...question,
              topic: "inputs",
              state: "confirmed",
              resolution,
              answers: fact.answers,
            },
          ],
          facts: [
            {
              ...fact,
              active: true,
              current: true,
              acknowledgements: [
                {
                  id: "ack-1",
                  personId: "expert-1",
                  decision: "acknowledged",
                },
              ],
            },
          ],
          drafts: [
            {
              ...draft,
              topic: "outputSchemas",
              questionId: question.id,
              questionRevision: 1,
            },
          ],
        },
      }),
    ).toThrow(/draft "inference-1".*topic.*question-1/u);
  });

  it("keeps an older draft link unresolved after its question moves to another topic", () => {
    const handoff = createQuestionnaireHandoff({
      records: {
        questions: [
          {
            ...question,
            revision: 2,
            topic: "inputs",
            state: "confirmed",
            resolution: { ...resolution, revision: 2 },
            answers: fact.answers,
          },
        ],
        facts: [
          {
            ...fact,
            questionRevision: 2,
            resolutionRevision: 2,
            active: true,
            current: true,
            acknowledgements: [
              { id: "ack-1", personId: "expert-1", decision: "acknowledged" },
            ],
          },
        ],
        drafts: [{ ...draft, questionId: question.id, questionRevision: 1 }],
      },
    });
    expect(handoff.ledger.agentInferences).toEqual([
      expect.objectContaining({
        record: { type: "inference", id: draft.id, revision: 1 },
        state: "draft",
        resolved: false,
        relatedRecords: [{ type: "question", id: question.id, revision: 1 }],
      }),
    ]);
    expect(handoff.readiness.find((r) => r.topic === "scope")).toMatchObject({
      ready: false,
      blockers: [expect.objectContaining({ code: "unconfirmed-inference" })],
    });
  });

  it.each([
    ["id", undefined],
    ["revision", Number.NaN],
    ["kind", "question"],
    ["statement", 3],
    ["status", "unknown-status"],
    ["stale", "false"],
  ])("names a malformed Source study record %s field", (field, value) => {
    expect(() =>
      createQuestionnaireHandoff({
        records: {
          questions: [],
          sourceRecords: [{ ...sourceRecord, [field as string]: value }],
        } as unknown as QuestionnaireRecords,
      }),
    ).toThrow(new RegExp(`source record .*${field as string}`, "u"));
  });

  it.each([
    ["skillId", undefined],
    ["skillName", []],
    ["revision", Number.POSITIVE_INFINITY],
    ["hash", null],
    ["studied", "true"],
  ])("names a malformed Skill pin %s field", (field, value) => {
    expect(() =>
      createQuestionnaireHandoff({
        records: {
          questions: [],
          pins: [{ ...pin, [field as string]: value }],
        } as unknown as QuestionnaireRecords,
      }),
    ).toThrow(new RegExp(`skill pin .*${field as string}`, "u"));
  });

  it.each([null, {}, [], { questions: null }, { questions: {} }])(
    "refuses a malformed record set %j",
    (records) => {
      expect(() =>
        createQuestionnaireHandoff({
          records: records as QuestionnaireRecords,
        }),
      ).toThrow(/questionnaire .*object|questionnaire .*questions/u);
    },
  );

  it.each(["facts", "drafts", "sourceRecords", "pins"] as const)(
    "refuses a non-array %s collection",
    (kind) => {
      expect(() =>
        createQuestionnaireHandoff({
          records: {
            questions: [],
            [kind]: {},
          } as unknown as QuestionnaireRecords,
        }),
      ).toThrow(new RegExp(`questionnaire .*${kind}`, "u"));
    },
  );

  it.each([
    ["questions", "question"],
    ["facts", "fact"],
    ["drafts", "draft"],
    ["sourceRecords", "source record"],
    ["pins", "skill pin"],
  ])("refuses a non-object record in %s", (collection, kind) => {
    expect(() =>
      createQuestionnaireHandoff({
        records: {
          questions: [],
          [collection]: [null],
        } as unknown as QuestionnaireRecords,
      }),
    ).toThrow(new RegExp(`${kind} .*object`, "u"));
  });

  it.each([
    ["questionRevision", 2],
    ["resolutionId", "missing-resolution"],
    ["resolutionRevision", 2],
  ])("refuses a current fact with an invalid %s reference", (field, value) => {
    expect(() =>
      createQuestionnaireHandoff({
        records: {
          questions: [{ ...question, resolution }],
          facts: [{ ...fact, current: true, [field as string]: value }],
        } as unknown as QuestionnaireRecords,
      }),
    ).toThrow(new RegExp(`fact "fact-1".*${field as string}`, "u"));
  });

  it.each([
    { personId: "missing-expert", revision: 1 },
    { personId: "expert-1", revision: 2 },
  ])("refuses a fact citing an unavailable answer %j", (answer) => {
    expect(() =>
      createQuestionnaireHandoff({
        records: {
          questions: [
            { ...question, answers: [{ personId: "expert-1", revision: 1 }] },
          ],
          facts: [{ ...fact, answers: [answer] }],
        },
      }),
    ).toThrow(/answer .*fact-1.*personId|answer .*fact-1.*revision/u);
  });

  it("refuses an acknowledgement from a person whose answer the fact does not cite", () => {
    expect(() =>
      createQuestionnaireHandoff({
        records: {
          questions: [question],
          facts: [
            {
              ...fact,
              acknowledgements: [
                {
                  id: "ack-1",
                  personId: "missing-expert",
                  decision: "acknowledged",
                },
              ],
            },
          ],
        },
      }),
    ).toThrow(/acknowledgement "ack-1".*personId.*missing-expert/u);
  });

  it("preserves historical fact provenance when current resolution and answer heads have advanced", () => {
    const handoff = createQuestionnaireHandoff({
      records: {
        questions: [
          {
            ...question,
            revision: 2,
            resolution: { ...resolution, id: "new-resolution", revision: 2 },
            answers: [{ personId: "expert-1", revision: 3 }],
          },
        ],
        facts: [fact],
      },
    });
    expect(
      handoff.items.find((item) => item.record.id === fact.id),
    ).toMatchObject({
      state: "superseded",
      relatedRecords: expect.arrayContaining([
        { type: "resolution", id: "resolution-1", revision: 1 },
        { type: "answer", id: "question-1:expert-1", revision: 1 },
      ]),
    });
  });

  it.each([
    ["questions", "question", question],
    ["facts", "fact", fact],
    ["drafts", "draft", draft],
    ["sourceRecords", "source record", sourceRecord],
    ["pins", "skill pin", pin],
  ])("refuses duplicate identities in %s", (collection, kind, record) => {
    expect(() =>
      createQuestionnaireHandoff({
        records: {
          questions: [question],
          [collection as string]: [record, record],
        } as unknown as QuestionnaireRecords,
      }),
    ).toThrow(new RegExp(`${kind as string} .*duplicate`, "u"));
  });

  it("refuses one resolution identity attached to two different questions", () => {
    expect(() =>
      createQuestionnaireHandoff({
        records: {
          questions: [
            { ...question, resolution },
            { ...question, id: "question-2", resolution },
          ],
        },
      }),
    ).toThrow(/resolution "resolution-1".*duplicate/u);
  });

  it("refuses duplicate answering people under a question", () => {
    const answer = { personId: "expert-1", revision: 1 };
    expect(() =>
      createQuestionnaireHandoff({
        records: { questions: [{ ...question, answers: [answer, answer] }] },
      }),
    ).toThrow(/answer .*expert-1.*duplicate/u);
  });

  it("computes a complete handoff from all valid record kinds", () => {
    const handoff = createQuestionnaireHandoff({
      records: {
        questions: [
          {
            ...question,
            state: "confirmed",
            resolution,
            answers: fact.answers,
          },
        ],
        facts: [
          {
            ...fact,
            active: true,
            current: true,
            acknowledgements: [
              { id: "ack-1", personId: "expert-1", decision: "acknowledged" },
            ],
          },
        ],
        drafts: [{ ...draft, questionId: question.id, questionRevision: 1 }],
        sourceRecords: [sourceRecord],
        pins: [pin],
      },
    });
    expect(handoff.status).toBe("complete");
    expect(
      handoff.ledger.confirmedUserFacts.map((item) => item.record.id),
    ).toEqual(["fact-1"]);
    expect(
      handoff.ledger.sourceDerivedFacts.map((item) => item.record.id),
    ).toEqual(["source-fact-1"]);
    expect(
      handoff.ledger.agentInferences.map((item) => [
        item.record.id,
        item.state,
      ]),
    ).toEqual([["inference-1", "confirmed"]]);
  });

  it("reads each question a bounded number of times however many records cite it", () => {
    const count = 60;
    let reads = 0;
    const questions = new Proxy(
      Array.from({ length: count }, (_, index) => ({
        ...question,
        id: `question-${index}`,
      })),
      {
        get: (target, key, receiver) => {
          if (typeof key === "string" && /^\d+$/u.test(key)) reads += 1;
          return Reflect.get(target, key, receiver);
        },
      },
    );

    validateQuestionnaireRecords({
      questions,
      facts: Array.from({ length: count }, (_, index) => ({
        ...fact,
        id: `fact-${index}`,
        questionId: `question-${index}`,
      })),
      drafts: Array.from({ length: count }, (_, index) => ({
        ...draft,
        id: `draft-${index}`,
        questionId: `question-${index}`,
        questionRevision: 1,
      })),
    });

    // Scanning the questions for every fact and draft reads them about
    // count * count times; the ledger's locked reads run this check.
    expect(reads).toBeLessThanOrEqual(count * 8);
  });
});
