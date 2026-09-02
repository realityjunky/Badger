import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { normalizeWorkflow } from "../src/workflow/contract.js";
import {
  createWorkflowRuntime,
  previewWorkflowFinalization,
} from "../src/workflow-runtime/public.js";
import {
  clearWorkflowFinalizationFaultForTests,
  readWorkflowFinalizationReceipt,
  rollbackWorkflowFinalization,
  setWorkflowFinalizationFaultForTests,
} from "../src/workflow-runtime/finalization.js";
import type { WorkflowInput, WorkflowProtocol } from "../src/types.js";
import type {
  WorkflowContinuation,
  WorkflowRunTarget,
} from "../src/workflow-runtime/types.js";
import { generatePackage } from "../src/factory/generate.js";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

async function recoverInFreshProcess(
  target: WorkflowRunTarget,
): Promise<WorkflowContinuation> {
  const runtimeAsset = path.resolve("assets/runtime/workflow-runtime.mjs");
  const script = `const runtimeModule = await import(${JSON.stringify(pathToFileURL(runtimeAsset).href)}); const continuation = await runtimeModule.createWorkflowRuntime().recover(${JSON.stringify(target)}); console.log(JSON.stringify(continuation));`;
  const result = await execFileAsync(process.execPath, [
    "--input-type=module",
    "-e",
    script,
  ]);
  return JSON.parse(result.stdout) as WorkflowContinuation;
}

const finalizationProfile = {
  version: 1,
  capabilities: [
    "mutation-locks",
    "revision-fences",
    "transition-journal",
    "transactional-finalization",
  ],
  bounds: {
    runStateBytes: 256 * 1024,
    pendingActionBytes: 256 * 1024,
    trajectoryBytes: 1024 * 1024,
    artifactsBytes: 1024 * 1024,
    claimBytes: 16 * 1024,
    transitionJournalBytes: 1024 * 1024,
    runLockBytes: 16 * 1024,
    finalizationPlanBytes: 256 * 1024,
    finalizationTransactionBytes: 1024 * 1024,
    finalizationReceiptBytes: 256 * 1024,
    finalizationContentBytes: 64 * 1024,
    finalizationOperationCount: 16,
    finalizationEventCount: 64,
  },
  schemaVersions: {
    runState: 1,
    pendingAction: 1,
    trajectory: 1,
    artifacts: 1,
    revisionClaim: 1,
    transitionJournal: 1,
    runLock: 1,
    finalizationTransaction: 1,
    finalizationReceipt: 1,
  },
  findingCatalogVersion: 1,
} as const;

const evidenceFinalizationProfile = {
  ...finalizationProfile,
  capabilities: [...finalizationProfile.capabilities, "verification-receipts"],
  bounds: {
    ...finalizationProfile.bounds,
    verificationReceiptBytes: 256 * 1024,
    verificationReceiptCount: 16,
  },
  schemaVersions: {
    ...finalizationProfile.schemaVersions,
    verificationReceipt: 1,
  },
  verificationPolicy: {
    maxSummaryBytes: 256,
    maxEvidenceBytes: 1024,
  },
} as const;

function node(id: string): WorkflowInput["customNodes"][number] {
  return {
    id,
    label: id,
    kind: "action",
    responsibility: `Run ${id}.`,
    implementation: {
      skill: `${id}-skill`,
      operation: "default",
      scope: "main",
    },
    operations: ["require", "augment", "disable"],
    outputSchemas: [],
    guardrails: [],
  };
}

function protocol(): WorkflowProtocol {
  return normalizeWorkflow({
    kind: "workflow-kernel",
    name: "finalization-preview-workflow",
    goal: "Preview a bounded local finalization.",
    customNodes: [node("finish")],
    capabilities: {
      version: 3,
      features: ["conditional-routing", "revisioned-attempts"],
      durability: finalizationProfile,
    },
    finalization: {
      schemaVersion: 1,
      roots: [{ id: "project", path: "." }],
      operations: [
        {
          id: "write-report",
          kind: "write",
          root: "project",
          target: "results/report.txt",
          content: "finalized\n",
        },
      ],
      confirmation: {
        required: true,
        reviewer: { subjects: ["operator"], authorities: ["workflow-owner"] },
        rationale: { required: true },
      },
    },
  }).protocol;
}

function operationsProtocol(): WorkflowProtocol {
  const base = protocol();
  return {
    ...base,
    name: "finalization-operations-workflow",
    finalization: {
      schemaVersion: 1,
      roots: [{ id: "project", path: "." }],
      operations: [
        {
          id: "write-report",
          kind: "write",
          root: "project",
          target: "results/report.txt",
          content: "finalized\n",
        },
        {
          id: "move-source",
          kind: "move",
          root: "project",
          source: "results/source.txt",
          target: "results/moved.txt",
        },
        {
          id: "remove-obsolete",
          kind: "remove",
          root: "project",
          target: "results/obsolete.txt",
        },
      ],
      confirmation: {
        required: true,
        reviewer: { subjects: ["operator"], authorities: ["workflow-owner"] },
        rationale: { required: true },
      },
    },
  };
}

function evidenceProtocol(): WorkflowProtocol {
  const base = protocol();
  return {
    ...base,
    name: "evidence-finalization-workflow",
    capabilities: {
      ...base.capabilities!,
      durability: evidenceFinalizationProfile,
    },
    finalization: {
      ...base.finalization!,
      requiredVerificationReceiptIds: ["missing-receipt"],
    },
  };
}

describe("WorkflowRuntime finalization preview", () => {
  it.each([
    ["manual", (root: string) => root],
    [
      "standalone",
      (root: string) => ({
        kind: "standalone",
        projectRoot: root,
        runId: "preview-run",
      }),
    ],
  ] as const)(
    "is deterministic and read-only for %s Runs",
    async (_kind, targetFor) => {
      const root = await fs.mkdtemp(
        path.join(os.tmpdir(), "comet-finalization-preview-"),
      );
      try {
        const target = targetFor(root);
        const runtime = createWorkflowRuntime();
        await runtime.start({
          protocol: protocol(),
          location: target as never,
          runId: "preview-run",
        });
        const before = await fs.readFile(
          typeof target === "string"
            ? path.join(target, ".comet", "run-state.json")
            : path.join(
                target.projectRoot,
                ".comet",
                "runs",
                target.runId,
                ".comet",
                "run-state.json",
              ),
          "utf8",
        );

        const first = await previewWorkflowFinalization(target as never);
        const second = await previewWorkflowFinalization(target as never);

        expect(first).toEqual(second);
        expect(first).toMatchObject({
          kind: "workflow-finalization-preview",
          runId: "preview-run",
          revision: 0,
          requiresConfirmation: true,
          operations: [
            {
              id: "write-report",
              kind: "write",
              target: "results/report.txt",
              precondition: {
                target: { exists: false, bytes: 0, sha256: null },
              },
              expectedPostState: {
                target: {
                  exists: true,
                  bytes: Buffer.byteLength("finalized\n", "utf8"),
                },
              },
            },
          ],
        });
        expect(first.planHash).toMatch(/^[a-f0-9]{64}$/u);
        await expect(
          fs.stat(
            typeof target === "string"
              ? path.join(target, "results", "report.txt")
              : path.join(target.projectRoot, "results", "report.txt"),
          ),
        ).rejects.toMatchObject({ code: "ENOENT" });
        const after = await fs.readFile(
          typeof target === "string"
            ? path.join(target, ".comet", "run-state.json")
            : path.join(
                target.projectRoot,
                ".comet",
                "runs",
                target.runId,
                ".comet",
                "run-state.json",
              ),
          "utf8",
        );
        expect(after).toBe(before);
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    },
  );

  it("requires the persisted confirmation action before applying effects", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "comet-finalization-apply-"),
    );
    try {
      const runtime = createWorkflowRuntime();
      let current = await runtime.start({
        protocol: protocol(),
        runRoot: root,
        runId: "apply-run",
      });
      expect(current.pendingAction).not.toBeNull();

      current = await runtime.submit(root, {
        actionId: current.pendingAction!.id,
        runId: current.runId,
        revision: current.revision,
        nodeId: current.currentNode,
        execution: current.execution,
        status: "succeeded",
        summary: "Finished the workflow.",
      });

      expect(current.disposition).toBe("await-user");
      expect(current.pendingAction?.finalization).toMatchObject({
        kind: "workflow-finalization-confirmation",
        sourceActionId: expect.any(String),
        planHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
      });
      await expect(
        fs.stat(path.join(root, "results", "report.txt")),
      ).rejects.toMatchObject({
        code: "ENOENT",
      });

      const confirmation = current.pendingAction!.finalization!;
      await expect(previewWorkflowFinalization(root)).resolves.toMatchObject({
        planHash: confirmation.planHash,
      });
      current = await runtime.submit(root, {
        kind: "decision",
        actionId: current.pendingAction!.id,
        runId: current.runId,
        revision: current.revision,
        nodeId: null,
        cycleId: null,
        attemptId: null,
        execution: current.execution,
        decisionId: confirmation.decisionId,
        choiceId: "confirm",
        reviewer: { subject: "operator", authorities: ["workflow-owner"] },
        rationale: "The reviewed local plan is approved.",
        finalization: {
          planHash: confirmation.planHash,
          decisionId: confirmation.decisionId,
          choiceId: "confirm",
          contentSnapshotHash: confirmation.contentSnapshotHash,
          verificationReceiptIds: confirmation.verificationReceiptIds,
        },
      });

      expect(current.disposition).toBe("done");
      expect(current.finalization).toMatchObject({
        status: "committed",
        receipt: { status: "committed" },
      });
      await expect(
        fs.readFile(path.join(root, "results", "report.txt"), "utf8"),
      ).resolves.toBe("finalized\n");
      await expect(
        fs.stat(path.join(root, ".comet", "finalization", "transaction.json")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      await expect(
        fs.stat(
          path.join(
            root,
            ".comet",
            "finalization",
            "receipts",
            `${current.finalization!.receipt!.receiptHash}.json`,
          ),
        ),
      ).resolves.toBeDefined();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("recovers an interrupted write through the public recover seam", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "comet-finalization-recovery-"),
    );
    try {
      const runtime = createWorkflowRuntime();
      let current = await runtime.start({
        protocol: protocol(),
        runRoot: root,
        runId: "recovery-run",
      });
      current = await runtime.submit(root, {
        actionId: current.pendingAction!.id,
        runId: current.runId,
        revision: current.revision,
        nodeId: current.currentNode,
        execution: current.execution,
        status: "succeeded",
        summary: "Finished the workflow.",
      });
      const confirmation = current.pendingAction!.finalization!;
      setWorkflowFinalizationFaultForTests({
        phase: "after-operation",
        operationId: "write-report",
      });
      await expect(
        runtime.submit(root, {
          kind: "decision",
          actionId: current.pendingAction!.id,
          runId: current.runId,
          revision: current.revision,
          nodeId: null,
          cycleId: null,
          attemptId: null,
          execution: current.execution,
          decisionId: confirmation.decisionId,
          choiceId: "confirm",
          reviewer: { subject: "operator", authorities: ["workflow-owner"] },
          rationale: "Recover the reviewed local write.",
          finalization: {
            planHash: confirmation.planHash,
            decisionId: confirmation.decisionId,
            choiceId: "confirm",
            contentSnapshotHash: confirmation.contentSnapshotHash,
            verificationReceiptIds: confirmation.verificationReceiptIds,
          },
        }),
      ).rejects.toThrow("deterministic workflow finalization fault");
      clearWorkflowFinalizationFaultForTests();

      await expect(runtime.resume(root)).resolves.toMatchObject({
        disposition: "blocked",
      });
      current = await recoverInFreshProcess(root);

      expect(current.disposition).toBe("done");
      expect(current.finalization?.status).toBe("committed");
      await expect(
        fs.readFile(path.join(root, "results", "report.txt"), "utf8"),
      ).resolves.toBe("finalized\n");
      await expect(createWorkflowRuntime().recover(root)).resolves.toEqual(
        current,
      );
    } finally {
      clearWorkflowFinalizationFaultForTests();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a preview after its target precondition changes", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "comet-finalization-stale-"),
    );
    try {
      const runtime = createWorkflowRuntime();
      let current = await runtime.start({
        protocol: protocol(),
        runRoot: root,
        runId: "stale-run",
      });
      const preview = await previewWorkflowFinalization(root);
      await fs.mkdir(path.join(root, "results"));
      await fs.writeFile(path.join(root, "results", "report.txt"), "drifted\n");
      const stateBefore = current.pendingAction;

      const blocked = await runtime.submit(root, {
        actionId: current.pendingAction!.id,
        runId: current.runId,
        revision: current.revision,
        nodeId: current.currentNode,
        execution: current.execution,
        status: "succeeded",
        summary: "Finished with a stale preview.",
        finalization: { planHash: preview.planHash },
      });

      expect(blocked.disposition).toBe("blocked");
      expect(blocked.pendingAction?.id).toBe(stateBefore?.id);
      expect(blocked.revision).toBe(current.revision);
      await expect(
        fs.readFile(path.join(root, ".comet", "run-state.json"), "utf8"),
      ).resolves.toContain(stateBefore!.id);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("applies write, move, and remove operations with one receipt", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "comet-finalization-operations-"),
    );
    try {
      await fs.mkdir(path.join(root, "results"));
      await fs.writeFile(path.join(root, "results", "source.txt"), "source\n");
      await fs.writeFile(
        path.join(root, "results", "obsolete.txt"),
        "obsolete\n",
      );
      const runtime = createWorkflowRuntime();
      let current = await runtime.start({
        protocol: operationsProtocol(),
        runRoot: root,
        runId: "operations-run",
      });
      current = await runtime.submit(root, {
        actionId: current.pendingAction!.id,
        runId: current.runId,
        revision: current.revision,
        nodeId: current.currentNode,
        execution: current.execution,
        status: "succeeded",
        summary: "Finished the operations workflow.",
      });
      const confirmation = current.pendingAction!.finalization!;
      current = await runtime.submit(root, {
        kind: "decision",
        actionId: current.pendingAction!.id,
        runId: current.runId,
        revision: current.revision,
        nodeId: null,
        cycleId: null,
        attemptId: null,
        execution: current.execution,
        decisionId: confirmation.decisionId,
        choiceId: "confirm",
        reviewer: { subject: "operator", authorities: ["workflow-owner"] },
        rationale: "Apply the reviewed local operations.",
        finalization: {
          planHash: confirmation.planHash,
          decisionId: confirmation.decisionId,
          choiceId: "confirm",
          contentSnapshotHash: confirmation.contentSnapshotHash,
          verificationReceiptIds: confirmation.verificationReceiptIds,
        },
      });

      expect(current.disposition).toBe("done");
      await expect(
        fs.readFile(path.join(root, "results", "report.txt"), "utf8"),
      ).resolves.toBe("finalized\n");
      await expect(
        fs.readFile(path.join(root, "results", "moved.txt"), "utf8"),
      ).resolves.toBe("source\n");
      await expect(
        fs.stat(path.join(root, "results", "source.txt")),
      ).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(
        fs.stat(path.join(root, "results", "obsolete.txt")),
      ).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(current.finalization?.receipt).toMatchObject({
        status: "committed",
      });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("forwards preview and finalization confirmation through generated adapters", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "comet-finalization-generated-"),
    );
    try {
      const generated = await generatePackage({
        proposal: {
          schemaVersion: 1,
          name: protocol().name,
          goal: protocol().goal,
          intent: "new-skill",
          planHash: "plan-hash",
          workflow: protocol(),
          candidates: [],
          blockers: [],
          warnings: [],
          canInitialize: true,
        },
        plan: {
          schemaVersion: 1,
          goal: protocol().goal,
          skillCreatorIntent: "new-skill",
          preferredSkills: [],
          workflow: protocol() as unknown as WorkflowInput,
          defaultLocale: "en",
        },
        destination: path.join(root, "generated"),
      });
      const stateScript = path.join(
        generated.packageRoot,
        "scripts",
        "workflow-state.mjs",
      );
      const target = {
        kind: "standalone",
        projectRoot: root,
        runId: "generated-finalization-run",
      } as const;
      const args = (command: string, ...rest: string[]) => [
        stateScript,
        command,
        ...rest,
        "--project",
        root,
        "--run-id",
        target.runId,
        "--json",
      ];
      const run = async (command: string, ...rest: string[]) =>
        JSON.parse(
          (await execFileAsync(process.execPath, args(command, ...rest)))
            .stdout,
        ) as Record<string, any>;

      let current = await run("init");
      const preview = await run("preview");
      current = await run(
        "record",
        "finish",
        JSON.stringify({ status: "succeeded", summary: "Generated finish." }),
      );
      const confirmation = current.pendingAction.finalization;
      current = await run(
        "decide",
        "finalization",
        "--response",
        JSON.stringify({
          decisionId: confirmation.decisionId,
          choiceId: "confirm",
          reviewer: { subject: "operator", authorities: ["workflow-owner"] },
          rationale: "Apply the generated plan.",
          finalization: {
            planHash: confirmation.planHash,
            decisionId: confirmation.decisionId,
            choiceId: "confirm",
            contentSnapshotHash: confirmation.contentSnapshotHash,
            verificationReceiptIds: confirmation.verificationReceiptIds,
          },
        }),
      );

      expect(preview.planHash).toBeDefined();
      expect(current.disposition).toBe("done");
      await expect(
        fs.readFile(path.join(root, "results", "report.txt"), "utf8"),
      ).resolves.toBe("finalized\n");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    "prepared",
    "applying",
    "before-staging",
    "staged",
    "before-operation",
    "after-operation",
    "operation-verified",
    "committing",
    "before-receipt",
    "receipt-written",
  ] as const)("recovers a transaction fault at %s", async (phase) => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "comet-finalization-boundary-"),
    );
    try {
      const runtime = createWorkflowRuntime();
      let current = await runtime.start({
        protocol: protocol(),
        runRoot: root,
        runId: `boundary-${phase}`,
      });
      current = await runtime.submit(root, {
        actionId: current.pendingAction!.id,
        runId: current.runId,
        revision: current.revision,
        nodeId: current.currentNode,
        execution: current.execution,
        status: "succeeded",
        summary: "Finished before the finalization boundary.",
      });
      const confirmation = current.pendingAction!.finalization!;
      setWorkflowFinalizationFaultForTests({ phase });
      await expect(
        runtime.submit(root, {
          kind: "decision",
          actionId: current.pendingAction!.id,
          runId: current.runId,
          revision: current.revision,
          nodeId: null,
          cycleId: null,
          attemptId: null,
          execution: current.execution,
          decisionId: confirmation.decisionId,
          choiceId: "confirm",
          reviewer: { subject: "operator", authorities: ["workflow-owner"] },
          rationale: `Recover the ${phase} boundary.`,
          finalization: {
            planHash: confirmation.planHash,
            decisionId: confirmation.decisionId,
            choiceId: "confirm",
            contentSnapshotHash: confirmation.contentSnapshotHash,
            verificationReceiptIds: confirmation.verificationReceiptIds,
          },
        }),
      ).rejects.toThrow("deterministic workflow finalization fault");
      clearWorkflowFinalizationFaultForTests();

      const recovered = await createWorkflowRuntime().recover(root);
      expect(recovered.disposition).toBe("done");
      expect(recovered.finalization?.status).toBe("committed");
      const receiptReference = recovered.finalization?.receipt;
      expect(receiptReference).toBeDefined();
      await expect(
        readWorkflowFinalizationReceipt(
          root,
          receiptReference!.receiptHash,
          finalizationProfile,
        ),
      ).resolves.toMatchObject({ recovery: { status: "recovered" } });
      await expect(
        fs.readFile(path.join(root, "results", "report.txt"), "utf8"),
      ).resolves.toBe("finalized\n");
    } finally {
      clearWorkflowFinalizationFaultForTests();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("recovers an interrupted standalone finalization in a fresh process", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "comet-finalization-standalone-recovery-"),
    );
    const target = {
      kind: "standalone",
      projectRoot: root,
      runId: "standalone-recovery-run",
    } as const;
    try {
      const runtime = createWorkflowRuntime();
      let current = await runtime.start({
        protocol: protocol(),
        location: target,
      });
      current = await runtime.submit(target, {
        actionId: current.pendingAction!.id,
        runId: current.runId,
        revision: current.revision,
        nodeId: current.currentNode,
        execution: current.execution,
        status: "succeeded",
        summary: "Finish the standalone workflow.",
      });
      const confirmation = current.pendingAction!.finalization!;
      setWorkflowFinalizationFaultForTests({ phase: "after-operation" });
      await expect(
        runtime.submit(target, {
          kind: "decision",
          actionId: current.pendingAction!.id,
          runId: current.runId,
          revision: current.revision,
          nodeId: null,
          cycleId: null,
          attemptId: null,
          execution: current.execution,
          decisionId: confirmation.decisionId,
          choiceId: "confirm",
          reviewer: { subject: "operator", authorities: ["workflow-owner"] },
          rationale: "Recover the standalone write.",
          finalization: {
            planHash: confirmation.planHash,
            decisionId: confirmation.decisionId,
            choiceId: "confirm",
            contentSnapshotHash: confirmation.contentSnapshotHash,
            verificationReceiptIds: confirmation.verificationReceiptIds,
          },
        }),
      ).rejects.toThrow("deterministic workflow finalization fault");
      clearWorkflowFinalizationFaultForTests();

      current = await recoverInFreshProcess(target);
      expect(current.disposition).toBe("done");
      await expect(
        fs.readFile(path.join(root, "results", "report.txt"), "utf8"),
      ).resolves.toBe("finalized\n");
      await expect(
        fs.stat(path.join(root, ".comet", "finalization", "transaction.json")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      clearWorkflowFinalizationFaultForTests();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("blocks recovery when an affected identity is neither previous nor intended", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "comet-finalization-unknown-"),
    );
    try {
      const runtime = createWorkflowRuntime();
      let current = await runtime.start({
        protocol: protocol(),
        runRoot: root,
        runId: "unknown-run",
      });
      current = await runtime.submit(root, {
        actionId: current.pendingAction!.id,
        runId: current.runId,
        revision: current.revision,
        nodeId: current.currentNode,
        execution: current.execution,
        status: "succeeded",
        summary: "Finished before the unknown identity.",
      });
      const confirmation = current.pendingAction!.finalization!;
      setWorkflowFinalizationFaultForTests({ phase: "before-operation" });
      await expect(
        runtime.submit(root, {
          kind: "decision",
          actionId: current.pendingAction!.id,
          runId: current.runId,
          revision: current.revision,
          nodeId: null,
          cycleId: null,
          attemptId: null,
          execution: current.execution,
          decisionId: confirmation.decisionId,
          choiceId: "confirm",
          reviewer: { subject: "operator", authorities: ["workflow-owner"] },
          rationale: "Preserve the unknown identity for recovery.",
          finalization: {
            planHash: confirmation.planHash,
            decisionId: confirmation.decisionId,
            choiceId: "confirm",
            contentSnapshotHash: confirmation.contentSnapshotHash,
            verificationReceiptIds: confirmation.verificationReceiptIds,
          },
        }),
      ).rejects.toThrow("deterministic workflow finalization fault");
      clearWorkflowFinalizationFaultForTests();
      await fs.mkdir(path.join(root, "results"));
      await fs.writeFile(path.join(root, "results", "report.txt"), "unknown\n");

      const blocked = await createWorkflowRuntime().recover(root);
      expect(blocked.disposition).toBe("blocked");
      expect(blocked.findings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: "recovery-required",
            requiredAction: "repair",
          }),
        ]),
      );
      await expect(
        fs.stat(path.join(root, ".comet", "finalization", "transaction.json")),
      ).resolves.toBeDefined();
    } finally {
      clearWorkflowFinalizationFaultForTests();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("rejects stale confirmation without consuming the revision claim", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "comet-finalization-confirmation-stale-"),
    );
    try {
      const runtime = createWorkflowRuntime();
      let current = await runtime.start({
        protocol: protocol(),
        runRoot: root,
        runId: "confirmation-stale-run",
      });
      current = await runtime.submit(root, {
        actionId: current.pendingAction!.id,
        runId: current.runId,
        revision: current.revision,
        nodeId: current.currentNode,
        execution: current.execution,
        status: "succeeded",
        summary: "Finished the workflow.",
      });
      const confirmation = current.pendingAction!.finalization!;
      await fs.mkdir(path.join(root, "results"));
      await fs.writeFile(path.join(root, "results", "report.txt"), "drifted\n");
      const stale = await runtime.submit(root, {
        kind: "decision",
        actionId: current.pendingAction!.id,
        runId: current.runId,
        revision: current.revision,
        nodeId: null,
        cycleId: null,
        attemptId: null,
        execution: current.execution,
        decisionId: confirmation.decisionId,
        choiceId: "confirm",
        reviewer: { subject: "operator", authorities: ["workflow-owner"] },
        rationale: "This confirmation must be refreshed.",
        finalization: {
          planHash: confirmation.planHash,
          decisionId: confirmation.decisionId,
          choiceId: "confirm",
          contentSnapshotHash: confirmation.contentSnapshotHash,
          verificationReceiptIds: confirmation.verificationReceiptIds,
        },
      });
      expect(stale.disposition).toBe("blocked");
      current = await runtime.resume(root);
      expect(current.pendingAction?.id).not.toBe(confirmation.actionId);
      const refreshed = current.pendingAction!.finalization!;
      current = await runtime.submit(root, {
        kind: "decision",
        actionId: current.pendingAction!.id,
        runId: current.runId,
        revision: current.revision,
        nodeId: null,
        cycleId: null,
        attemptId: null,
        execution: current.execution,
        decisionId: refreshed.decisionId,
        choiceId: "confirm",
        reviewer: { subject: "operator", authorities: ["workflow-owner"] },
        rationale: "The refreshed local plan is approved.",
        finalization: {
          planHash: refreshed.planHash,
          decisionId: refreshed.decisionId,
          choiceId: "confirm",
          contentSnapshotHash: refreshed.contentSnapshotHash,
          verificationReceiptIds: refreshed.verificationReceiptIds,
        },
      });
      expect(current.disposition).toBe("done");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("keeps a cancelled finalization non-terminal", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "comet-finalization-cancel-"),
    );
    try {
      const runtime = createWorkflowRuntime();
      let current = await runtime.start({
        protocol: protocol(),
        runRoot: root,
        runId: "cancel-run",
      });
      current = await runtime.submit(root, {
        actionId: current.pendingAction!.id,
        runId: current.runId,
        revision: current.revision,
        nodeId: current.currentNode,
        execution: current.execution,
        status: "succeeded",
        summary: "Finish before cancellation.",
      });
      const confirmation = current.pendingAction!.finalization!;
      current = await runtime.submit(root, {
        kind: "decision",
        actionId: current.pendingAction!.id,
        runId: current.runId,
        revision: current.revision,
        nodeId: null,
        cycleId: null,
        attemptId: null,
        execution: current.execution,
        decisionId: confirmation.decisionId,
        choiceId: "cancel",
        reviewer: { subject: "operator", authorities: ["workflow-owner"] },
        rationale: "Do not apply this finalization.",
        finalization: {
          planHash: confirmation.planHash,
          decisionId: confirmation.decisionId,
          choiceId: "cancel",
          contentSnapshotHash: confirmation.contentSnapshotHash,
          verificationReceiptIds: confirmation.verificationReceiptIds,
        },
      });

      expect(current.disposition).toBe("blocked");
      expect(current.finalization?.status).toBe("rolled-back");
      await expect(
        fs.stat(path.join(root, "results", "report.txt")),
      ).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("records rollback evidence and never converts rollback into done", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "comet-finalization-rollback-"),
    );
    try {
      const runtime = createWorkflowRuntime();
      let current = await runtime.start({
        protocol: protocol(),
        runRoot: root,
        runId: "rollback-run",
      });
      current = await runtime.submit(root, {
        actionId: current.pendingAction!.id,
        runId: current.runId,
        revision: current.revision,
        nodeId: current.currentNode,
        execution: current.execution,
        status: "succeeded",
        summary: "Finish before rollback.",
      });
      const confirmation = current.pendingAction!.finalization!;
      setWorkflowFinalizationFaultForTests({ phase: "after-operation" });
      await expect(
        runtime.submit(root, {
          kind: "decision",
          actionId: current.pendingAction!.id,
          runId: current.runId,
          revision: current.revision,
          nodeId: null,
          cycleId: null,
          attemptId: null,
          execution: current.execution,
          decisionId: confirmation.decisionId,
          choiceId: "confirm",
          reviewer: { subject: "operator", authorities: ["workflow-owner"] },
          rationale: "Roll back the interrupted write.",
          finalization: {
            planHash: confirmation.planHash,
            decisionId: confirmation.decisionId,
            choiceId: "confirm",
            contentSnapshotHash: confirmation.contentSnapshotHash,
            verificationReceiptIds: confirmation.verificationReceiptIds,
          },
        }),
      ).rejects.toThrow("deterministic workflow finalization fault");
      clearWorkflowFinalizationFaultForTests();

      await expect(
        rollbackWorkflowFinalization({
          runRoot: root,
          baseRoot: root,
          profile: finalizationProfile,
          runId: "another-run",
          execution: current.execution,
        }),
      ).rejects.toThrow("runId");
      await expect(
        rollbackWorkflowFinalization({
          runRoot: root,
          baseRoot: root,
          profile: finalizationProfile,
          runId: current.runId,
          execution: {
            ...current.execution,
            protocolHash: "0".repeat(64),
          },
        }),
      ).rejects.toThrow("execution");
      setWorkflowFinalizationFaultForTests({ phase: "before-receipt" });
      await expect(
        runtime.recover(root, { rollbackFinalization: true }),
      ).rejects.toThrow("deterministic workflow finalization fault");
      clearWorkflowFinalizationFaultForTests();
      current = await runtime.recover(root, { rollbackFinalization: true });
      expect(current.disposition).toBe("blocked");
      await expect(
        fs.stat(path.join(root, "results", "report.txt")),
      ).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(current.finalization?.status).toBe("rolled-back");
      expect(current.finalization?.receipt).toMatchObject({
        status: "rolled-back",
      });
      await expect(
        readWorkflowFinalizationReceipt(
          root,
          current.finalization!.receipt!.receiptHash,
          finalizationProfile,
        ),
      ).resolves.toMatchObject({ recovery: { status: "rolled-back" } });
    } finally {
      clearWorkflowFinalizationFaultForTests();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("rejects unsafe and unregistered finalization declarations before creating a Run", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "comet-finalization-contract-"),
    );
    try {
      const unsafePath = {
        ...protocol(),
        finalization: {
          ...protocol().finalization!,
          operations: [
            {
              ...protocol().finalization!.operations[0],
              target: "../outside",
            },
          ],
        },
      } as WorkflowProtocol;
      await expect(
        createWorkflowRuntime().start({
          protocol: unsafePath,
          runRoot: root,
          runId: "unsafe-path-run",
        }),
      ).rejects.toThrow("safe relative path");

      const unregistered = {
        ...protocol(),
        finalization: {
          ...protocol().finalization!,
          operations: [
            {
              ...protocol().finalization!.operations[0],
              kind: "command",
            },
          ],
        },
      } as unknown as WorkflowProtocol;
      await expect(
        createWorkflowRuntime().start({
          protocol: unregistered,
          runRoot: root,
          runId: "unregistered-run",
        }),
      ).rejects.toThrow("not registered");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("requires currently passed Verification Receipts before preview", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "comet-finalization-evidence-"),
    );
    try {
      await createWorkflowRuntime().start({
        protocol: evidenceProtocol(),
        runRoot: root,
        runId: "evidence-run",
      });
      await expect(previewWorkflowFinalization(root)).rejects.toThrow(
        "verification receipt is missing",
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
