import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createWorkflowVerificationReceipt,
  parseWorkflowVerificationReceipt,
  workflowVerificationReceiptHash,
} from "../src/workflow-runtime/verification-receipts.js";
import {
  projectWorkflowHandoff,
  projectWorkflowState,
} from "../src/workflow-runtime/index.js";
import { createWorkflowRuntime } from "../src/workflow-runtime/public.js";
import { normalizeWorkflow } from "../src/workflow/contract.js";
import { generatePackage } from "../src/factory/generate.js";
import { readRunState } from "../src/engine/state.js";
import {
  readWorkflowVerificationReceipt,
  workflowVerificationReceiptPath,
} from "../src/workflow-runtime/verification-receipts.js";
import { createWorkflowContentSnapshotPolicy } from "../src/workflow-runtime/snapshots.js";
import {
  clearWorkflowTransitionFaultForTests,
  setWorkflowTransitionFaultForTests,
} from "../src/workflow-runtime/transition-journal.js";
import type {
  FactoryPlan,
  FactoryProposal,
  WorkflowInput,
  WorkflowProtocol,
} from "../src/types.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { WorkflowDurabilityProfile } from "../src/types.js";

const profile: WorkflowDurabilityProfile = {
  version: 1,
  capabilities: [
    "mutation-locks",
    "revision-fences",
    "transition-journal",
    "verification-receipts",
  ],
  bounds: {
    runStateBytes: 256 * 1024,
    pendingActionBytes: 256 * 1024,
    trajectoryBytes: 8 * 1024 * 1024,
    artifactsBytes: 1024 * 1024,
    claimBytes: 16 * 1024,
    transitionJournalBytes: 1024 * 1024,
    runLockBytes: 16 * 1024,
    verificationReceiptBytes: 256 * 1024,
    verificationReceiptCount: 8,
  },
  schemaVersions: {
    runState: 1,
    pendingAction: 1,
    trajectory: 1,
    artifacts: 1,
    revisionClaim: 1,
    transitionJournal: 1,
    runLock: 1,
    verificationReceipt: 1,
  },
  findingCatalogVersion: 1,
  verificationPolicy: {
    maxSummaryBytes: 1024,
    maxEvidenceBytes: 2048,
  },
};

const hash = "a".repeat(64);
const execution = {
  protocolHash: hash,
  packageHash: hash,
  snapshotHash: hash,
  nodeToStep: { check: "step-check" },
  capabilityVersion: 3 as const,
  resolverHash: hash,
  findingCatalogVersion: 1 as const,
  durabilityProfile: profile,
};
const execFileAsync = promisify(execFile);

describe("Workflow Verification Receipt contract", () => {
  it("creates a canonical runtime-issued receipt with bounded evidence", () => {
    const receipt = createWorkflowVerificationReceipt(
      {
        proposal: {
          kind: "automated-check",
          status: "passed",
          verifierSubject: "verifier",
          provider: "local-check",
          evidence: {
            summary: "checked /tmp/project with token=hidden",
            outputHash: hash,
            durationMs: 12,
            truncated: false,
          },
        },
        requirementId: "guardrail-check",
        role: "workflow-completion",
        runId: "receipt-run",
        revision: 0,
        actionId: "action-1",
        nodeId: "check",
        cycleId: null,
        attemptId: "attempt-1",
        execution,
        protocolHash: hash,
        packageHash: hash,
        snapshotHash: hash,
        scope: { artifacts: [], evidence: [] },
        contentSnapshotHash: null,
        now: new Date("2026-09-01T12:00:00.000Z"),
      },
      profile,
    );

    expect(receipt).toMatchObject({
      kind: "workflow-verification-receipt",
      receiptKind: "automated-check",
      status: "passed",
      requirementId: "guardrail-check",
      revision: 0,
      issuedAt: "2026-09-01T12:00:00.000Z",
      scopeHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
      evidenceHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
      receiptHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
      receiptId: expect.stringMatching(/^verification-receipt-[a-f0-9]{24}$/u),
      evidence: {
        summary: "checked [PATH] with token=[REDACTED]",
        truncated: false,
      },
    });
    expect(receipt.receiptHash).toBe(workflowVerificationReceiptHash(receipt));
    expect(parseWorkflowVerificationReceipt(receipt, profile)).toEqual(receipt);
  });

  it("redacts and truncates provider summaries before storage", () => {
    const boundedProfile: WorkflowDurabilityProfile = {
      ...structuredClone(profile),
      verificationPolicy: {
        maxSummaryBytes: 64,
        maxEvidenceBytes: 256,
      },
    };
    const receipt = createWorkflowVerificationReceipt(
      {
        proposal: {
          kind: "static-inspection",
          status: "passed",
          verifierSubject: "verifier",
          provider: "provider",
          evidence: {
            summary: `${"x".repeat(200)} token=hidden`,
            outputHash: hash,
            durationMs: 2,
            truncated: false,
          },
        },
        requirementId: "guardrail-check",
        role: "workflow-completion",
        runId: "receipt-run",
        revision: 0,
        actionId: "action-1",
        nodeId: "check",
        cycleId: null,
        attemptId: "attempt-1",
        execution,
        protocolHash: hash,
        packageHash: hash,
        snapshotHash: hash,
        scope: { artifacts: [], evidence: [] },
        contentSnapshotHash: null,
      },
      boundedProfile,
    );

    expect(
      Buffer.byteLength(receipt.evidence.summary, "utf8"),
    ).toBeLessThanOrEqual(64);
    expect(receipt.evidence.summary).not.toContain("token=hidden");
    expect(receipt.evidence.truncated).toBe(true);
    expect(parseWorkflowVerificationReceipt(receipt, boundedProfile)).toEqual(
      receipt,
    );
  });

  it("rejects non-canonical or unsupported receipt records", () => {
    const receipt = createWorkflowVerificationReceipt(
      {
        proposal: {
          kind: "manual-evidence",
          status: "passed",
          verifierSubject: "verifier",
          provider: "provider",
          evidence: {
            summary: "manual evidence",
            outputHash: hash,
            durationMs: 1,
            truncated: false,
          },
        },
        requirementId: "guardrail-check",
        role: "workflow-completion",
        runId: "receipt-run",
        revision: 0,
        actionId: "action-1",
        nodeId: "check",
        cycleId: null,
        attemptId: "attempt-1",
        execution,
        protocolHash: hash,
        packageHash: hash,
        snapshotHash: hash,
        scope: { artifacts: [], evidence: [] },
        contentSnapshotHash: null,
      },
      profile,
    );

    expect(() =>
      parseWorkflowVerificationReceipt(
        { ...receipt, unsupported: true },
        profile,
      ),
    ).toThrow("unknown field unsupported");
    expect(() =>
      parseWorkflowVerificationReceipt(
        { ...receipt, receiptHash: hash },
        profile,
      ),
    ).toThrow("receiptId is invalid");
  });

  it.each([
    ["automated-check", "passed"],
    ["static-inspection", "failed"],
    ["manual-evidence", "skipped"],
    ["manual-evidence", "blocked"],
  ] as const)("accepts %s receipts with %s status", (kind, status) => {
    const receipt = createWorkflowVerificationReceipt(
      {
        proposal: {
          kind,
          status,
          verifierSubject: "verifier",
          provider: "provider",
          evidence: {
            summary: "not passed",
            outputHash: hash,
            durationMs: 0,
            truncated: false,
          },
        },
        requirementId: "guardrail-check",
        role: "workflow-completion",
        runId: "receipt-run",
        revision: 0,
        actionId: "action-1",
        nodeId: "check",
        cycleId: null,
        attemptId: "attempt-1",
        execution,
        protocolHash: hash,
        packageHash: hash,
        snapshotHash: hash,
        scope: { artifacts: [], evidence: [] },
        contentSnapshotHash: null,
      },
      profile,
    );

    expect(receipt.receiptKind).toBe(kind);
    expect(receipt.status).toBe(status);
  });

  describe("public WorkflowRuntime enforcement", () => {
    let root: string;
    let runRoot: string;

    beforeEach(async () => {
      root = await fs.mkdtemp(
        path.join(os.tmpdir(), "badger-workflow-receipt-runtime-"),
      );
      runRoot = path.join(root, "run");
      await fs.mkdir(runRoot);
    });

    afterEach(async () => {
      clearWorkflowTransitionFaultForTests();
      await fs.rm(root, { recursive: true, force: true });
    });

    function node(
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

    function protocol(): WorkflowProtocol {
      const input: WorkflowInput = {
        kind: "workflow-kernel",
        name: "verification-receipt-workflow",
        goal: "Require a fresh verification receipt.",
        capabilities: {
          version: 3,
          features: ["conditional-routing", "revisioned-attempts"],
          durability: structuredClone(profile),
        },
        customNodes: [
          node("check", [
            {
              id: "verified",
              label: "Verification receipt",
              validation: "semantic",
              verification: {
                role: "workflow-check",
                kind: "automated-check",
              },
            },
          ]),
          node("finish"),
        ],
      };
      return normalizeWorkflow(input).protocol;
    }

    function snapshotProtocol(): WorkflowProtocol {
      const snapshotProfile: WorkflowDurabilityProfile = {
        ...structuredClone(profile),
        capabilities: [...profile.capabilities, "content-snapshots"],
        bounds: {
          ...profile.bounds,
        },
        schemaVersions: {
          ...profile.schemaVersions,
          contentSnapshot: 1,
        },
        snapshotPolicy: createWorkflowContentSnapshotPolicy({
          provider: "physical-tree",
          include: ["input.txt"],
        }),
      };
      const value = protocol();
      value.name = "verification-receipt-snapshot-workflow";
      value.capabilities = {
        ...value.capabilities!,
        features: [...value.capabilities!.features],
        durability: snapshotProfile,
      };
      const guardrail = value.nodes[0].guardrails[0];
      guardrail.verification = {
        ...guardrail.verification!,
        requireContentSnapshot: true,
      };
      return value;
    }

    function artifactProtocol(): WorkflowProtocol {
      const value = protocol();
      value.name = "verification-receipt-artifact-workflow";
      value.nodes[0].outputSchemas = ["check-output"];
      value.nodes[0].guardrails[0].verification = {
        ...value.nodes[0].guardrails[0].verification!,
        scope: {
          artifacts: [{ id: "check-output.result", required: true }],
        },
      };
      value.outputSchemas = [
        {
          id: "check-output",
          description: "Checked output.",
          artifacts: [
            {
              id: "result",
              kind: "file",
              required: true,
              paths: ["artifacts/result.txt"],
              validations: ["artifact-exists"],
              lifetime: "run",
            },
          ],
          evidence: [],
        },
      ];
      value.capabilities = {
        ...value.capabilities!,
        features: [...value.capabilities!.features, "versioned-artifacts"],
      };
      return value;
    }

    function decisionProtocol(): WorkflowProtocol {
      const value = protocol();
      value.name = "verification-receipt-decision-workflow";
      value.nodes[0].kind = "decision";
      value.nodes[0].decision = {
        id: "verification-review",
        question: "Is the verification acceptable?",
        choices: [{ id: "accept", label: "Accept", to: "finish" }],
      };
      value.edges = [{ from: "finish", to: null, condition: "success" }];
      return value;
    }

    it("requires and durably projects a passed receipt", async () => {
      const runtime = createWorkflowRuntime();
      const started = await runtime.start({
        protocol: protocol(),
        runRoot,
        runId: "receipt-runtime-run",
      });

      const blocked = await runtime.submit(runRoot, {
        actionId: started.pendingAction!.id,
        runId: started.runId,
        revision: started.revision,
        nodeId: started.currentNode,
        execution: started.execution,
        status: "succeeded",
        summary: "Check completed.",
      });
      expect(blocked.disposition).toBe("blocked");
      expect(
        blocked.findings.some(
          (finding) => finding.code === "verification-receipt-required",
        ),
      ).toBe(true);
      expect((await readRunState(runRoot))?.workflowRuntime?.revision).toBe(0);

      const advanced = await runtime.submit(runRoot, {
        actionId: started.pendingAction!.id,
        runId: started.runId,
        revision: started.revision,
        nodeId: started.currentNode,
        execution: started.execution,
        status: "succeeded",
        summary: "Check completed.",
        evidence: {
          verification: {
            evidence: { summary: "raw-provider-marker" },
          },
        },
        verification: {
          kind: "automated-check",
          status: "passed",
          verifierSubject: "test-verifier",
          provider: "test-provider",
          evidence: {
            summary: "bounded check summary",
            outputHash: hash,
            durationMs: 4,
            truncated: false,
          },
        },
      });

      expect(advanced.disposition).toBe("continue");
      expect(advanced.verificationReceipts).toHaveLength(1);
      expect(advanced.verificationReceipts[0]).toMatchObject({
        receiptKind: "automated-check",
        status: "passed",
        requirementId: "verified",
        role: "workflow-check",
        runId: "receipt-runtime-run",
        revision: 0,
      });
      const receipt = await readWorkflowVerificationReceipt(
        runRoot,
        advanced.verificationReceipts[0].receiptHash,
        profile,
      );
      expect(receipt?.evidence).toEqual({
        summary: "bounded check summary",
        outputHash: hash,
        durationMs: 4,
        truncated: false,
      });
      expect(JSON.stringify(advanced.visits)).not.toContain(
        "raw-provider-marker",
      );
      expect(
        (await projectWorkflowState(runRoot))?.verificationReceipts,
      ).toEqual(advanced.verificationReceipts);
      expect(
        (await projectWorkflowHandoff(protocol(), advanced))
          .verificationReceipts,
      ).toEqual(advanced.verificationReceipts);
      expect((await runtime.recover(runRoot)).verificationReceipts).toEqual(
        advanced.verificationReceipts,
      );
    });

    it("blocks receipt creation when the bound content snapshot drifts", async () => {
      const runtime = createWorkflowRuntime();
      const snapshotWorkflow = snapshotProtocol();
      await fs.writeFile(path.join(runRoot, "input.txt"), "initial\n", "utf8");
      const started = await runtime.start({
        protocol: snapshotWorkflow,
        runRoot,
        runId: "receipt-snapshot-run",
      });
      await fs.writeFile(path.join(runRoot, "input.txt"), "drift\n", "utf8");

      const blocked = await runtime.submit(runRoot, {
        actionId: started.pendingAction!.id,
        runId: started.runId,
        revision: started.revision,
        nodeId: started.currentNode,
        execution: started.execution,
        status: "succeeded",
        summary: "Check completed.",
        verification: {
          kind: "automated-check",
          status: "passed",
          verifierSubject: "test-verifier",
          provider: "test-provider",
          evidence: {
            summary: "bounded check summary",
            outputHash: hash,
            durationMs: 4,
            truncated: false,
          },
        },
      });

      expect(blocked.disposition).toBe("blocked");
      expect(blocked.findings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: "verification-receipt-stale" }),
        ]),
      );
      expect((await readRunState(runRoot))?.workflowRuntime?.revision).toBe(0);
      expect(blocked.verificationReceipts).toHaveLength(0);
    });

    it("binds a passed receipt to the exact accepted artifact version", async () => {
      const runtime = createWorkflowRuntime();
      const started = await runtime.start({
        protocol: artifactProtocol(),
        runRoot,
        runId: "receipt-artifact-run",
      });
      const artifactPath = path.join(runRoot, "artifacts", "result.txt");
      await fs.mkdir(path.dirname(artifactPath), { recursive: true });
      await fs.writeFile(artifactPath, "result\n", "utf8");

      const advanced = await runtime.submit(runRoot, {
        actionId: started.pendingAction!.id,
        runId: started.runId,
        revision: started.revision,
        nodeId: started.currentNode,
        execution: started.execution,
        status: "succeeded",
        summary: "Artifact checked.",
        artifacts: { result: "artifacts/result.txt" },
        verification: {
          kind: "automated-check",
          status: "passed",
          verifierSubject: "test-verifier",
          provider: "test-provider",
          evidence: {
            summary: "artifact checked",
            outputHash: hash,
            durationMs: 5,
            truncated: false,
          },
        },
      });

      expect(advanced.disposition).toBe("continue");
      expect(advanced.verificationReceipts[0]?.candidateArtifacts).toEqual([
        expect.objectContaining({
          artifactId: "check-output.result",
          versionId: expect.stringMatching(/^artifact-version-/u),
          contentHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
        }),
      ]);
      expect(advanced.verificationReceipts[0]?.scopeHash).toEqual(
        expect.stringMatching(/^[a-f0-9]{64}$/u),
      );
    });

    it.each(["failed", "skipped", "blocked"] as const)(
      "retains a %s receipt as audit evidence without treating it as a pass",
      async (status) => {
        const runtime = createWorkflowRuntime();
        const started = await runtime.start({
          protocol: protocol(),
          runRoot,
          runId: `receipt-${status}-run`,
        });

        const continued = await runtime.submit(runRoot, {
          actionId: started.pendingAction!.id,
          runId: started.runId,
          revision: started.revision,
          nodeId: started.currentNode,
          execution: started.execution,
          status: "failed",
          summary: "The check did not complete.",
          verification: {
            kind: "automated-check",
            status,
            verifierSubject: "test-verifier",
            provider: "test-provider",
            evidence: {
              summary: `check ${status}`,
              outputHash: hash,
              durationMs: 5,
              truncated: false,
            },
          },
        });

        expect(continued.verificationReceipts).toHaveLength(1);
        expect(continued.verificationReceipts[0]?.status).toBe(status);
        expect(continued.disposition).toBe("continue");
        expect(continued.pendingAction?.retryOrdinal).toBe(1);
      },
    );

    it("keeps Verification Receipts separate from a Decision Receipt", async () => {
      const runtime = createWorkflowRuntime();
      const started = await runtime.start({
        protocol: decisionProtocol(),
        runRoot,
        runId: "receipt-decision-run",
      });
      expect(started.disposition).toBe("await-user");

      const completedDecision = await runtime.submit(runRoot, {
        kind: "decision",
        actionId: started.pendingAction!.id,
        runId: started.runId,
        revision: started.revision,
        nodeId: started.currentNode!,
        cycleId: started.cycleId,
        attemptId: started.attemptId!,
        choiceId: "accept",
        reviewer: { subject: "reviewer", authorities: ["review"] },
        execution: started.execution,
        verification: {
          kind: "automated-check",
          status: "passed",
          verifierSubject: "reviewer",
          provider: "review-provider",
          evidence: {
            summary: "manual review recorded",
            outputHash: hash,
            durationMs: 9,
            truncated: false,
          },
        },
      });

      expect(completedDecision.verificationReceipts).toHaveLength(1);
      expect(completedDecision.decisionReceipts).toHaveLength(1);
      expect(
        completedDecision.decisionReceipts[0]?.verificationReceiptIds,
      ).toEqual([completedDecision.verificationReceipts[0]?.receiptId]);
    });

    it("keeps receipt behavior equivalent for manual and standalone Runs", async () => {
      const runtime = createWorkflowRuntime();
      const standalone = {
        kind: "standalone" as const,
        projectRoot: path.join(root, "standalone-project"),
        runId: "receipt-parity-run",
      };
      const manualStarted = await runtime.start({
        protocol: protocol(),
        runRoot,
        runId: standalone.runId,
      });
      const standaloneStarted = await runtime.start({
        protocol: protocol(),
        location: standalone,
      });
      expect(standaloneStarted).toEqual(manualStarted);

      const submit = (
        target: typeof runRoot | typeof standalone,
        started: typeof manualStarted,
      ) =>
        runtime.submit(target, {
          actionId: started.pendingAction!.id,
          runId: started.runId,
          revision: started.revision,
          nodeId: started.currentNode,
          execution: started.execution,
          status: "succeeded",
          summary: "Check completed.",
          verification: {
            kind: "automated-check" as const,
            status: "passed" as const,
            verifierSubject: "test-verifier",
            provider: "test-provider",
            evidence: {
              summary: "bounded check summary",
              outputHash: hash,
              durationMs: 4,
              truncated: false,
            },
          },
        });
      const [manual, standaloneResult] = await Promise.all([
        submit(runRoot, manualStarted),
        submit(standalone, standaloneStarted),
      ]);

      expect(
        standaloneResult.verificationReceipts.map(
          ({ issuedAt: _issuedAt, ...receipt }) => receipt,
        ),
      ).toEqual(
        manual.verificationReceipts.map(
          ({ issuedAt: _issuedAt, ...receipt }) => receipt,
        ),
      );
      expect(standaloneResult.verificationReceipts[0]?.receiptHash).toMatch(
        /^[a-f0-9]{64}$/u,
      );
    });

    it("recovers a receipt and Run state after an interrupted transition", async () => {
      const runtime = createWorkflowRuntime();
      const started = await runtime.start({
        protocol: protocol(),
        runRoot,
        runId: "receipt-recovery-run",
      });
      setWorkflowTransitionFaultForTests({ phase: "record-write" });

      await expect(
        runtime.submit(runRoot, {
          actionId: started.pendingAction!.id,
          runId: started.runId,
          revision: started.revision,
          nodeId: started.currentNode,
          execution: started.execution,
          status: "succeeded",
          summary: "Check completed.",
          verification: {
            kind: "automated-check",
            status: "passed",
            verifierSubject: "test-verifier",
            provider: "test-provider",
            evidence: {
              summary: "recoverable check",
              outputHash: hash,
              durationMs: 6,
              truncated: false,
            },
          },
        }),
      ).rejects.toThrow("deterministic workflow transition fault");
      clearWorkflowTransitionFaultForTests();

      const blocked = await runtime.resume(runRoot);
      expect(blocked.disposition).toBe("blocked");
      expect(blocked.findings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: "recovery-required" }),
        ]),
      );
      const runtimeBundle = path.resolve("assets/runtime/workflow-runtime.mjs");
      await execFileAsync(
        process.execPath,
        [
          "--input-type=module",
          "--eval",
          `const module = await import(${JSON.stringify(runtimeBundle)}); await module.createWorkflowRuntime().recover(${JSON.stringify(runRoot)});`,
        ],
        { cwd: root, env: process.env },
      );
      const recovered = await runtime.recover(runRoot);
      expect(recovered.disposition).toBe("continue");
      expect(recovered.revision).toBe(1);
      expect(recovered.verificationReceipts).toHaveLength(1);
      expect((await runtime.recover(runRoot)).verificationReceipts).toEqual(
        recovered.verificationReceipts,
      );
    });

    it("fails closed with a stable finding for missing or corrupt records", async () => {
      const runtime = createWorkflowRuntime();
      const started = await runtime.start({
        protocol: protocol(),
        runRoot,
        runId: "receipt-corrupt-run",
      });
      const advanced = await runtime.submit(runRoot, {
        actionId: started.pendingAction!.id,
        runId: started.runId,
        revision: started.revision,
        nodeId: started.currentNode,
        execution: started.execution,
        status: "succeeded",
        summary: "Check completed.",
        verification: {
          kind: "automated-check",
          status: "passed",
          verifierSubject: "test-verifier",
          provider: "test-provider",
          evidence: {
            summary: "corruption test",
            outputHash: hash,
            durationMs: 4,
            truncated: false,
          },
        },
      });
      const receiptPath = path.join(
        runRoot,
        workflowVerificationReceiptPath(
          advanced.verificationReceipts[0].receiptHash,
        ),
      );

      await fs.rm(receiptPath);
      try {
        await runtime.resume(runRoot);
        throw new Error("Expected missing receipt to fail");
      } catch (error) {
        expect((error as { finding?: { code?: string } }).finding?.code).toBe(
          "verification-receipt-invalid",
        );
      }

      await fs.writeFile(receiptPath, "{}\n", "utf8");
      try {
        await runtime.resume(runRoot);
        throw new Error("Expected corrupt receipt to fail");
      } catch (error) {
        expect((error as { finding?: { code?: string } }).finding?.code).toBe(
          "verification-receipt-invalid",
        );
      }
    });

    it("forwards verification proposals through a generated state adapter", async () => {
      const value = protocol();
      const generated = await generatePackage({
        destination: path.join(root, "generated-project", "generated"),
        projectRoot: root,
        plan: {
          schemaVersion: 1,
          goal: value.goal,
          skillCreatorIntent: "new-skill",
          skillSources: [],
          workflow: value as unknown as WorkflowInput,
          defaultLocale: "en",
        } satisfies FactoryPlan,
        proposal: {
          schemaVersion: 1,
          name: value.name,
          goal: value.goal,
          intent: "new-skill",
          planHash: hash,
          workflow: value,
          candidates: [],
          blockers: [],
          warnings: [],
          canInitialize: true,
        } satisfies FactoryProposal,
      });
      const projectRoot = path.dirname(generated.packageRoot);
      const stateScript = path.join(
        generated.packageRoot,
        "scripts",
        "workflow-state.mjs",
      );
      const run = (args: string[]) =>
        execFileAsync(process.execPath, [stateScript, ...args], {
          cwd: projectRoot,
          env: process.env,
        });
      const initializedResult = await run([
        "init",
        "--run-root",
        path.join(projectRoot, "run"),
        "--run-id",
        "generated-receipt-run",
        "--json",
      ]);
      const initialized = JSON.parse(initializedResult.stdout) as {
        pendingAction: { id: string };
        runId: string;
        revision: number;
        execution: unknown;
      };
      const recorded = JSON.parse(
        (
          await run([
            "record",
            "check",
            JSON.stringify({
              verification: {
                kind: "automated-check",
                status: "passed",
                verifierSubject: "generated-verifier",
                provider: "generated-provider",
                evidence: {
                  summary: "generated receipt",
                  outputHash: hash,
                  durationMs: 3,
                  truncated: false,
                },
              },
            }),
            "--run-root",
            path.join(projectRoot, "run"),
            "--json",
          ])
        ).stdout,
      ) as {
        verificationReceipts: Array<{ receiptKind: string; status: string }>;
      };

      expect(initialized.pendingAction.id).toBeTruthy();
      expect(recorded.verificationReceipts).toEqual([
        expect.objectContaining({
          receiptKind: "automated-check",
          status: "passed",
        }),
      ]);
    });
  });
});
