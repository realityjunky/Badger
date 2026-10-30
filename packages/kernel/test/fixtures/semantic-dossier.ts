import type {
  DeferredQuestion,
  FactoryPlan,
  SemanticDossier,
} from "../../src/index.js";

export function deferredQuestionFixture(
  resolution: Partial<DeferredQuestion["resolution"]> = {},
  overrides: Partial<Omit<DeferredQuestion, "resolution">> = {},
): DeferredQuestion {
  return {
    id: "column-contract",
    field: "interfaces",
    question: "Which columns does the receiving Skill read?",
    ...overrides,
    resolution: {
      outcome: "deferred",
      scope: "skill",
      skill: "prepare",
      reason: "Internal to the receiving Skill; fixed in its next revision.",
      ...resolution,
    },
  };
}

export function questionnaireFixture(): {
  factoryPlan: FactoryPlan;
  dossier: SemanticDossier;
} {
  const topic = (summary: string) => ({ summary, factIds: ["owner-scope"] });
  return {
    factoryPlan: {
      schemaVersion: 1,
      goal: "Prepare a reviewed report.",
      skillCreatorIntent: "new-skill",
      defaultLocale: "en",
      skillSources: [{ name: "prepare", location: "skills/prepare" }],
      workflow: {
        kind: "workflow-kernel",
        name: "prepared-workflow",
        goal: "Prepare a reviewed report.",
        customNodes: [
          {
            id: "prepare",
            label: "Prepare",
            kind: "action",
            responsibility: "Prepare a report.",
            implementation: {
              skill: "prepare",
              operation: "default",
              scope: "main",
            },
            operations: ["require", "augment", "disable"],
            outputSchemas: [],
            guardrails: [],
          },
        ],
        outputSchemas: [],
      },
    },
    dossier: {
      schemaVersion: 2,
      kind: "semantic-dossier",
      confirmed: true,
      workflow: {
        name: "prepared-workflow",
        goal: "Prepare a reviewed report.",
        intent: "new-skill",
        defaultLocale: "en",
      },
      sources: [
        {
          id: "prepare-source",
          name: "prepare",
          location: "skills/prepare",
          contentHash: "a".repeat(64),
          roles: ["implementation of prepare"],
        },
      ],
      nodes: [
        { id: "prepare", order: 0, responsibility: topic("Prepare a report.") },
      ],
      topics: {
        inputs: topic("Prepare receives the owner's report topic."),
        prerequisites: topic("Prepare requires an explicitly supplied topic."),
        bindings: topic("The prepare Skill implements prepare."),
        interfaces: topic(
          "No inter-Node data contract is needed: the workflow has one Node.",
        ),
        requiredSkillCalls: topic("None: prepare is self-contained."),
        augmentations: topic("None: the implementation covers the task."),
        outputSchemas: topic(
          "No structured artifact is required for this advisory report.",
        ),
        completionEvidence: topic(
          "Prepare returns the report text for owner inspection.",
        ),
        decisions: topic("No decision Nodes or stable choices are needed."),
        guardrails: topic(
          "The source is inspected, not executed, during authoring.",
        ),
        routes: topic(
          "Prepare succeeds to completion; failure or missing input stops for repair. No pause, conditional, or handoff routes are needed.",
        ),
        boundedCycles: topic("No repeat transitions or cycles are needed."),
        capabilities: topic("Read local source and return text only."),
        finalization: topic("Return the report to the owner."),
        executableDisclosures: topic(
          "The supplied Skill contains no executable scripts.",
        ),
        recoveryPolicy: topic(
          "Resume prepare from persisted inputs after repairing missing evidence.",
        ),
      },
      confirmedUserFacts: [
        {
          id: "owner-scope",
          statement:
            "The owner confirmed the report scope and all topic summaries.",
          provenance: {
            confirmedBy: "workflow-owner",
            answerRevisions: [{ answerId: "answer-scope", revision: 1 }],
            acknowledgedBy: "field-expert",
          },
        },
      ],
      sourceDerivedFacts: [
        {
          id: "source-purpose",
          statement: "Prepare authors a report.",
          sourceId: "prepare-source",
          evidencePath: "SKILL.md",
        },
      ],
      agentInferences: [
        {
          id: "single-node",
          statement: "One Node is sufficient.",
          confirmed: true,
          provenance: {
            confirmedBy: "workflow-owner",
            answerRevisions: [{ answerId: "answer-node-shape", revision: 2 }],
            acknowledgedBy: "field-expert",
          },
        },
      ],
      unresolvedAssumptions: [],
      remainingQuestions: [],
      deferredQuestions: [],
    },
  };
}
