import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalizeWorkflow } from "../src/workflow/contract.js";
import { generatePackage } from "../src/factory/generate.js";
import { createWorkflowRuntime } from "../src/workflow-runtime/public.js";
import {
  projectWorkflowHandoff,
  projectWorkflowState,
} from "../src/workflow-runtime/index.js";
import { readRunState } from "../src/engine/state.js";
import {
  readPendingAction,
  writePendingAction,
} from "../src/engine/run-store.js";
import type { WorkflowInput, WorkflowProtocol } from "../src/types.js";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function machineNode(
  id: string,
  outputSchemas: string[] = [],
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
    outputSchemas,
    guardrails: [],
  };
}

function scopedDecisionProtocol(): WorkflowProtocol {
  const input: WorkflowInput = {
    kind: "workflow-kernel",
    name: "decision-scope-workflow",
    goal: "Review immutable evidence scope.",
    capabilities: {
      version: 3,
      features: [
        "conditional-routing",
        "revisioned-attempts",
        "versioned-artifacts",
      ],
    },
    customNodes: [
      machineNode("produce", ["review-output"]),
      {
        id: "review",
        label: "Review evidence",
        kind: "decision",
        responsibility: "Accept or reject the reviewed evidence.",
        implementation: {
          skill: "review-skill",
          operation: "default",
          scope: "main",
        },
        operations: ["require", "augment", "disable"],
        outputSchemas: [],
        guardrails: [],
        decision: {
          id: "evidence-review",
          question: "Should the evidence be accepted?",
          choices: [{ id: "accept", label: "Accept", to: "done" }],
          reviewer: { authorities: ["evidence:review"] },
          scope: {
            artifacts: [{ id: "review-output.report", required: true }],
            evidence: [{ id: "review-output.basis", required: true }],
          },
        },
      },
      machineNode("done"),
    ],
    outputSchemas: [
      {
        id: "review-output",
        description: "Evidence presented for review.",
        artifacts: [
          {
            id: "report",
            kind: "file",
            required: true,
            paths: ["artifacts/report.txt"],
            validations: ["artifact-exists"],
            lifetime: "run",
          },
        ],
        evidence: [{ id: "basis", required: true }],
      },
    ],
    routing: {
      transitions: [
        { from: "produce", to: "review", condition: "success" },
        { from: "done", to: null, condition: "success" },
      ],
    },
  };
  return normalizeWorkflow(input).protocol;
}

function scopedCycleProtocol(): WorkflowProtocol {
  const protocol = scopedDecisionProtocol();
  protocol.name = "scoped-cycle-workflow";
  const finish = machineNode("finish");
  protocol.nodes.push({
    ...finish,
    implementation: { ...finish.implementation, enforcement: "guarded" },
    requiredSkillCalls: [],
    augmentations: [],
    satisfies: [],
    disabled: false,
  });
  const decision = protocol.nodes.find(
    (node) => node.id === "review",
  )!.decision!;
  decision.choices = [
    {
      id: "repeat",
      label: "Repeat",
      to: "done",
      routing: { next: "repeat" },
    },
    {
      id: "finish",
      label: "Finish",
      to: "finish",
      routing: { next: "finish" },
    },
  ];
  protocol.edges = [
    { from: "produce", to: "review", condition: "success" },
    {
      from: "done",
      to: "produce",
      condition: "success",
      when: { field: "next", equals: "repeat" },
    },
    {
      from: "done",
      to: "finish",
      condition: "success",
      when: { field: "next", equals: "finish" },
    },
    { from: "finish", to: null, condition: "success" },
  ];
  protocol.routing = {
    fields: [{ id: "next", values: ["repeat", "finish"] }],
    transitions: structuredClone(protocol.edges),
  };
  protocol.cycles = [
    {
      key: "review-cycle",
      entry: "produce",
      repeatTransitions: [{ from: "done", to: "produce" }],
      maxInstances: 2,
    },
  ];
  protocol.capabilities!.features.push("bounded-cycles");
  return protocol;
}

function initialScopedDecisionProtocol(): WorkflowProtocol {
  const input: WorkflowInput = {
    kind: "workflow-kernel",
    name: "initial-scoped-decision-workflow",
    goal: "Start with a bounded decision.",
    capabilities: {
      version: 3,
      features: ["conditional-routing", "revisioned-attempts"],
    },
    customNodes: [
      {
        id: "review",
        label: "Review",
        kind: "decision",
        responsibility: "Make the initial review decision.",
        implementation: {
          skill: "review-skill",
          operation: "default",
          scope: "main",
        },
        operations: ["require", "augment", "disable"],
        outputSchemas: ["review-output"],
        guardrails: [],
        decision: {
          id: "initial-review",
          question: "Proceed?",
          choices: [{ id: "proceed", label: "Proceed", to: "done" }],
          scope: {
            evidence: [{ id: "review-output.basis", required: false }],
          },
        },
      },
      machineNode("done"),
    ],
    outputSchemas: [
      {
        id: "review-output",
        description: "Optional review evidence.",
        artifacts: [],
        evidence: [{ id: "basis", required: false }],
      },
    ],
    routing: {
      transitions: [{ from: "done", to: null, condition: "success" }],
    },
  };
  return normalizeWorkflow(input).protocol;
}

describe("WorkflowRuntime decision evidence scope", () => {
  let root: string;
  let runRoot: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "comet-workflow-scope-"));
    runRoot = path.join(root, "run");
    await fs.mkdir(runRoot, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("captures bounded artifact and evidence references for a pending decision", async () => {
    const runtime = createWorkflowRuntime();
    const reportPath = path.join(runRoot, "artifacts", "report.txt");
    await fs.mkdir(path.dirname(reportPath), { recursive: true });
    await fs.writeFile(reportPath, "synthetic report\n", "utf8");

    const started = await runtime.start({
      protocol: scopedDecisionProtocol(),
      runRoot,
      runId: "scope-run",
    });
    const awaiting = await runtime.submit(runRoot, {
      actionId: started.pendingAction!.id,
      nodeId: "produce",
      status: "succeeded",
      summary: "Evidence is ready.",
      artifacts: { report: "artifacts/report.txt" },
      evidence: { basis: { source: "synthetic report" } },
    });

    expect(awaiting).toMatchObject({
      disposition: "await-user",
      currentNode: "review",
      pendingAction: {
        scope: {
          artifacts: [
            {
              id: "review-output.report",
              required: true,
              versionId: expect.stringMatching(/^artifact-version-/u),
              contentHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
              producer: {
                runId: "scope-run",
                nodeId: "produce",
                cycleId: null,
                attemptId: expect.any(String),
                actionId: started.pendingAction!.id,
                revision: 0,
              },
            },
          ],
          evidence: [
            {
              id: "review-output.basis",
              required: true,
              versionId: expect.stringMatching(/^evidence-version-/u),
              contentHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
              producer: {
                runId: "scope-run",
                nodeId: "produce",
                cycleId: null,
                attemptId: expect.any(String),
                actionId: started.pendingAction!.id,
                revision: 0,
              },
            },
          ],
        },
      },
    });
    expect(JSON.stringify(awaiting.pendingAction!.scope)).not.toContain(
      "synthetic report",
    );
    expect(JSON.stringify(awaiting)).not.toContain("synthetic report");
    expect(JSON.stringify(await projectWorkflowState(runRoot))).not.toContain(
      "synthetic report",
    );
    expect(
      JSON.stringify(
        await projectWorkflowHandoff(scopedDecisionProtocol(), awaiting),
      ),
    ).not.toContain("synthetic report");
    expect(await runtime.recover(runRoot)).toEqual(awaiting);

    const completed = await runtime.submit(runRoot, {
      kind: "decision",
      actionId: awaiting.pendingAction!.id,
      revision: awaiting.revision,
      nodeId: "review",
      cycleId: awaiting.cycleId,
      attemptId: awaiting.attemptId!,
      choiceId: "accept",
      reviewer: {
        subject: "reviewer",
        authorities: ["evidence:review"],
      },
      execution: awaiting.execution,
      scope: {
        artifacts: awaiting.pendingAction!.scope!.artifacts.map(
          ({ id, versionId, contentHash }) => ({ id, versionId, contentHash }),
        ),
        evidence: awaiting.pendingAction!.scope!.evidence.map(
          ({ id, versionId, contentHash }) => ({ id, versionId, contentHash }),
        ),
      },
    });

    expect(completed.decisionReceipts[0]).toMatchObject({
      runId: "scope-run",
      scope: awaiting.pendingAction!.scope,
    });
  });

  it.each([
    [
      "scope hash",
      (
        awaiting: Awaited<
          ReturnType<ReturnType<typeof createWorkflowRuntime>["start"]>
        >,
      ) => {
        const scope = structuredClone(awaiting.pendingAction!.scope!);
        scope.artifacts[0].contentHash = "0".repeat(64);
        return { scope };
      },
      "pending scope",
    ],
    [
      "execution identity",
      (
        awaiting: Awaited<
          ReturnType<ReturnType<typeof createWorkflowRuntime>["start"]>
        >,
      ) => ({
        execution: {
          ...awaiting.execution,
          packageHash: "0".repeat(64),
        },
      }),
      "execution identity",
    ],
  ])(
    "rejects altered %s before mutating the awaiting Run",
    async (_label, overrides, message) => {
      const runtime = createWorkflowRuntime();
      const reportPath = path.join(runRoot, "artifacts", "report.txt");
      await fs.mkdir(path.dirname(reportPath), { recursive: true });
      await fs.writeFile(reportPath, "synthetic report\n", "utf8");
      const started = await runtime.start({
        protocol: scopedDecisionProtocol(),
        runRoot,
        runId: "invalid-scope-run",
      });
      const awaiting = await runtime.submit(runRoot, {
        actionId: started.pendingAction!.id,
        nodeId: "produce",
        status: "succeeded",
        summary: "Evidence is ready.",
        artifacts: { report: "artifacts/report.txt" },
        evidence: { basis: { source: "synthetic report" } },
      });
      const stateBefore = await readRunState(runRoot);
      const trajectoryBefore = await fs.readFile(
        path.join(runRoot, stateBefore!.trajectoryRef),
        "utf8",
      );
      await expect(
        runtime.submit(runRoot, {
          kind: "decision",
          actionId: awaiting.pendingAction!.id,
          revision: awaiting.revision,
          nodeId: "review",
          cycleId: awaiting.cycleId,
          attemptId: awaiting.attemptId!,
          choiceId: "accept",
          reviewer: {
            subject: "reviewer",
            authorities: ["evidence:review"],
          },
          execution: awaiting.execution,
          scope: awaiting.pendingAction!.scope,
          ...overrides(awaiting),
        }),
      ).rejects.toThrow(message);
      expect(await readRunState(runRoot)).toEqual(stateBefore);
      expect(
        await fs.readFile(
          path.join(runRoot, stateBefore!.trajectoryRef),
          "utf8",
        ),
      ).toBe(trajectoryBefore);
    },
  );

  it("rejects physical artifact drift before accepting the decision", async () => {
    const runtime = createWorkflowRuntime();
    const reportPath = path.join(runRoot, "artifacts", "report.txt");
    await fs.mkdir(path.dirname(reportPath), { recursive: true });
    await fs.writeFile(reportPath, "synthetic report\n", "utf8");
    const started = await runtime.start({
      protocol: scopedDecisionProtocol(),
      runRoot,
      runId: "drift-run",
    });
    const awaiting = await runtime.submit(runRoot, {
      actionId: started.pendingAction!.id,
      nodeId: "produce",
      status: "succeeded",
      summary: "Evidence is ready.",
      artifacts: { report: "artifacts/report.txt" },
      evidence: { basis: { source: "synthetic report" } },
    });
    const stateBefore = await readRunState(runRoot);
    await fs.writeFile(reportPath, "changed report\n", "utf8");

    await expect(
      runtime.submit(runRoot, {
        kind: "decision",
        actionId: awaiting.pendingAction!.id,
        revision: awaiting.revision,
        nodeId: "review",
        cycleId: awaiting.cycleId,
        attemptId: awaiting.attemptId!,
        choiceId: "accept",
        reviewer: {
          subject: "reviewer",
          authorities: ["evidence:review"],
        },
        execution: awaiting.execution,
        scope: awaiting.pendingAction!.scope,
      }),
    ).rejects.toThrow("content drift");
    expect(await readRunState(runRoot)).toEqual(stateBefore);
  });

  it("rejects scope references copied from another Run", async () => {
    const runtime = createWorkflowRuntime();
    const firstRoot = runRoot;
    const secondRoot = path.join(root, "second-run");
    await fs.mkdir(secondRoot, { recursive: true });
    for (const [currentRoot, runId] of [
      [firstRoot, "first-scope-run"],
      [secondRoot, "second-scope-run"],
    ] as const) {
      const reportPath = path.join(currentRoot, "artifacts", "report.txt");
      await fs.mkdir(path.dirname(reportPath), { recursive: true });
      await fs.writeFile(reportPath, "synthetic report\n", "utf8");
      const started = await runtime.start({
        protocol: scopedDecisionProtocol(),
        runRoot: currentRoot,
        runId,
      });
      await runtime.submit(currentRoot, {
        actionId: started.pendingAction!.id,
        nodeId: "produce",
        status: "succeeded",
        summary: "Evidence is ready.",
        artifacts: { report: "artifacts/report.txt" },
        evidence: { basis: { source: "synthetic report" } },
      });
    }
    const first = await runtime.recover(firstRoot);
    const second = await runtime.recover(secondRoot);
    const stateBefore = await readRunState(firstRoot);
    await expect(
      runtime.submit(firstRoot, {
        kind: "decision",
        actionId: first.pendingAction!.id,
        revision: first.revision,
        nodeId: "review",
        cycleId: first.cycleId,
        attemptId: first.attemptId!,
        choiceId: "accept",
        reviewer: {
          subject: "reviewer",
          authorities: ["evidence:review"],
        },
        execution: first.execution,
        scope: second.pendingAction!.scope,
      }),
    ).rejects.toThrow("pending scope");
    expect(await readRunState(firstRoot)).toEqual(stateBefore);
  });

  it("allows optional captured references to be omitted from the response", async () => {
    const protocol = scopedDecisionProtocol();
    protocol.outputSchemas[0].evidence.push({
      id: "optional-basis",
      required: false,
    });
    protocol.nodes.find((node) => node.id === "review")!.decision!.scope = {
      artifacts: [{ id: "review-output.report", required: false }],
      evidence: [{ id: "review-output.optional-basis", required: false }],
    };
    const runtime = createWorkflowRuntime();
    const reportPath = path.join(runRoot, "artifacts", "report.txt");
    await fs.mkdir(path.dirname(reportPath), { recursive: true });
    await fs.writeFile(reportPath, "synthetic report\n", "utf8");
    const started = await runtime.start({
      protocol,
      runRoot,
      runId: "optional-scope-run",
    });
    const awaiting = await runtime.submit(runRoot, {
      actionId: started.pendingAction!.id,
      nodeId: "produce",
      status: "succeeded",
      summary: "Evidence is ready.",
      artifacts: { report: "artifacts/report.txt" },
      evidence: { basis: { source: "synthetic report" } },
    });
    expect(awaiting.pendingAction!.scope).toMatchObject({
      artifacts: [{ id: "review-output.report", required: false }],
      evidence: [],
    });
    const completed = await runtime.submit(runRoot, {
      kind: "decision",
      actionId: awaiting.pendingAction!.id,
      revision: awaiting.revision,
      nodeId: "review",
      cycleId: awaiting.cycleId,
      attemptId: awaiting.attemptId!,
      choiceId: "accept",
      reviewer: {
        subject: "reviewer",
        authorities: ["evidence:review"],
      },
      execution: awaiting.execution,
    });
    expect(completed.decisionReceipts[0].scope?.artifacts).toHaveLength(1);
  });

  it("accepts evidenceReferences only when they select pending evidence versions", async () => {
    const protocol = scopedDecisionProtocol();
    protocol.nodes.find((node) => node.id === "review")!.decision!.scope = {
      artifacts: [{ id: "review-output.report", required: false }],
      evidence: [{ id: "review-output.basis", required: true }],
    };
    const runtime = createWorkflowRuntime();
    const reportPath = path.join(runRoot, "artifacts", "report.txt");
    await fs.mkdir(path.dirname(reportPath), { recursive: true });
    await fs.writeFile(reportPath, "synthetic report\n", "utf8");
    const started = await runtime.start({
      protocol,
      runRoot,
      runId: "evidence-reference-run",
    });
    const awaiting = await runtime.submit(runRoot, {
      actionId: started.pendingAction!.id,
      nodeId: "produce",
      status: "succeeded",
      summary: "Evidence is ready.",
      artifacts: { report: "artifacts/report.txt" },
      evidence: { basis: { source: "synthetic report" } },
    });
    const evidenceReference = awaiting.pendingAction!.scope!.evidence[0];
    const completed = await runtime.submit(runRoot, {
      kind: "decision",
      actionId: awaiting.pendingAction!.id,
      revision: awaiting.revision,
      nodeId: "review",
      cycleId: awaiting.cycleId,
      attemptId: awaiting.attemptId!,
      choiceId: "accept",
      reviewer: {
        subject: "reviewer",
        authorities: ["evidence:review"],
      },
      execution: awaiting.execution,
      evidenceReferences: [evidenceReference.versionId],
    });
    expect(completed.currentNode).toBe("done");
  });

  it("produces equivalent scope references for manual and standalone Runs", async () => {
    const runtime = createWorkflowRuntime();
    const manual = {
      kind: "manual" as const,
      runRoot: path.join(root, "manual"),
    };
    const standalone = {
      kind: "standalone" as const,
      projectRoot: path.join(root, "standalone"),
      runId: "location-scope-run",
    };
    for (const location of [manual, standalone]) {
      const locationRoot =
        location.kind === "manual"
          ? location.runRoot
          : path.join(location.projectRoot, ".comet", "runs", location.runId);
      const reportPath = path.join(locationRoot, "artifacts", "report.txt");
      await fs.mkdir(path.dirname(reportPath), { recursive: true });
      await fs.writeFile(reportPath, "synthetic report\n", "utf8");
    }
    const manualStarted = await runtime.start({
      protocol: scopedDecisionProtocol(),
      location: manual,
      runId: "location-scope-run",
    });
    const standaloneStarted = await runtime.start({
      protocol: scopedDecisionProtocol(),
      location: standalone,
    });
    const submitProducer = async (
      location: typeof manual | typeof standalone,
      started: typeof manualStarted,
    ) =>
      runtime.submit(location, {
        actionId: started.pendingAction!.id,
        nodeId: "produce",
        status: "succeeded",
        summary: "Evidence is ready.",
        artifacts: { report: "artifacts/report.txt" },
        evidence: { basis: { source: "synthetic report" } },
      });
    const manualAwaiting = await submitProducer(manual, manualStarted);
    const standaloneAwaiting = await submitProducer(
      standalone,
      standaloneStarted,
    );
    expect(standaloneAwaiting.execution).toEqual(manualAwaiting.execution);
    expect(standaloneAwaiting.pendingAction!.scope).toEqual(
      manualAwaiting.pendingAction!.scope,
    );
  });

  it("rejects undeclared scope attachments without changing the Run", async () => {
    const runtime = createWorkflowRuntime();
    const reportPath = path.join(runRoot, "artifacts", "report.txt");
    await fs.mkdir(path.dirname(reportPath), { recursive: true });
    await fs.writeFile(reportPath, "synthetic report\n", "utf8");
    const started = await runtime.start({
      protocol: scopedDecisionProtocol(),
      runRoot,
      runId: "undeclared-scope-run",
    });
    const awaiting = await runtime.submit(runRoot, {
      actionId: started.pendingAction!.id,
      nodeId: "produce",
      status: "succeeded",
      summary: "Evidence is ready.",
      artifacts: { report: "artifacts/report.txt" },
      evidence: { basis: { source: "synthetic report" } },
    });
    const stateBefore = await readRunState(runRoot);
    const scope = structuredClone(awaiting.pendingAction!.scope!);
    scope.evidence.push({
      id: "review-output.undeclared",
      required: false,
      versionId: "uploaded-bytes",
      contentHash: "0".repeat(64),
      producer: scope.artifacts[0].producer,
    });
    await expect(
      runtime.submit(runRoot, {
        kind: "decision",
        actionId: awaiting.pendingAction!.id,
        revision: awaiting.revision,
        nodeId: "review",
        cycleId: awaiting.cycleId,
        attemptId: awaiting.attemptId!,
        choiceId: "accept",
        reviewer: {
          subject: "reviewer",
          authorities: ["evidence:review"],
        },
        execution: awaiting.execution,
        scope,
      }),
    ).rejects.toThrow("not pending");
    expect(await readRunState(runRoot)).toEqual(stateBefore);
  });

  it("blocks creation when a required scope version is unavailable", async () => {
    const protocol = scopedDecisionProtocol();
    protocol.nodes.find((node) => node.id === "review")!.decision!.scope = {
      artifacts: [{ id: "review-output.report", required: true }],
      evidence: [],
    };
    protocol.nodes.find((node) => node.id === "produce")!.outputSchemas = [];
    const runtime = createWorkflowRuntime();
    const started = await runtime.start({
      protocol,
      runRoot,
      runId: "missing-scope-run",
    });
    const blocked = await runtime.submit(runRoot, {
      actionId: started.pendingAction!.id,
      nodeId: "produce",
      status: "succeeded",
      summary: "No scoped output was produced.",
    });
    expect(blocked).toMatchObject({
      disposition: "blocked",
      currentNode: "review",
      blockers: [expect.stringContaining("scope is unavailable")],
      pendingAction: null,
    });
  });

  it("does not carry an Attempt artifact into the decision Attempt", async () => {
    const protocol = scopedDecisionProtocol();
    protocol.outputSchemas[0].artifacts[0].lifetime = "attempt";
    protocol.outputSchemas[0].artifacts[0].paths = ["artifacts/*/report.txt"];
    const runtime = createWorkflowRuntime();
    const started = await runtime.start({
      protocol,
      runRoot,
      runId: "attempt-scope-run",
    });
    const reportPath = path.join(
      runRoot,
      "artifacts",
      started.attemptId!,
      "report.txt",
    );
    await fs.mkdir(path.dirname(reportPath), { recursive: true });
    await fs.writeFile(reportPath, "attempt report\n", "utf8");
    const blocked = await runtime.submit(runRoot, {
      actionId: started.pendingAction!.id,
      nodeId: "produce",
      status: "succeeded",
      summary: "Attempt evidence is ready.",
      artifacts: {
        report: `artifacts/${started.attemptId!}/report.txt`,
      },
      evidence: { basis: { source: "attempt report" } },
    });
    expect(blocked).toMatchObject({
      disposition: "blocked",
      blockers: [expect.stringContaining("scope is unavailable")],
    });
  });

  it("rejects evidence content drift before accepting the decision", async () => {
    const runtime = createWorkflowRuntime();
    const reportPath = path.join(runRoot, "artifacts", "report.txt");
    await fs.mkdir(path.dirname(reportPath), { recursive: true });
    await fs.writeFile(reportPath, "synthetic report\n", "utf8");
    const started = await runtime.start({
      protocol: scopedDecisionProtocol(),
      runRoot,
      runId: "evidence-drift-run",
    });
    const awaiting = await runtime.submit(runRoot, {
      actionId: started.pendingAction!.id,
      nodeId: "produce",
      status: "succeeded",
      summary: "Evidence is ready.",
      artifacts: { report: "artifacts/report.txt" },
      evidence: { basis: { source: "synthetic report" } },
    });
    const state = await readRunState(runRoot);
    state!.workflowRuntime!.visits[0].outcomes[0].evidence = {
      basis: { source: "tampered evidence" },
    };
    await import("../src/engine/state.js").then(({ writeRunState }) =>
      writeRunState(runRoot, state!),
    );

    await expect(runtime.recover(runRoot)).rejects.toThrow(
      "Decision evidence scope is stale",
    );
    expect((await readRunState(runRoot))?.pending).toBe(
      awaiting.pendingAction!.id,
    );
  });

  it("requires execution identity for every decision response", async () => {
    const protocol = scopedDecisionProtocol();
    protocol.nodes.find((node) => node.id === "review")!.decision!.scope =
      undefined;
    const runtime = createWorkflowRuntime();
    const reportPath = path.join(runRoot, "artifacts", "report.txt");
    await fs.mkdir(path.dirname(reportPath), { recursive: true });
    await fs.writeFile(reportPath, "synthetic report\n", "utf8");
    const started = await runtime.start({
      protocol,
      runRoot,
      runId: "identity-required-run",
    });
    const awaiting = await runtime.submit(runRoot, {
      actionId: started.pendingAction!.id,
      nodeId: "produce",
      status: "succeeded",
      summary: "Evidence is ready.",
      artifacts: { report: "artifacts/report.txt" },
      evidence: { basis: { source: "synthetic report" } },
    });
    const response = {
      kind: "decision" as const,
      actionId: awaiting.pendingAction!.id,
      revision: awaiting.revision,
      nodeId: "review",
      cycleId: awaiting.cycleId,
      attemptId: awaiting.attemptId!,
      choiceId: "accept",
      reviewer: { subject: "reviewer", authorities: ["evidence:review"] },
    };
    await expect(runtime.submit(runRoot, response)).rejects.toThrow(
      "execution identity is required",
    );
    const completed = await runtime.submit(runRoot, {
      ...response,
      execution: awaiting.execution,
    });
    expect(completed.currentNode).toBe("done");
  });

  it("rejects unknown decision submission fields", async () => {
    const runtime = createWorkflowRuntime();
    const started = await runtime.start({
      protocol: scopedDecisionProtocol(),
      runRoot,
      runId: "unknown-field-run",
    });
    const awaiting = await runtime.submit(runRoot, {
      actionId: started.pendingAction!.id,
      nodeId: "produce",
      status: "succeeded",
      summary: "Evidence is ready.",
      artifacts: { report: "artifacts/report.txt" },
      evidence: { basis: { source: "synthetic report" } },
    });
    const response = {
      kind: "decision" as const,
      actionId: awaiting.pendingAction!.id,
      revision: awaiting.revision,
      nodeId: "review",
      cycleId: awaiting.cycleId,
      attemptId: awaiting.attemptId!,
      choiceId: "accept",
      reviewer: { subject: "reviewer", authorities: ["evidence:review"] },
      execution: awaiting.execution,
      attachments: ["uploaded-bytes"],
    } as unknown as Parameters<
      ReturnType<typeof createWorkflowRuntime>["submit"]
    >[1];
    await expect(runtime.submit(runRoot, response)).rejects.toThrow(
      "unknown field: attachments",
    );
  });

  it("rejects a pending decision whose captured scope was removed", async () => {
    const runtime = createWorkflowRuntime();
    const reportPath = path.join(runRoot, "artifacts", "report.txt");
    await fs.mkdir(path.dirname(reportPath), { recursive: true });
    await fs.writeFile(reportPath, "synthetic report\n", "utf8");
    const started = await runtime.start({
      protocol: scopedDecisionProtocol(),
      runRoot,
      runId: "missing-persisted-scope-run",
    });
    const awaiting = await runtime.submit(runRoot, {
      actionId: started.pendingAction!.id,
      nodeId: "produce",
      status: "succeeded",
      summary: "Evidence is ready.",
      artifacts: { report: "artifacts/report.txt" },
      evidence: { basis: { source: "synthetic report" } },
    });
    const state = await readRunState(runRoot);
    const pending = await readPendingAction(runRoot, state!.pendingRef);
    delete pending!.scope;
    await writePendingAction(runRoot, state!.pendingRef, pending!);
    await expect(runtime.recover(runRoot)).rejects.toThrow(
      "missing its captured scope",
    );
    expect((await readRunState(runRoot))?.pending).toBe(
      awaiting.pendingAction!.id,
    );
  });

  it("captures optional initial decision scope in both locations", async () => {
    const runtime = createWorkflowRuntime();
    const manual = {
      kind: "manual" as const,
      runRoot: path.join(root, "initial-manual"),
    };
    const standalone = {
      kind: "standalone" as const,
      projectRoot: path.join(root, "initial-standalone"),
      runId: "initial-scope-run",
    };
    const manualStarted = await runtime.start({
      protocol: initialScopedDecisionProtocol(),
      location: manual,
      runId: standalone.runId,
    });
    const standaloneStarted = await runtime.start({
      protocol: initialScopedDecisionProtocol(),
      location: standalone,
    });
    expect(standaloneStarted.pendingAction!.scope).toEqual(
      manualStarted.pendingAction!.scope,
    );
    expect(manualStarted.pendingAction!.scope).toEqual({
      artifacts: [],
      evidence: [],
    });
  });

  it.each([
    [
      "unknown scope id",
      (protocol: WorkflowProtocol) => {
        protocol.nodes.find(
          (node) => node.id === "review",
        )!.decision!.scope!.evidence![0].id = "review-output.missing";
      },
      "is not declared",
    ],
    [
      "duplicate scope id",
      (protocol: WorkflowProtocol) => {
        protocol.nodes
          .find((node) => node.id === "review")!
          .decision!.scope!.evidence!.push({
            id: "review-output.basis",
            required: false,
          });
      },
      "has duplicate entry",
    ],
  ])("rejects %s before creating a Run", async (_label, mutate, message) => {
    const protocol = scopedDecisionProtocol();
    mutate(protocol);
    await expect(
      createWorkflowRuntime().start({
        protocol,
        runRoot,
        runId: "invalid-definition-run",
      }),
    ).rejects.toThrow(message);
    await expect(fs.access(path.join(runRoot, ".comet"))).rejects.toMatchObject(
      { code: "ENOENT" },
    );
  });

  it("renders and forwards scope through generated adapters", async () => {
    const protocol = scopedDecisionProtocol();
    const projectRoot = path.join(root, "generated-project");
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
        preferredSkills: [],
        workflow: protocol as unknown as WorkflowInput,
        defaultLocale: "en",
      },
      destination: path.join(projectRoot, "generated"),
    });
    const stateScript = path.join(
      generated.packageRoot,
      "scripts",
      "workflow-state.mjs",
    );
    const handoffScript = path.join(
      generated.packageRoot,
      "scripts",
      "workflow-handoff.mjs",
    );
    const runRoot = path.join(projectRoot, "run");
    const run = (script: string, args: string[]) =>
      execFileAsync(process.execPath, [script, ...args], {
        cwd: projectRoot,
        env: process.env,
      });
    const reportPath = path.join(runRoot, "artifacts", "report.txt");
    await fs.mkdir(path.dirname(reportPath), { recursive: true });
    await fs.writeFile(reportPath, "synthetic report\n", "utf8");

    await run(stateScript, [
      "init",
      "--run-root",
      runRoot,
      "--run-id",
      "generated-scope-run",
    ]);
    await run(stateScript, [
      "record",
      "produce",
      JSON.stringify({
        summary: "Evidence is ready.",
        artifacts: { report: "artifacts/report.txt" },
        basis: { source: "synthetic report" },
      }),
      "--run-root",
      runRoot,
    ]);
    const awaiting = JSON.parse(
      (await run(stateScript, ["next", "--run-root", runRoot, "--json"]))
        .stdout,
    ) as {
      pendingAction: { scope: unknown; type: string };
      execution: unknown;
    };
    expect(awaiting.pendingAction).toMatchObject({
      type: "ask_user",
      scope: {
        artifacts: [{ id: "review-output.report" }],
        evidence: [{ id: "review-output.basis" }],
      },
    });
    const decided = JSON.parse(
      (
        await run(stateScript, [
          "decide",
          "review",
          JSON.stringify({
            choiceId: "accept",
            reviewer: {
              subject: "generated-reviewer",
              authorities: ["evidence:review"],
            },
            scope: awaiting.pendingAction.scope,
          }),
          "--run-root",
          runRoot,
          "--json",
        ])
      ).stdout,
    ) as { currentNode: string; revision: number };
    expect(decided).toMatchObject({ currentNode: "done", revision: 2 });
    const handoff = JSON.parse(
      (await run(handoffScript, ["--run-root", runRoot, "--json"])).stdout,
    ) as { continuation: { decisionReceipts: Array<{ scope: unknown }> } };
    expect(handoff.continuation.decisionReceipts[0].scope).toEqual(
      awaiting.pendingAction.scope,
    );
  });

  it("keeps an earlier receipt valid after a later Cycle creates new scope", async () => {
    const runtime = createWorkflowRuntime();
    const protocol = scopedCycleProtocol();
    const writeReport = async (content: string) => {
      const reportPath = path.join(runRoot, "artifacts", "report.txt");
      await fs.mkdir(path.dirname(reportPath), { recursive: true });
      await fs.writeFile(reportPath, content, "utf8");
    };
    await writeReport("first cycle report\n");
    let current = await runtime.start({
      protocol,
      runRoot,
      runId: "scoped-cycle-run",
    });
    current = await runtime.submit(runRoot, {
      actionId: current.pendingAction!.id,
      nodeId: "produce",
      status: "succeeded",
      summary: "First cycle evidence is ready.",
      artifacts: { report: "artifacts/report.txt" },
      evidence: { basis: { source: "first cycle" } },
    });
    const firstAwaiting = current;
    current = await runtime.submit(runRoot, {
      kind: "decision",
      actionId: current.pendingAction!.id,
      revision: current.revision,
      nodeId: "review",
      cycleId: current.cycleId,
      attemptId: current.attemptId!,
      choiceId: "repeat",
      reviewer: {
        subject: "reviewer",
        authorities: ["evidence:review"],
      },
      execution: current.execution,
      scope: current.pendingAction!.scope,
    });
    const firstReceipt = current.decisionReceipts[0];
    current = await runtime.submit(runRoot, {
      actionId: current.pendingAction!.id,
      nodeId: "done",
      status: "succeeded",
      summary: "Repeating the cycle.",
      routing: { next: "repeat" },
    });
    await writeReport("second cycle report\n");
    current = await runtime.submit(runRoot, {
      actionId: current.pendingAction!.id,
      nodeId: "produce",
      status: "succeeded",
      summary: "Second cycle evidence is ready.",
      artifacts: { report: "artifacts/report.txt" },
      evidence: { basis: { source: "second cycle" } },
    });
    expect(current).toMatchObject({
      disposition: "await-user",
      cycleId: expect.not.stringMatching(firstAwaiting.cycleId!),
      pendingAction: { scope: { evidence: [{ id: "review-output.basis" }] } },
    });
    expect(current.decisionReceipts).toHaveLength(1);
    expect((await runtime.recover(runRoot)).decisionReceipts).toHaveLength(1);
    current = await runtime.submit(runRoot, {
      kind: "decision",
      actionId: current.pendingAction!.id,
      revision: current.revision,
      nodeId: "review",
      cycleId: current.cycleId,
      attemptId: current.attemptId!,
      choiceId: "finish",
      reviewer: {
        subject: "reviewer",
        authorities: ["evidence:review"],
      },
      execution: current.execution,
      scope: current.pendingAction!.scope,
    });
    current = await runtime.submit(runRoot, {
      actionId: current.pendingAction!.id,
      nodeId: "finish",
      status: "succeeded",
      summary: "Finished after the reviewed cycles.",
    });
    expect(current.disposition).toBe("done");
    expect(current.decisionReceipts[0]).toEqual(firstReceipt);
    expect((await runtime.recover(runRoot))?.decisionReceipts[0]).toEqual(
      firstReceipt,
    );
  });
});
