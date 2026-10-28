import { describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  buildWorkflowRepairSignature,
  decideWorkflowRepair,
  executeWorkflowRepairOperation,
  type WorkflowRepairFailureFacts,
  type WorkflowRepairHistoryRecord,
} from "../src/workflow-runtime/repair.js";
import type { WorkflowRepairPolicy } from "../src/types.js";
import { parseWorkflowDurabilityProfile } from "../src/workflow-runtime/durability.js";
import { normalizeWorkflow } from "../src/workflow/contract.js";
import { createWorkflowRuntime } from "../src/workflow-runtime/public.js";
import {
  projectWorkflowHandoff,
  projectWorkflowState,
} from "../src/workflow-runtime/index.js";
import type { WorkflowInput, WorkflowProtocol } from "../src/types.js";
import { readRunState } from "../src/engine/state.js";
import { generatePackage } from "../src/factory/generate.js";

const execFileAsync = promisify(execFile);

const protocolHash = "a".repeat(64);
const packageHash = "b".repeat(64);
const snapshotHash = "c".repeat(64);

const policy: WorkflowRepairPolicy = {
  maxFailures: 4,
  warningThreshold: 2,
  manualStopThreshold: 3,
  allowedChoices: [
    { id: "retry", label: "Retry with a new approach", outcome: "retry" },
    { id: "stop", label: "Stop", outcome: "stop" },
    {
      id: "contract-change",
      label: "Change the contract",
      outcome: "contract-change",
    },
  ],
  allowOneTimeOverride: true,
  maxOverrideRationaleBytes: 256,
};

const runtimeProfile = {
  version: 1,
  capabilities: [
    "mutation-locks",
    "revision-fences",
    "transition-journal",
    "repair-policy",
  ],
  bounds: {
    runStateBytes: 256 * 1024,
    pendingActionBytes: 256 * 1024,
    trajectoryBytes: 8 * 1024 * 1024,
    artifactsBytes: 1024 * 1024,
    claimBytes: 16 * 1024,
    transitionJournalBytes: 1024 * 1024,
    runLockBytes: 16 * 1024,
    repairHistoryBytes: 256 * 1024,
    repairHistoryCount: 32,
  },
  schemaVersions: {
    runState: 1,
    pendingAction: 1,
    trajectory: 1,
    artifacts: 1,
    revisionClaim: 1,
    transitionJournal: 1,
    runLock: 1,
    repairEpisode: 1,
  },
  findingCatalogVersion: 1,
  repairPolicy: policy,
} as const;

const receiptRuntimeProfile = {
  ...runtimeProfile,
  capabilities: [...runtimeProfile.capabilities, "verification-receipts"],
  bounds: {
    ...runtimeProfile.bounds,
    verificationReceiptBytes: 256 * 1024,
    verificationReceiptCount: 32,
  },
  schemaVersions: {
    ...runtimeProfile.schemaVersions,
    verificationReceipt: 1,
  },
  verificationPolicy: {
    maxSummaryBytes: 256,
    maxEvidenceBytes: 1024,
  },
} as const;

const checkpointRuntimeProfile = {
  ...runtimeProfile,
  capabilities: [...runtimeProfile.capabilities, "verified-checkpoints"],
  bounds: {
    ...runtimeProfile.bounds,
    checkpointManifestBytes: 256 * 1024,
    checkpointRecordBytes: 256 * 1024,
    checkpointCount: 32,
  },
  schemaVersions: {
    ...runtimeProfile.schemaVersions,
    checkpointManifest: 1,
    checkpointRecord: 1,
  },
} as const;

function facts(overrides: Partial<WorkflowRepairFailureFacts> = {}) {
  return {
    protocolHash,
    execution: {
      protocolHash,
      packageHash,
      snapshotHash,
      nodeToStep: { verify: "node-verify" },
      capabilityVersion: 3 as const,
      resolverHash: "d".repeat(64),
    },
    attemptId: "attempt-verify",
    nodeId: "verify",
    cycleId: null,
    visitOrdinal: 1,
    actionId: "action-retry-1",
    findingCodes: ["verification-receipt-failed"],
    failedReceiptCoverage: ["requirement:verification"],
    failedAcceptanceCoverage: ["guardrail:verify.accepted"],
    scopeIdentities: ["scope-1"],
    snapshotIdentities: [snapshotHash],
    artifactIdentities: ["artifact:result@version-1"],
    ...overrides,
  } satisfies WorkflowRepairFailureFacts;
}

function failureRecord(
  revision: number,
  signature: ReturnType<typeof buildWorkflowRepairSignature>,
): WorkflowRepairHistoryRecord {
  return {
    kind: "failure",
    revision,
    signatureHash: signature.signatureHash,
    findingCodes: signature.findingCodes,
    failedReceiptCoverage: signature.failedReceiptCoverage,
    failedAcceptanceCoverage: signature.failedAcceptanceCoverage,
    scopeIdentities: signature.scopeIdentities,
    snapshotIdentities: signature.snapshotIdentities,
    artifactIdentities: signature.artifactIdentities,
  };
}

function runtimeNode(
  id: string,
  guardrails: WorkflowInput["customNodes"][number]["guardrails"] = [],
): WorkflowInput["customNodes"][number] {
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
    guardrails,
  };
}

function runtimeProtocol(
  profile: Record<string, unknown> = runtimeProfile,
  name = "repair-runtime-workflow",
  guardrails: WorkflowInput["customNodes"][number]["guardrails"] = [],
): WorkflowProtocol {
  const input: WorkflowInput = {
    kind: "workflow-kernel",
    name,
    goal: "Exercise finite repair episodes.",
    capabilities: {
      version: 3,
      features: ["conditional-routing", "revisioned-attempts"],
      durability: structuredClone(profile),
    },
    customNodes: [runtimeNode("verify", guardrails), runtimeNode("finish")],
  };
  return normalizeWorkflow(input).protocol;
}

describe("WorkflowRuntime repair policy", () => {
  it("binds identity while ignoring cosmetic values and incidental ordering", () => {
    const first = buildWorkflowRepairSignature(facts());
    const reordered = buildWorkflowRepairSignature(
      facts({
        actionId: "action-retry-2",
        summary: "A different human-readable failure.",
        timestamp: "2099-01-01T00:00:00.000Z",
        findingCodes: ["verification-receipt-failed"],
        failedReceiptCoverage: ["requirement:verification"],
        failedAcceptanceCoverage: ["guardrail:verify.accepted"],
      }),
    );

    expect(reordered).toEqual(first);
    expect(
      buildWorkflowRepairSignature(facts({ attemptId: "attempt-other" })),
    ).not.toEqual(first);
    expect(
      buildWorkflowRepairSignature(
        facts({ snapshotIdentities: ["snapshot-2"] }),
      ),
    ).not.toEqual(first);
  });

  it("recognizes progress and applies warning, stop, and hard thresholds", () => {
    const signature = buildWorkflowRepairSignature(facts());
    const first = decideWorkflowRepair({ facts: facts(), history: [], policy });
    expect(first).toMatchObject({
      disposition: "continue",
      reasonCode: "new-failure-signature",
      consecutiveFailures: 1,
      totalFailures: 1,
      remainingFailures: 3,
    });

    const second = decideWorkflowRepair({
      facts: facts(),
      history: [failureRecord(1, signature)],
      policy,
    });
    expect(second).toMatchObject({
      disposition: "warning",
      reasonCode: "repeated-failure-warning",
      consecutiveFailures: 2,
      totalFailures: 2,
    });

    const third = decideWorkflowRepair({
      facts: facts(),
      history: [failureRecord(1, signature), failureRecord(2, signature)],
      policy,
    });
    expect(third).toMatchObject({
      disposition: "manual-stop",
      reasonCode: "repeated-failure-stop",
      consecutiveFailures: 3,
      totalFailures: 3,
      remainingFailures: 1,
    });

    const fourth = decideWorkflowRepair({
      facts: facts(),
      history: [
        failureRecord(1, signature),
        failureRecord(2, signature),
        failureRecord(3, signature),
      ],
      policy,
    });
    expect(fourth).toMatchObject({
      disposition: "hard-stop",
      reasonCode: "repair-iteration-limit",
      totalFailures: 4,
      remainingFailures: 0,
    });

    const reduced = buildWorkflowRepairSignature(
      facts({ failedAcceptanceCoverage: [] }),
    );
    const progressing = decideWorkflowRepair({
      facts: facts({ failedAcceptanceCoverage: [] }),
      history: [failureRecord(1, signature), failureRecord(2, signature)],
      policy,
    });
    expect(progressing).toMatchObject({
      disposition: "continue",
      consecutiveFailures: 1,
      totalFailures: 3,
    });
    const distinct = decideWorkflowRepair({
      facts: facts({ findingCodes: ["different-failure"] }),
      history: [failureRecord(1, signature)],
      policy,
    });
    expect(distinct).toMatchObject({
      disposition: "continue",
      consecutiveFailures: 1,
      totalFailures: 2,
    });
    const boundedAutomaticOperation = decideWorkflowRepair({
      facts: facts(),
      history: [failureRecord(1, signature), failureRecord(2, signature)],
      policy: {
        ...policy,
        automaticRepair: {
          id: "retry",
          operation: "workflow.resume",
          idempotent: true,
          maxExecutions: 2,
        },
      },
    });
    expect(boundedAutomaticOperation).toMatchObject({
      disposition: "hard-stop",
      reasonCode: "repair-iteration-limit",
      remainingFailures: 0,
    });
    const scopeProgress = decideWorkflowRepair({
      facts: facts({ scopeIdentities: ["scope-2"] }),
      history: [failureRecord(1, signature)],
      policy,
    });
    expect(scopeProgress).toMatchObject({
      disposition: "continue",
      consecutiveFailures: 1,
      totalFailures: 2,
    });
    expect(reduced.signatureHash).not.toBe(signature.signatureHash);
  });

  it("enforces the registered automatic operation execution bound", async () => {
    const operation = {
      id: "retry",
      operation: "workflow.resume" as const,
      idempotent: true as const,
      maxExecutions: 1,
    };
    await expect(
      executeWorkflowRepairOperation(operation, 1, async () => "resumed"),
    ).resolves.toBe("resumed");
    await expect(
      executeWorkflowRepairOperation(operation, 2, async () => "resumed"),
    ).rejects.toThrow(/exceeded its bound/iu);
  });

  it("normalizes a hash-bound repair profile and requires bounded history", () => {
    const parsed = parseWorkflowDurabilityProfile({
      version: 1,
      capabilities: [
        "mutation-locks",
        "revision-fences",
        "transition-journal",
        "repair-policy",
      ],
      bounds: {
        runStateBytes: 256 * 1024,
        pendingActionBytes: 256 * 1024,
        trajectoryBytes: 8 * 1024 * 1024,
        artifactsBytes: 1024 * 1024,
        claimBytes: 16 * 1024,
        transitionJournalBytes: 1024 * 1024,
        runLockBytes: 16 * 1024,
        repairHistoryBytes: 256 * 1024,
        repairHistoryCount: 32,
      },
      schemaVersions: {
        runState: 1,
        pendingAction: 1,
        trajectory: 1,
        artifacts: 1,
        revisionClaim: 1,
        transitionJournal: 1,
        runLock: 1,
        repairEpisode: 1,
      },
      findingCatalogVersion: 1,
      repairPolicy: policy,
    });

    expect(parsed.repairPolicy).toMatchObject({
      maxFailures: 4,
      warningThreshold: 2,
      manualStopThreshold: 3,
      allowOneTimeOverride: true,
    });
    expect(parsed.capabilities).toContain("repair-policy");
    expect(parsed.bounds.repairHistoryCount).toBe(32);
    expect(parsed.repairPolicy?.automaticRepairs).toEqual([
      {
        id: "retry",
        operation: "workflow.resume",
        idempotent: true,
        maxExecutions: 4,
      },
    ]);
    expect(() =>
      parseWorkflowDurabilityProfile({
        ...parsed,
        bounds: { ...parsed.bounds, repairHistoryCount: undefined },
      }),
    ).toThrow(/repair-policy requires/iu);
  });

  it("persists the finite repair lifecycle through the public runtime", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "badger-workflow-repair-runtime-"),
    );
    try {
      const runtime = createWorkflowRuntime();
      let continuation = await runtime.start({
        protocol: runtimeProtocol(),
        runRoot: root,
        runId: "repair-runtime-run",
      });
      const submitFailure = async (summary: string) => {
        if (!continuation.pendingAction)
          throw new Error("missing pending action");
        continuation = await runtime.submit(root, {
          actionId: continuation.pendingAction.id,
          runId: continuation.runId,
          revision: continuation.revision,
          nodeId: continuation.currentNode,
          execution: continuation.execution,
          status: "failed",
          summary,
        });
      };

      await submitFailure("first failure");
      expect(continuation.repair).toMatchObject({
        totalFailures: 1,
        disposition: "continue",
      });
      expect(continuation.repair?.history[0]).toMatchObject({
        automaticRepair: {
          operation: "workflow.resume",
          idempotent: true,
        },
      });
      await submitFailure("same failure with new prose");
      expect(continuation).toMatchObject({
        disposition: "continue",
        repair: { totalFailures: 2, disposition: "warning" },
      });
      expect(continuation.findings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: "repair-stagnation-warning" }),
        ]),
      );
      await submitFailure("third equivalent failure");
      expect(continuation).toMatchObject({
        disposition: "await-user",
        repair: { totalFailures: 3, disposition: "manual-stop" },
        pendingAction: {
          type: "ask_user",
          repair: {
            signatureHash: continuation.repair?.signature?.signatureHash,
          },
        },
      });
      expect(continuation.findings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: "repair-stagnation-stop" }),
        ]),
      );
      expect(continuation.repair?.history.at(-1)).toMatchObject({
        kind: "failure",
        disposition: "manual-stop",
        reasonCode: "repeated-failure-stop",
        totalFailures: 3,
      });
      expect((await projectWorkflowState(root))?.repair).toEqual(
        continuation.repair,
      );
      expect(
        (await projectWorkflowHandoff(runtimeProtocol(), continuation)).repair,
      ).toEqual(continuation.repair);

      const stopped = continuation;
      continuation = await runtime.recover(root);
      expect(continuation).toEqual(stopped);
      expect(continuation.pendingAction?.type).toBe("ask_user");

      continuation = await runtime.submit(root, {
        kind: "decision",
        actionId: continuation.pendingAction!.id,
        runId: continuation.runId,
        revision: continuation.revision,
        nodeId: continuation.currentNode!,
        cycleId: continuation.cycleId,
        attemptId: continuation.attemptId!,
        choiceId: "retry",
        reviewer: { subject: "reviewer", authorities: ["repair"] },
        execution: continuation.execution,
      });
      expect(continuation).toMatchObject({
        disposition: "continue",
        repair: { disposition: "continue" },
      });

      await submitFailure("hard budget failure");
      expect(continuation).toMatchObject({
        disposition: "blocked",
        pendingAction: null,
        repair: { totalFailures: 4, disposition: "hard-stop" },
        findings: expect.arrayContaining([
          expect.objectContaining({ code: "repair-iteration-limit" }),
        ]),
      });
      expect(continuation.repair?.history.at(-1)).toMatchObject({
        kind: "failure",
        disposition: "hard-stop",
        reasonCode: "repair-iteration-limit",
      });
      expect((await runtime.recover(root)).repair?.totalFailures).toBe(4);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("accepts one bound override and rejects its replay without mutation", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "badger-workflow-repair-override-"),
    );
    try {
      const profile = {
        ...runtimeProfile,
        repairPolicy: { ...policy, maxFailures: 5 },
      } as const;
      const runtime = createWorkflowRuntime();
      let continuation = await runtime.start({
        protocol: runtimeProtocol(profile, "repair-override-workflow"),
        runRoot: root,
        runId: "repair-override-run",
      });
      for (const summary of ["failure one", "failure two", "failure three"]) {
        continuation = await runtime.submit(root, {
          actionId: continuation.pendingAction!.id,
          runId: continuation.runId,
          revision: continuation.revision,
          nodeId: continuation.currentNode,
          execution: continuation.execution,
          status: "failed",
          summary,
        });
      }
      const signatureHash = continuation.repair!.signature!.signatureHash;
      const overridden = await runtime.submit(root, {
        kind: "decision",
        actionId: continuation.pendingAction!.id,
        runId: continuation.runId,
        revision: continuation.revision,
        nodeId: continuation.currentNode!,
        cycleId: continuation.cycleId,
        attemptId: continuation.attemptId!,
        choiceId: "retry",
        reviewer: { subject: "reviewer", authorities: ["repair"] },
        rationale: "The verifier will use an independent repair path.",
        repair: {
          expectedSignatureHash: signatureHash,
          hypothesis:
            "Use an independent repair path and preserve every check.",
        },
        execution: continuation.execution,
      });
      expect(overridden).toMatchObject({
        disposition: "continue",
        repair: { disposition: "continue" },
      });
      expect(overridden.repair?.history.at(-1)).toMatchObject({
        kind: "override",
        signatureHash,
      });

      continuation = await runtime.submit(root, {
        actionId: overridden.pendingAction!.id,
        runId: overridden.runId,
        revision: overridden.revision,
        nodeId: overridden.currentNode,
        execution: overridden.execution,
        status: "failed",
        summary: "The same failure remains after the new hypothesis.",
      });
      expect(continuation.repair).toMatchObject({
        totalFailures: 4,
        remainingFailures: 1,
      });
      expect(continuation.repair?.reasonCode).toBe("override-already-used");
      const beforeReplay = JSON.stringify(await readRunState(root));
      await expect(
        runtime.submit(root, {
          kind: "decision",
          actionId: continuation.pendingAction!.id,
          runId: continuation.runId,
          revision: continuation.revision,
          nodeId: continuation.currentNode!,
          cycleId: continuation.cycleId,
          attemptId: continuation.attemptId!,
          choiceId: "retry",
          reviewer: { subject: "reviewer", authorities: ["repair"] },
          rationale: "Try the same hypothesis again.",
          repair: {
            expectedSignatureHash: signatureHash,
            hypothesis: "Try the same hypothesis again.",
          },
          execution: continuation.execution,
        }),
      ).rejects.toMatchObject({
        finding: { code: "repair-override-exhausted" },
      });
      expect(JSON.stringify(await readRunState(root))).toBe(beforeReplay);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("stops on contract change without changing the captured identity", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "badger-workflow-repair-contract-"),
    );
    try {
      const runtime = createWorkflowRuntime();
      let continuation = await runtime.start({
        protocol: runtimeProtocol(runtimeProfile, "repair-contract-workflow"),
        runRoot: root,
        runId: "repair-contract-run",
      });
      for (let failure = 0; failure < 3; failure += 1) {
        continuation = await runtime.submit(root, {
          actionId: continuation.pendingAction!.id,
          runId: continuation.runId,
          revision: continuation.revision,
          nodeId: continuation.currentNode,
          execution: continuation.execution,
          status: "failed",
          summary: `failure ${failure + 1}`,
        });
      }
      const execution = continuation.execution;
      const stopped = await runtime.submit(root, {
        kind: "decision",
        actionId: continuation.pendingAction!.id,
        runId: continuation.runId,
        revision: continuation.revision,
        nodeId: continuation.currentNode!,
        cycleId: continuation.cycleId,
        attemptId: continuation.attemptId!,
        choiceId: "contract-change",
        reviewer: { subject: "reviewer", authorities: ["repair"] },
        execution,
      });
      expect(stopped).toMatchObject({
        disposition: "blocked",
        pendingAction: null,
        repair: { disposition: "manual-stop" },
      });
      expect(stopped.execution).toEqual(execution);
      expect((await runtime.recover(root)).execution).toEqual(execution);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("keeps generated adapters as projections over repair policy", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "badger-workflow-repair-generated-"),
    );
    try {
      const protocol = runtimeProtocol(
        runtimeProfile,
        "repair-generated-workflow",
      );
      const generated = await generatePackage({
        proposal: {
          schemaVersion: 1,
          name: protocol.name,
          goal: protocol.goal,
          intent: "new-skill",
          planHash: "plan-hash",
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
          workflow: protocol as unknown as WorkflowInput,
          defaultLocale: "en",
        },
        destination: path.join(root, "generated"),
        projectRoot: root,
      });
      const stateScript = path.join(
        generated.packageRoot,
        "scripts",
        "workflow-state.mjs",
      );
      const runRoot = path.join(root, "run");
      expect(
        await fs.readFile(path.join(generated.packageRoot, "SKILL.md"), "utf8"),
      ).toContain("## Repair Policy");
      const run = async (...args: string[]) =>
        execFileAsync("node", [stateScript, ...args], { cwd: runRoot });
      await fs.mkdir(runRoot, { recursive: true });
      await run(
        "init",
        "--run-root",
        runRoot,
        "--run-id",
        "generated-repair-run",
      );
      for (const summary of [
        "generated one",
        "generated two",
        "generated three",
      ]) {
        await run(
          "record",
          "verify",
          JSON.stringify({ status: "failed", summary }),
          "--run-root",
          runRoot,
          "--json",
        );
      }
      const next = JSON.parse(
        (await run("next", "--run-root", runRoot, "--json")).stdout,
      ) as {
        pendingAction?: { type?: string; repair?: unknown };
        repair?: { disposition?: string };
      };
      expect(next).toMatchObject({
        repair: { disposition: "manual-stop" },
        pendingAction: { type: "ask_user" },
      });
      expect(next.pendingAction?.repair).toBeDefined();
      const decided = JSON.parse(
        (
          await run(
            "decide",
            "verify",
            JSON.stringify({
              choiceId: "stop",
              reviewer: {
                subject: "generated-reviewer",
                authorities: ["repair"],
              },
            }),
            "--run-root",
            runRoot,
            "--json",
          )
        ).stdout,
      ) as { disposition?: string; pendingAction?: unknown };
      expect(decided).toMatchObject({
        disposition: "blocked",
        pendingAction: null,
      });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("keeps repair episodes equivalent across manual and standalone locations", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "badger-workflow-repair-parity-"),
    );
    try {
      const runtime = createWorkflowRuntime();
      const manualRoot = path.join(root, "manual");
      const standalone = {
        kind: "standalone" as const,
        projectRoot: path.join(root, "standalone-project"),
        runId: "repair-parity-run",
      };
      let manual = await runtime.start({
        protocol: runtimeProtocol(runtimeProfile, "repair-parity-workflow"),
        runRoot: manualRoot,
        runId: standalone.runId,
      });
      let isolated = await runtime.start({
        protocol: runtimeProtocol(runtimeProfile, "repair-parity-workflow"),
        location: standalone,
      });
      expect(isolated).toEqual(manual);
      for (const summary of ["parity one", "parity two", "parity three"]) {
        manual = await runtime.submit(manualRoot, {
          actionId: manual.pendingAction!.id,
          runId: manual.runId,
          revision: manual.revision,
          nodeId: manual.currentNode,
          execution: manual.execution,
          status: "failed",
          summary,
        });
        isolated = await runtime.submit(standalone, {
          actionId: isolated.pendingAction!.id,
          runId: isolated.runId,
          revision: isolated.revision,
          nodeId: isolated.currentNode,
          execution: isolated.execution,
          status: "failed",
          summary,
        });
      }
      expect(isolated).toEqual(manual);
      expect(isolated).toMatchObject({
        disposition: "await-user",
        pendingAction: { type: "ask_user", repair: expect.any(Object) },
      });
      expect(isolated.repair?.history).toHaveLength(3);
      expect((await runtime.recover(standalone)).repair).toEqual(
        isolated.repair,
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("binds failures to stable failed-receipt coverage rather than receipt identity", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "badger-workflow-repair-receipts-"),
    );
    try {
      const runtime = createWorkflowRuntime();
      const protocol = runtimeProtocol(
        receiptRuntimeProfile,
        "repair-receipt-workflow",
        [
          {
            id: "verified",
            label: "Verification",
            validation: "semantic",
            verification: {
              role: "repair-check",
              kind: "automated-check",
            },
          },
        ],
      );
      let continuation = await runtime.start({
        protocol,
        runRoot: root,
        runId: "repair-receipt-run",
      });
      const failedReceipt = (summary: string) => ({
        actionId: continuation.pendingAction!.id,
        runId: continuation.runId,
        revision: continuation.revision,
        nodeId: continuation.currentNode,
        execution: continuation.execution,
        status: "failed" as const,
        summary,
        verification: {
          kind: "automated-check" as const,
          status: "failed" as const,
          verifierSubject: "repair-verifier",
          provider: "repair-provider",
          evidence: {
            summary,
            outputHash: packageHash,
            durationMs: 1,
            truncated: false,
          },
        },
      });
      continuation = await runtime.submit(
        root,
        failedReceipt("first receipt failure"),
      );
      const firstSignature = continuation.repair!.signature!.signatureHash;
      continuation = await runtime.submit(
        root,
        failedReceipt("same receipt failure, new prose"),
      );
      expect(continuation).toMatchObject({
        disposition: "continue",
        repair: {
          disposition: "warning",
          consecutiveFailures: 2,
        },
      });
      expect(continuation.repair?.signature?.signatureHash).toBe(
        firstSignature,
      );
      expect(continuation.verificationReceipts).toHaveLength(2);
      expect(continuation.verificationReceipts[0]?.receiptId).not.toBe(
        continuation.verificationReceipts[1]?.receiptId,
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("does not recover a state projection that erases committed repair history", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "badger-workflow-repair-history-"),
    );
    try {
      const runtime = createWorkflowRuntime();
      const started = await runtime.start({
        protocol: runtimeProtocol(runtimeProfile, "repair-history-workflow"),
        runRoot: root,
        runId: "repair-history-run",
      });
      await runtime.submit(root, {
        actionId: started.pendingAction!.id,
        runId: started.runId,
        revision: started.revision,
        nodeId: started.currentNode,
        execution: started.execution,
        status: "failed",
        summary: "The first failure is committed.",
      });
      const statePath = path.join(root, ".badger", "run-state.json");
      const state = JSON.parse(await fs.readFile(statePath, "utf8")) as {
        workflowRuntime: { repairEpisode: { history: unknown[] } };
      };
      state.workflowRuntime.repairEpisode.history = [];
      await fs.writeFile(
        statePath,
        `${JSON.stringify(state, null, 2)}\n`,
        "utf8",
      );
      await expect(runtime.recover(root)).rejects.toMatchObject({
        finding: { code: "state-invalid" },
      });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("keeps repair decision actions valid at verified checkpoint boundaries", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "badger-workflow-repair-checkpoint-"),
    );
    try {
      const runtime = createWorkflowRuntime();
      let continuation = await runtime.start({
        protocol: runtimeProtocol(
          checkpointRuntimeProfile,
          "repair-checkpoint-workflow",
        ),
        runRoot: root,
        runId: "repair-checkpoint-run",
      });
      for (let failure = 0; failure < 3; failure += 1) {
        continuation = await runtime.submit(root, {
          actionId: continuation.pendingAction!.id,
          runId: continuation.runId,
          revision: continuation.revision,
          nodeId: continuation.currentNode,
          execution: continuation.execution,
          status: "failed",
          summary: `checkpoint failure ${failure + 1}`,
        });
      }
      expect(continuation).toMatchObject({
        disposition: "await-user",
        pendingAction: { type: "ask_user", repair: expect.any(Object) },
      });
      expect((await runtime.recover(root)).pendingAction).toEqual(
        continuation.pendingAction,
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
