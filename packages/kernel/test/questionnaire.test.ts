import { describe, expect, it } from "vitest";
import { createQuestionnaireHandoff } from "../src/index.js";
import { questionnaireFixture } from "./fixtures/semantic-dossier.js";

describe("semantic questionnaire handoff", () => {
  it.each(["skills/prepare", "/project/../prepare", "/project//prepare"])(
    "rejects ambiguous canonical source path %s",
    (canonicalPath) => {
      const input = { projectRoot: "/project", ...questionnaireFixture() };
      input.dossier.sources[0].canonicalPath = canonicalPath;
      expect(createQuestionnaireHandoff(input).diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: "sources.prepare-source.canonicalPath",
          }),
        ]),
      );
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
      dossier: { schemaVersion: 1, kind: "semantic-dossier" },
    });
    expect(handoff.status).toBe("incomplete");
    expect(handoff.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: "workflow" })]),
    );
    expect(handoff.nextAction).toBe("questionnaire-refinement");
    expect(handoff.nextReadOnlyCommand).toBeNull();
    expect(handoff.dossier).toEqual({
      schemaVersion: 1,
      kind: "semantic-dossier",
    });
  });
});
