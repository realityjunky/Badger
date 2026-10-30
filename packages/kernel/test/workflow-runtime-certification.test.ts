import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { generatePackage } from "../src/factory/generate.js";
import { certifyWorkflowRuntime } from "../src/eval/workflow-runtime-certification.js";
import { normalizeWorkflow } from "../src/workflow/contract.js";
import { reviewState } from "../src/publish/lifecycle.js";
import { hashDirectory } from "../src/util.js";
import type {
  CreatorState,
  WorkflowDurabilityProfile,
  WorkflowInput,
} from "../src/types.js";

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

function phase4Workflow(): WorkflowInput {
  const input = revisionedWorkflow();
  input.name = "phase4-host-workflow";
  input.goal = "Exercise the Phase 4 certification gate.";
  input.capabilities = {
    ...input.capabilities!,
    durability: {
      version: 1,
      capabilities: ["mutation-locks", "revision-fences", "transition-journal"],
      bounds: {
        runStateBytes: 256 * 1024,
        pendingActionBytes: 256 * 1024,
        trajectoryBytes: 2 * 1024 * 1024,
        artifactsBytes: 256 * 1024,
        claimBytes: 16 * 1024,
        transitionJournalBytes: 512 * 1024,
        runLockBytes: 16 * 1024,
      },
      schemaVersions: {
        runState: 1,
        pendingAction: 1,
        trajectory: 1,
        artifacts: 1,
        revisionClaim: 1,
        transitionJournal: 1,
        runLock: 1,
      },
      findingCatalogVersion: 1,
    } satisfies WorkflowDurabilityProfile,
  };
  return input;
}

describe("WorkflowRuntime Phase 3 certification", () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "badger-certification-"));
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
        skillSources: [],
        workflow: linearWorkflow(),
        defaultLocale: "en",
      },
      destination: path.join(root, "generated"),
      projectRoot: root,
    });

    const result = await certifyWorkflowRuntime({
      protocol,
      generatedPackageHash: await hashDirectory(generated.packageRoot),
      packageRoot: generated.packageRoot,
    });

    expect(result.blockers).toEqual([]);
    expect(result.evidence?.artifactReceipts).toMatchObject({
      status: "certified",
      externalRoot: true,
      rootBindingRequired: true,
      largeFile: true,
      completionEvidence: true,
      staleRejected: true,
      containmentRejected: true,
      legacyRunRoot: true,
      freshProcessRecovered: true,
    });
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
        skillSources: [],
        workflow: input,
        defaultLocale: "en",
      },
      destination: path.join(root, "revisioned-generated"),
      projectRoot: root,
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

  it("exposes a complete current-hash Phase 4 certification", async () => {
    const input = phase4Workflow();
    const protocol = normalizeWorkflow(input).protocol;
    const generated = await generatePackage({
      proposal: {
        schemaVersion: 1,
        name: protocol.name,
        goal: protocol.goal,
        intent: "new-skill",
        planHash: "phase4-certification-plan",
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
        skillSources: [],
        workflow: input,
        defaultLocale: "en",
      },
      destination: path.join(root, "phase4-generated"),
      projectRoot: root,
    });

    const generatedPackageHash = await hashDirectory(generated.packageRoot);
    const result = await certifyWorkflowRuntime({
      protocol,
      generatedPackageHash,
      packageRoot: generated.packageRoot,
    });

    expect(result.blockers).toEqual([]);
    expect(result.evidence?.phase4).toMatchObject({
      status: "certified",
      fixtureName: "phase4-certification-workflow",
      generatedPackageHash,
      evaluatedPackageHash: generatedPackageHash,
      declaredCapabilities: expect.arrayContaining([
        "mutation-locks",
        "verified-checkpoints",
        "content-snapshots",
        "verification-receipts",
        "repair-policy",
        "transactional-finalization",
      ]),
      lifecycle: {
        machineWork: true,
        persistedDecision: true,
        versionedArtifacts: true,
        verificationRequirement: true,
        contentSnapshot: true,
        repairEpisode: true,
        verifiedCheckpoint: true,
        finalizationPreview: true,
        finalizationConfirmed: true,
        finalReceipt: true,
        contentDrift: true,
      },
      locations: { manual: true, standalone: true, equivalent: true },
      adapters: {
        generatedToPublic: true,
        publicToGenerated: true,
        thin: true,
        projectionsConsistent: true,
      },
      freshProcess: {
        pendingAction: true,
        decision: true,
        checkpoint: true,
        finalization: true,
        terminal: true,
        crashBoundaries: true,
        converged: true,
      },
      concurrency: {
        identical: {
          oneAccepted: true,
          oneConflict: true,
          noDuplicateOutcome: true,
          noDuplicateEvent: true,
          noDuplicateReceipt: true,
          noDuplicateNextAction: true,
        },
        conflicting: {
          oneAccepted: true,
          oneConflict: true,
          noDuplicateOutcome: true,
          noDuplicateEvent: true,
          noDuplicateReceipt: true,
          noDuplicateNextAction: true,
        },
      },
      allNegativeCases: true,
      negativeCases: { "content-drift": true },
      generatedAdaptersThin: true,
      legacyRunUnchanged: true,
      sourceIntegrity: true,
      completed: true,
    });

    const state: CreatorState = {
      schemaVersion: 1,
      name: protocol.name,
      status: "evaluated",
      projectRoot: root,
      planPath: path.join(root, "plan.json"),
      planHash: "phase4-certification-plan",
      draftPath: generated.packageRoot,
      currentHash: generatedPackageHash,
      candidates: [],
      generated: {
        packageRoot: generated.packageRoot,
        protocolPath: path.join(root, "workflow-protocol.json"),
        evalPath: path.join(root, "eval.yaml"),
      },
      eval: {
        hash: generatedPackageHash,
        passed: true,
        resultPath: path.join(root, "eval.json"),
        runtime: result.evidence!,
      },
    };
    expect(reviewState(state).state).toBe("blocked");
    expect(reviewState(state).authoring.blockers).toContain(
      "Legacy deterministic scaffold is scaffold-only; migrate before authoring or publication",
    );

    const missingPhase4 = structuredClone(state);
    delete missingPhase4.eval!.runtime!.phase4;
    expect(reviewState(missingPhase4).blockers).toContain(
      "WorkflowRuntime Phase 4 certification evidence is missing",
    );

    const stalePhase4 = structuredClone(state);
    stalePhase4.eval!.runtime!.phase4!.evaluatedPackageHash = "0".repeat(64);
    expect(reviewState(stalePhase4).blockers).toContain(
      "WorkflowRuntime Phase 4 evidence is stale for the generated package",
    );

    const incompletePhase4 = structuredClone(state);
    incompletePhase4.eval!.runtime!.phase4!.lifecycle.contentDrift = false;
    expect(reviewState(incompletePhase4).blockers).toContain(
      "WorkflowRuntime Phase 4 lifecycle evidence is missing: contentDrift",
    );

    const wrongPackagePhase4 = structuredClone(state);
    wrongPackagePhase4.eval!.runtime!.phase4!.generatedPackageHash = "1".repeat(
      64,
    );
    expect(reviewState(wrongPackagePhase4).blockers).toContain(
      "WorkflowRuntime Phase 4 evidence is stale for the generated package",
    );

    const malformedPhase4 = structuredClone(state);
    malformedPhase4.eval!.runtime!.phase4 = {} as NonNullable<
      typeof malformedPhase4.eval.runtime.phase4
    >;
    expect(reviewState(malformedPhase4).blockers).toContain(
      "WorkflowRuntime Phase 4 certification is incomplete",
    );
  }, 120_000);
});

it("binds declared external directories when certifying the selected generated package", async () => {
  const temporary = await fs.mkdtemp(
    path.join(os.tmpdir(), "badger-cert-external-"),
  );
  try {
    const input = linearWorkflow();
    input.outputSchemas = [
      {
        id: "output.v1",
        description: "External synthetic output.",
        externalRoots: {
          outputs: { description: "Where to write synthetic results." },
        },
        artifacts: [
          {
            id: "result",
            kind: "file",
            required: true,
            paths: ["result.bin"],
            validations: ["artifact-exists"],
            verification: "receipt",
            root: "outputs",
          },
        ],
        evidence: [],
      },
    ];
    input.customNodes[0].outputSchemas = ["output.v1"];
    const protocol = normalizeWorkflow(input).protocol;
    const generated = await generatePackage({
      proposal: {
        schemaVersion: 1,
        name: protocol.name,
        goal: protocol.goal,
        intent: "new-skill",
        planHash: "external-cert",
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
        skillSources: [],
        workflow: input,
        defaultLocale: "en",
      },
      destination: path.join(temporary, "generated"),
      projectRoot: temporary,
    });
    const result = await certifyWorkflowRuntime({
      protocol,
      generatedPackageHash: await hashDirectory(generated.packageRoot),
      packageRoot: generated.packageRoot,
    });
    expect(result.blockers).toEqual([]);
    expect(result.evidence?.entryAdapterStarted).toBe(true);
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
}, 30_000);
