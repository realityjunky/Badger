import { describe, expect, it } from "vitest";
import {
  createQuestionnaireHandoff,
  questionnaireLedgerChanges,
  type QuestionnaireRecords,
} from "../src/index.js";
import {
  questionnaireFixture,
  deferredQuestionFixture,
} from "./fixtures/semantic-dossier.js";

describe("semantic questionnaire handoff", () => {
  it("reads durable records with all blockers and returns a defensive handoff", () => {
    const records: QuestionnaireRecords = {
      questions: [
        {
          id: "q",
          revision: 1,
          topic: "interfaces",
          text: "Which columns?",
          state: "deferred",
          resolution: {
            id: "r",
            revision: 1,
            kind: "deferred",
            reason: "Owned by a later workflow.",
            deferredKind: "out-of-scope",
            skillId: null,
          },
        },
      ],
      drafts: [
        {
          id: "i",
          revision: 1,
          kind: "inference",
          topic: "interfaces",
          statement: "Use sample_id.",
          questionId: "q",
          questionRevision: 1,
          status: "active",
        },
      ],
      pins: [
        {
          skillId: "s",
          skillName: "Source",
          revision: 1,
          hash: "a".repeat(64),
          studied: false,
        },
      ],
    };
    const handoff = createQuestionnaireHandoff({ records });
    expect(handoff.status).toBe("incomplete");
    expect(
      handoff.readiness
        .find((r) => r.topic === "interfaces")
        ?.blockers.map((b) => b.code),
    ).toEqual(["unconfirmed-inference", "unstudied-pin"]);
    expect(handoff.ledger.remainingQuestions).toEqual([]);
    expect(handoff.ledger.agentInferences[0].state).toBe("draft");
    handoff.deferredQuestions[0].resolution!.reason = "Changed by a reader";
    expect(records.questions[0].resolution?.reason).toBe(
      "Owned by a later workflow.",
    );
  });

  it("confirms a linked draft once its question's facts are acknowledged, whichever question revision it was linked at", () => {
    const records: QuestionnaireRecords = {
      questions: [
        {
          id: "q",
          revision: 2,
          topic: "interfaces",
          text: "Which columns, in order?",
          state: "confirmed",
          resolution: {
            id: "r",
            revision: 1,
            kind: "confirmed",
            reason: null,
            deferredKind: null,
            skillId: null,
          },
          answers: [{ personId: "p", revision: 2 }],
        },
      ],
      facts: [
        {
          id: "f",
          questionId: "q",
          resolutionId: "r",
          resolutionRevision: 1,
          questionRevision: 2,
          statement: "The consumer requires sample_id, then sequence.",
          active: true,
          current: true,
          actorId: "e",
          answers: [{ personId: "p", revision: 2 }],
          acknowledgements: [
            { id: "a", personId: "p", decision: "acknowledged" },
          ],
        },
      ],
      drafts: [
        {
          id: "i",
          revision: 1,
          kind: "inference",
          topic: "interfaces",
          statement: "The consumer requires sample_id.",
          questionId: "q",
          questionRevision: 1,
          status: "active",
        },
        {
          id: "s",
          revision: 1,
          kind: "assumption",
          topic: "interfaces",
          statement: "Columns are tab-separated.",
          questionId: null,
          questionRevision: null,
          status: "active",
        },
      ],
    };
    const handoff = createQuestionnaireHandoff({ records });
    expect(handoff.ledger.agentInferences.map((i) => i.state)).toEqual([
      "confirmed",
    ]);
    expect(
      handoff.readiness
        .find((r) => r.topic === "interfaces")
        ?.blockers.map((b) => [b.code, b.record?.id]),
    ).toEqual([["unresolved-assumption", "s"]]);
    records.facts![0].acknowledgements = [];
    const pending = createQuestionnaireHandoff({ records });
    expect(pending.ledger.agentInferences[0].state).toBe("draft");
    expect(
      pending.readiness
        .find((r) => r.topic === "interfaces")
        ?.blockers.map((b) => b.code),
    ).toEqual([
      "unconfirmed-inference",
      "unresolved-assumption",
      "pending-acknowledgement",
    ]);
  });

  it("compares round baselines on a resolution's immutable fields and reports removed and resolved items", () => {
    const question = (state: "open" | "deferred", actorName: string) => ({
      id: "q",
      revision: 1,
      topic: "inputs" as const,
      text: "How are samples shipped?",
      state,
      ...(state === "deferred"
        ? {
            resolution: {
              id: "r",
              revision: 1,
              kind: "deferred",
              reason: "A later workflow owns shipping.",
              deferredKind: "out-of-scope",
              skillId: null,
              // A service projection may carry mutable display fields.
              actorName,
            } as QuestionnaireRecords["questions"][number]["resolution"],
          }
        : {}),
    });
    const items = (records: QuestionnaireRecords) =>
      createQuestionnaireHandoff({ records }).items;
    const open = items({ questions: [question("open", "Sam")] });
    const deferred = items({ questions: [question("deferred", "Sam")] });
    const renamed = items({ questions: [question("deferred", "Sam Renamed")] });
    expect(deferred[0].resolution).toEqual({
      id: "r",
      revision: 1,
      kind: "deferred",
      reason: "A later workflow owns shipping.",
      deferredKind: "out-of-scope",
      skillId: null,
    });
    expect(questionnaireLedgerChanges(deferred, renamed)).toEqual({
      added: [],
      changed: [],
      resolved: [],
    });
    expect(questionnaireLedgerChanges(open, deferred)).toEqual({
      added: [],
      changed: [],
      resolved: [{ before: open[0], after: deferred[0] }],
    });
    expect(questionnaireLedgerChanges(open, [])).toEqual({
      added: [],
      changed: [{ before: open[0], after: null }],
      resolved: [],
    });
  });

  it("refuses the retired version 1 dossier with a migration finding", () => {
    const { dossier, factoryPlan } = questionnaireFixture();
    const legacy = { ...dossier, schemaVersion: 1 };
    const handoff = createQuestionnaireHandoff({
      projectRoot: "/project",
      dossier: legacy,
      factoryPlan,
    });
    expect(handoff.status).toBe("incomplete");
    expect(handoff.diagnostics).toContainEqual(
      expect.objectContaining({
        path: "schemaVersion",
        message: expect.stringContaining("version 1 is retired"),
      }),
    );
  });

  it("requires the interfaces topic for data contracts between Nodes", () => {
    const input = { projectRoot: "/project", ...questionnaireFixture() };
    Reflect.deleteProperty(input.dossier.topics, "interfaces");
    expect(createQuestionnaireHandoff(input).diagnostics).toContainEqual(
      expect.objectContaining({ path: "topics.interfaces" }),
    );
  });

  it.each(["confirmedBy", "answerRevisions", "acknowledgedBy"] as const)(
    "requires %s provenance for each confirmed fact",
    (field) => {
      const input = { projectRoot: "/project", ...questionnaireFixture() };
      Reflect.deleteProperty(
        input.dossier.confirmedUserFacts[0].provenance,
        field,
      );
      expect(createQuestionnaireHandoff(input).diagnostics).toContainEqual(
        expect.objectContaining({
          path: `confirmedUserFacts.owner-scope.provenance.${field}`,
        }),
      );
    },
  );

  it("requires provenance when an agent inference is confirmed", () => {
    const input = { projectRoot: "/project", ...questionnaireFixture() };
    Reflect.deleteProperty(input.dossier.agentInferences[0], "provenance");
    expect(createQuestionnaireHandoff(input).diagnostics).toContainEqual(
      expect.objectContaining({
        path: "agentInferences.single-node.provenance",
      }),
    );
  });

  it("accepts a deferred question with its resolution and does not block", () => {
    const input = { projectRoot: "/project", ...questionnaireFixture() };
    input.dossier.deferredQuestions.push(deferredQuestionFixture());
    const handoff = createQuestionnaireHandoff(input);
    expect(handoff.status).toBe("complete");
    expect(handoff.diagnostics).toEqual([]);
    expect(handoff.dossier).toMatchObject({
      deferredQuestions: [expect.objectContaining({ id: "column-contract" })],
    });
  });

  it("keeps an unresolved question blocking beside a deferred one", () => {
    const input = { projectRoot: "/project", ...questionnaireFixture() };
    input.dossier.deferredQuestions.push(deferredQuestionFixture());
    input.dossier.remainingQuestions.push({
      id: "recovery",
      field: "topics.recoveryPolicy",
      question: "Where should repair resume?",
    });
    const handoff = createQuestionnaireHandoff(input);
    expect(handoff.status).toBe("incomplete");
    expect(handoff.diagnostics).toContainEqual(
      expect.objectContaining({ path: "remainingQuestions.recovery" }),
    );
  });

  it("requires a declared Skill whose backlog holds a skill-scoped deferral", () => {
    const input = { projectRoot: "/project", ...questionnaireFixture() };
    for (const skill of [undefined, "undeclared-skill"]) {
      input.dossier.deferredQuestions = [deferredQuestionFixture({ skill })];
      expect(createQuestionnaireHandoff(input).diagnostics).toContainEqual(
        expect.objectContaining({
          path: "deferredQuestions.column-contract.resolution",
        }),
      );
    }
  });

  it.each([
    ["outcome", { outcome: "withdrawn" }],
    ["scope", { scope: "elsewhere" }],
    ["reason", { reason: " " }],
  ])("requires a deferred resolution %s and reason", (field, change) => {
    const input = { projectRoot: "/project", ...questionnaireFixture() };
    input.dossier.deferredQuestions.push(deferredQuestionFixture(change));
    expect(createQuestionnaireHandoff(input).diagnostics).toContainEqual(
      expect.objectContaining({
        path: "deferredQuestions.column-contract.resolution",
      }),
    );
  });

  it.each([
    [
      "plan goal",
      (plan: { goal: string }) => (plan.goal = "Another goal."),
      "goal",
    ],
    [
      "workflow goal",
      (plan: { workflow: { goal: string } }) =>
        (plan.workflow.goal = "Another goal."),
      "workflow.goal",
    ],
  ])(
    "refuses a %s that differs from the dossier's goal",
    (_name, change, path) => {
      const input = { projectRoot: "/project", ...questionnaireFixture() };
      change(input.factoryPlan);
      expect(createQuestionnaireHandoff(input).diagnostics).toContainEqual(
        expect.objectContaining({
          path,
          message: "Dossier contradicts FactoryPlan",
        }),
      );
    },
  );

  it("returns a read model without mutating its input", () => {
    const input = { projectRoot: "/project", ...questionnaireFixture() };
    input.dossier.deferredQuestions.push(
      deferredQuestionFixture({ scope: "out-of-scope" }),
    );
    const before = structuredClone(input);
    createQuestionnaireHandoff(input);
    expect(input).toEqual(before);
  });

  it.each(["../outside/prepare", "skills/../../prepare", "./.."])(
    "refuses a Project-relative source location that leaves the Project: %s",
    (location) => {
      const input = { projectRoot: "/project", ...questionnaireFixture() };
      input.factoryPlan.skillSources[0].location = location;
      input.dossier.sources[0].location = location;
      expect(createQuestionnaireHandoff(input).diagnostics).toEqual([
        {
          path: "sources.prepare-source.location",
          message:
            "A Project-relative source location cannot leave the Project: remove its .. segments",
        },
      ]);
    },
  );
  it.each(["/project/skills/prepare", "C:\\skills\\prepare", "skills/other"])(
    "refuses a source location other than the FactoryPlan's declaration: %s",
    (location) => {
      const input = { projectRoot: "/project", ...questionnaireFixture() };
      input.dossier.sources[0].location = location;
      expect(createQuestionnaireHandoff(input).diagnostics).toEqual([
        {
          path: "sources",
          message:
            "Dossier must describe exactly the explicit FactoryPlan sources",
        },
      ]);
    },
  );
  it.each([
    ["skills/prepare", "./skills/prepare"],
    ["./skills/prepare", "skills/prepare"],
    ["skills/prepare", "skills//prepare"],
    ["/project/skills/prepare", "/project/skills/prepare"],
    ["/srv/skills/prepare", "/srv/skills/prepare"],
  ])(
    "accepts the declared source location %s recorded as %s",
    (declared, recorded) => {
      const input = { projectRoot: "/project", ...questionnaireFixture() };
      input.factoryPlan.skillSources[0].location = declared;
      input.dossier.sources[0].location = recorded;
      expect(createQuestionnaireHandoff(input)).toMatchObject({
        status: "complete",
        diagnostics: [],
      });
    },
  );
  it.each([null, [], {}, { schemaVersion: 2 }])(
    "returns diagnostics for malformed dossiers",
    (dossier) => {
      expect(
        createQuestionnaireHandoff({ projectRoot: "/project", dossier }).status,
      ).toBe("incomplete");
    },
  );

  it("blocks malformed FactoryPlans and mismatched Node identities", () => {
    const input = { projectRoot: "/project", ...questionnaireFixture() };
    input.dossier.nodes[0].id = "undeclared-node";
    expect(createQuestionnaireHandoff(input).diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: "nodes" })]),
    );
    input.factoryPlan = {} as typeof input.factoryPlan;
    expect(createQuestionnaireHandoff(input).status).toBe("incomplete");
  });
  it("resolves a second exchange into a confirmed dossier without skipping plan confirmation", () => {
    const input = { projectRoot: "/project", ...questionnaireFixture() };
    input.dossier.remainingQuestions.push({
      id: "recovery",
      field: "topics.recoveryPolicy",
      question: "Where should repair resume?",
    });
    expect(createQuestionnaireHandoff(input).status).toBe("incomplete");
    input.dossier.remainingQuestions = [];
    const handoff = createQuestionnaireHandoff(input);
    expect(handoff.status).toBe("complete");
    expect(handoff.diagnostics).toEqual([]);
    expect(handoff.factoryPlan?.semanticDossier).toEqual(input.dossier);
    expect(handoff.nextAction).toBe("factory-plan-confirmation");
    expect(handoff.nextReadOnlyCommand).toBeNull();
    expect(handoff.dossier).not.toBe(input.dossier);
  });

  it("preserves stopped gaps and existing context for a later exchange", () => {
    const input = {
      projectRoot: "/project",
      ...questionnaireFixture(),
      stopped: true,
      existingContext: ".badger/states/prepared-workflow.json",
    };
    input.dossier.unresolvedAssumptions.push({
      id: "contradiction",
      statement: "The owner supplied contradictory finalization instructions.",
      field: "topics.finalization",
    });
    const handoff = createQuestionnaireHandoff(input);
    expect(handoff.status).toBe("stopped");
    expect(handoff.existingContext).toBe(input.existingContext);
    expect(handoff.dossier).toEqual(input.dossier);
    expect(handoff.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "unresolvedAssumptions.contradiction",
        }),
      ]),
    );
    expect(handoff.nextAction).toBe("questionnaire-refinement");
    expect(handoff.nextReadOnlyCommand).toBeNull();
  });

  it("keeps identity stable across object key order and transport context but changes with meaning", () => {
    const input = { projectRoot: "/project", ...questionnaireFixture() };
    const first = createQuestionnaireHandoff(input);
    const reordered = Object.fromEntries(
      Object.entries(input.dossier).reverse(),
    );
    expect(
      createQuestionnaireHandoff({
        ...input,
        projectRoot: "/other",
        dossier: reordered,
        existingContext: "resumed",
      }).dossierHash,
    ).toBe(first.dossierHash);
    input.dossier.topics.recoveryPolicy.summary =
      "Resume after explicit owner repair confirmation.";
    expect(createQuestionnaireHandoff(input).dossierHash).not.toBe(
      first.dossierHash,
    );
  });

  it.each([
    "missing topic",
    "unconfirmed inference",
    "contradictory plan",
    "undeclared source",
    "missing evidence",
    "duplicate order",
  ])("blocks completion for %s", (failure) => {
    const input = { projectRoot: "/project", ...questionnaireFixture() };
    if (failure === "missing topic")
      input.dossier.topics.decisions.summary = "";
    if (failure === "unconfirmed inference")
      input.dossier.agentInferences[0].confirmed = false;
    if (failure === "contradictory plan")
      input.dossier.workflow.name = "other-workflow";
    if (failure === "undeclared source")
      input.dossier.sources[0].name = "other-source";
    if (failure === "missing evidence")
      input.dossier.topics.inputs.factIds = ["missing"];
    if (failure === "duplicate order")
      input.dossier.nodes.push({ ...input.dossier.nodes[0], id: "other-node" });
    expect(createQuestionnaireHandoff(input).status).toBe("incomplete");
  });
  it("keeps an incomplete first exchange resumable without a proposal command", () => {
    const handoff = createQuestionnaireHandoff({
      projectRoot: "/project",
      dossier: { schemaVersion: 2, kind: "semantic-dossier" },
    });
    expect(handoff.status).toBe("incomplete");
    expect(handoff.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: "workflow" })]),
    );
    expect(handoff.nextAction).toBe("questionnaire-refinement");
    expect(handoff.nextReadOnlyCommand).toBeNull();
    expect(handoff.dossier).toEqual({
      schemaVersion: 2,
      kind: "semantic-dossier",
    });
  });
});
