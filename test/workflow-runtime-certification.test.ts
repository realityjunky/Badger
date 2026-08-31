import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { generatePackage } from "../src/factory/generate.js";
import { certifyWorkflowRuntime } from "../src/eval/workflow-runtime-certification.js";
import { normalizeWorkflow } from "../src/workflow/contract.js";
import { hashDirectory } from "../src/util.js";
import type { WorkflowInput } from "../src/types.js";

function linearWorkflow(): WorkflowInput {
  return {
    kind: "workflow-kernel",
    name: "certification-host-workflow",
    goal: "Exercise the generated certification gate.",
    customNodes: [
      {
        id: "start",
        label: "Start",
        kind: "action",
        responsibility: "Start the synthetic workflow.",
        implementation: {
          skill: "synthetic-start",
          operation: "default",
          scope: "main",
        },
        operations: ["require", "augment", "disable"],
        outputSchemas: [],
        guardrails: [],
      },
    ],
  };
}

function revisionedWorkflow(): WorkflowInput {
  return {
    kind: "workflow-kernel",
    name: "revisioned-host-workflow",
    goal: "Exercise revisioned package compatibility.",
    capabilities: {
      version: 3,
      features: ["conditional-routing", "revisioned-attempts"],
    },
    customNodes: [
      {
        id: "start",
        label: "Start",
        kind: "action",
        responsibility: "Start the revisioned synthetic workflow.",
        implementation: {
          skill: "synthetic-start",
          operation: "default",
          scope: "main",
        },
        operations: ["require", "augment", "disable"],
        outputSchemas: [],
        guardrails: [],
      },
    ],
  };
}

describe("WorkflowRuntime Phase 3 certification", () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "comet-certification-"));
  });

  afterEach(async () => fs.rm(root, { recursive: true, force: true }));

  it("certifies the combined synthetic lifecycle through the evaluator", async () => {
    const protocol = normalizeWorkflow(linearWorkflow()).protocol;
    const generated = await generatePackage({
      proposal: {
        schemaVersion: 1,
        name: protocol.name,
        goal: protocol.goal,
        intent: "new-skill",
        planHash: "certification-plan",
        workflow: protocol,
        candidates: [],
        blockers: [],
        warnings: [],
        canInitialize: true,
      },
      plan: {
        schemaVersion: 1,
        goal: protocol.goal,
        skillCreatorIntent: "new-skill",
        preferredSkills: [],
        workflow: linearWorkflow(),
        defaultLocale: "en",
      },
      destination: path.join(root, "generated"),
    });

    const result = await certifyWorkflowRuntime({
      protocol,
      generatedPackageHash: await hashDirectory(generated.packageRoot),
      packageRoot: generated.packageRoot,
    });

    expect(result.blockers).toEqual([]);
    expect(result.evidence?.phase3).toMatchObject({
      status: "certified",
      fixtureName: "phase3-certification-workflow",
      expectedVisitOrder: [
        "prepare",
        "classify",
        "review",
        "rework",
        "review",
        "finish",
      ],
      observedVisitOrder: [
        "prepare",
        "classify",
        "review",
        "rework",
        "review",
        "finish",
      ],
      dispositions: {
        continue: true,
        awaitUser: true,
        blocked: true,
        done: true,
      },
      recovery: {
        pendingMachine: true,
        awaitingDecision: true,
        acceptedBranch: true,
        afterScopedReceipt: true,
        betweenCycles: true,
        terminal: true,
        freshProcess: true,
      },
      branch: {
        conditional: true,
        selected: "review",
        defaultRoute: true,
        terminalChoice: true,
      },
      cycle: {
        declared: true,
        repeatTransition: true,
        repeatedNodeVisits: 2,
        instances: 2,
        budgetRejected: true,
      },
      attempts: {
        rework: true,
        retryStable: true,
        uniqueVisits: true,
      },
      artifacts: {
        attemptVersion: true,
        runVersion: true,
        carryForward: true,
        immutable: true,
      },
      decisions: {
        authorized: true,
        receiptCount: 2,
        scopeBound: true,
        replayRejected: true,
      },
      entryDirections: {
        generatedToPublic: true,
        publicToGenerated: true,
        manualStandalone: true,
      },
      generatedAdaptersThin: true,
      identityReconciled: true,
      projectionsConsistent: true,
      allNegativeCases: true,
      sourceIntegrity: true,
      completed: true,
    });
  }, 15_000);

  it("keeps revisioned generated packages on the Phase 3 gate", async () => {
    const input = revisionedWorkflow();
    const protocol = normalizeWorkflow(input).protocol;
    const generated = await generatePackage({
      proposal: {
        schemaVersion: 1,
        name: protocol.name,
        goal: protocol.goal,
        intent: "new-skill",
        planHash: "revisioned-certification-plan",
        workflow: protocol,
        candidates: [],
        blockers: [],
        warnings: [],
        canInitialize: true,
      },
      plan: {
        schemaVersion: 1,
        goal: protocol.goal,
        skillCreatorIntent: "new-skill",
        preferredSkills: [],
        workflow: input,
        defaultLocale: "en",
      },
      destination: path.join(root, "revisioned-generated"),
    });

    const result = await certifyWorkflowRuntime({
      protocol,
      generatedPackageHash: await hashDirectory(generated.packageRoot),
      packageRoot: generated.packageRoot,
    });

    expect(result.blockers).toEqual([]);
    expect(result.evidence).toMatchObject({
      phase2Applicable: false,
      entryAdapterStarted: true,
      phase3: { status: "certified", completed: true },
    });
  }, 15_000);
});
