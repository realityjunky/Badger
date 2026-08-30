import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalizeWorkflow } from "../src/workflow/contract.js";
import { generatePackage } from "../src/factory/generate.js";
import { createWorkflowRuntime } from "../src/workflow-runtime/public.js";
import { projectWorkflowState } from "../src/workflow-runtime/index.js";
import { readRunState } from "../src/engine/state.js";
import type { WorkflowInput, WorkflowProtocol } from "../src/types.js";
import type { WorkflowDecisionSubmission } from "../src/workflow-runtime/types.js";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function machineNode(id: string): WorkflowInput["customNodes"][number] {
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

function decisionProtocol(): WorkflowProtocol {
  const input: WorkflowInput = {
    kind: "workflow-kernel",
    name: "decision-workflow",
    goal: "Run one reviewed decision.",
    capabilities: {
      version: 3,
      features: ["conditional-routing", "revisioned-attempts"],
    },
    customNodes: [
      machineNode("start"),
      {
        id: "review",
        label: "Review release",
        kind: "decision",
        responsibility: "Choose whether the release proceeds.",
        implementation: {
          skill: "review-skill",
          operation: "default",
          scope: "main",
        },
        operations: ["require", "augment", "disable"],
        outputSchemas: [],
        guardrails: [],
        decision: {
          id: "release-decision",
          question: "Should this release proceed?",
          choices: [
            { id: "approve", label: "Approve", to: "approved" },
            { id: "reject", label: "Reject", to: "rejected" },
          ],
          inputs: {
            type: "object",
            fields: [
              {
                id: "ticket",
                type: "string",
                required: true,
              },
            ],
          },
          rationale: { required: true },
          reviewer: {
            subjects: ["reviewer-alice"],
            authorities: ["release:approve"],
          },
        },
      },
      machineNode("approved"),
      machineNode("rejected"),
    ],
    routing: {
      transitions: [
        { from: "start", to: "review", condition: "success" },
        { from: "approved", to: null, condition: "success" },
        { from: "rejected", to: null, condition: "success" },
      ],
    },
  };
  return normalizeWorkflow(input).protocol;
}

function decisionResponse(
  continuation: Awaited<
    ReturnType<ReturnType<typeof createWorkflowRuntime>["start"]>
  >,
  overrides: Partial<WorkflowDecisionSubmission> = {},
): WorkflowDecisionSubmission {
  return {
    kind: "decision",
    actionId: continuation.pendingAction!.id,
    revision: continuation.revision,
    nodeId: continuation.currentNode!,
    cycleId: continuation.cycleId,
    attemptId: continuation.attemptId!,
    choiceId: "approve",
    reviewer: {
      subject: "reviewer-alice",
      authorities: ["release:approve"],
    },
    inputs: { ticket: "REL-25" },
    rationale: "The release checks are complete.",
    ...overrides,
  };
}

describe("WorkflowRuntime decision Nodes", () => {
  let root: string;
  let runRoot: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "comet-workflow-decision-"));
    runRoot = path.join(root, "change");
    await fs.mkdir(runRoot, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("waits at a durable decision and recovers the same response contract", async () => {
    const runtime = createWorkflowRuntime();
    const started = await runtime.start({
      protocol: decisionProtocol(),
      runRoot,
      runId: "decision-run",
    });
    const awaiting = await runtime.submit(runRoot, {
      actionId: started.pendingAction!.id,
      nodeId: "start",
      status: "succeeded",
      summary: "Ready for review.",
    });
    expect(awaiting).toMatchObject({
      disposition: "await-user",
      revision: 1,
      currentNode: "review",
      pendingAction: {
        type: "ask_user",
        decisionId: "release-decision",
        question: "Should this release proceed?",
        choices: [
          { id: "approve", label: "Approve" },
          { id: "reject", label: "Reject" },
        ],
        requiredInputs: {
          type: "object",
          fields: [{ id: "ticket", type: "string", required: true }],
        },
        rationale: { required: true },
        reviewer: {
          subjects: ["reviewer-alice"],
          authorities: ["release:approve"],
        },
      },
    });
    expect(await runtime.recover(runRoot)).toEqual(awaiting);
  });

  it("routes one valid choice and records one identity-bound receipt", async () => {
    const runtime = createWorkflowRuntime();
    const started = await runtime.start({
      protocol: decisionProtocol(),
      runRoot,
      runId: "receipt-run",
    });
    const awaiting = await runtime.submit(runRoot, {
      actionId: started.pendingAction!.id,
      nodeId: "start",
      status: "succeeded",
      summary: "Ready for review.",
    });
    const completed = await runtime.submit(runRoot, {
      kind: "decision",
      actionId: awaiting.pendingAction!.id,
      revision: awaiting.revision,
      nodeId: "review",
      cycleId: awaiting.cycleId,
      attemptId: awaiting.attemptId!,
      choiceId: "approve",
      reviewer: {
        subject: "reviewer-alice",
        authorities: ["release:approve"],
      },
      inputs: { ticket: "REL-25" },
      rationale: "The release checks are complete.",
    });

    expect(completed).toMatchObject({
      disposition: "continue",
      revision: 2,
      currentNode: "approved",
    });
    const state = await readRunState(runRoot);
    expect(state?.workflowRuntime?.decisionReceipts).toHaveLength(1);
    expect(state?.workflowRuntime?.decisionReceipts?.[0]).toMatchObject({
      runId: "receipt-run",
      revision: 1,
      actionId: awaiting.pendingAction!.id,
      decisionId: "release-decision",
      nodeId: "review",
      attemptId: awaiting.attemptId,
      choiceId: "approve",
      reviewer: {
        subject: "reviewer-alice",
        authorities: ["release:approve"],
      },
      inputs: { ticket: "REL-25" },
      rationale: "The release checks are complete.",
      protocolHash: awaiting.execution.protocolHash,
      packageHash: awaiting.execution.packageHash,
    });
    expect(state?.workflowRuntime?.decisionReceipts?.[0].timestamp).toEqual(
      expect.any(String),
    );
    expect(
      (await projectWorkflowState(runRoot))?.decisionReceipts,
    ).toHaveLength(1);
  });

  it.each([
    ["stale revision", { revision: 0 }, "Decision response revision"],
    ["wrong Node", { nodeId: "start" }, "Submission Node does not match"],
    ["wrong Attempt", { attemptId: "other-attempt" }, "Decision Attempt"],
    ["wrong Cycle", { cycleId: "other-cycle" }, "Decision Cycle"],
    [
      "unknown choice",
      { choiceId: "unknown" },
      "Decision choice is not declared",
    ],
    ["missing input", { inputs: {} }, "Missing required decision input"],
    [
      "missing rationale",
      { rationale: undefined },
      "Decision rationale is required",
    ],
    [
      "wrong reviewer subject",
      {
        reviewer: { subject: "reviewer-bob", authorities: ["release:approve"] },
      },
      "Decision reviewer subject is not authorized",
    ],
    [
      "missing reviewer authority",
      {
        reviewer: { subject: "reviewer-alice", authorities: ["release:view"] },
      },
      "Decision reviewer lacks authority",
    ],
  ])(
    "rejects %s before mutating the awaiting Run",
    async (_label, overrides, message) => {
      const runtime = createWorkflowRuntime();
      const started = await runtime.start({
        protocol: decisionProtocol(),
        runRoot,
        runId: `invalid-${String(_label).replaceAll(" ", "-")}`,
      });
      const awaiting = await runtime.submit(runRoot, {
        actionId: started.pendingAction!.id,
        nodeId: "start",
        status: "succeeded",
        summary: "Ready for review.",
      });
      const stateBefore = await readRunState(runRoot);
      const trajectoryBefore = await fs.readFile(
        path.join(runRoot, stateBefore!.trajectoryRef),
        "utf8",
      );

      await expect(
        runtime.submit(runRoot, decisionResponse(awaiting, overrides)),
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

  it("rejects generic machine success for a decision and decision responses for machine work", async () => {
    const runtime = createWorkflowRuntime();
    const started = await runtime.start({
      protocol: decisionProtocol(),
      runRoot,
      runId: "cross-kind-run",
    });
    const awaiting = await runtime.submit(runRoot, {
      actionId: started.pendingAction!.id,
      nodeId: "start",
      status: "succeeded",
      summary: "Ready for review.",
    });
    const stateBefore = await readRunState(runRoot);

    await expect(
      runtime.submit(runRoot, {
        actionId: awaiting.pendingAction!.id,
        nodeId: "review",
        status: "succeeded",
        summary: "Bypass.",
      }),
    ).rejects.toThrow("Decision response required");
    expect(await readRunState(runRoot)).toEqual(stateBefore);

    const approved = await runtime.submit(runRoot, decisionResponse(awaiting));
    const stateAfterDecision = await readRunState(runRoot);
    await expect(
      runtime.submit(
        runRoot,
        decisionResponse(approved, {
          actionId: approved.pendingAction!.id,
          revision: approved.revision,
          nodeId: "approved",
          attemptId: approved.attemptId!,
          cycleId: approved.cycleId,
        }),
      ),
    ).rejects.toThrow("Decision response cannot satisfy invoke_skill action");
    expect(await readRunState(runRoot)).toEqual(stateAfterDecision);
  });

  it("rejects an exact replay without creating another receipt", async () => {
    const runtime = createWorkflowRuntime();
    const started = await runtime.start({
      protocol: decisionProtocol(),
      runRoot,
      runId: "replay-run",
    });
    const awaiting = await runtime.submit(runRoot, {
      actionId: started.pendingAction!.id,
      nodeId: "start",
      status: "succeeded",
      summary: "Ready for review.",
    });
    const response = decisionResponse(awaiting);
    await runtime.submit(runRoot, response);
    const stateBefore = await readRunState(runRoot);
    await expect(runtime.submit(runRoot, response)).rejects.toThrow(
      "Outcome does not match pending action",
    );
    const stateAfter = await readRunState(runRoot);
    expect(stateAfter?.workflowRuntime?.decisionReceipts).toHaveLength(1);
    expect(stateAfter).toEqual(stateBefore);
  });

  it("accepts optional rationale and enumerated scalar inputs", async () => {
    const protocol = decisionProtocol();
    const decision = protocol.nodes.find(
      (node) => node.id === "review",
    )!.decision!;
    decision.rationale = undefined;
    decision.reviewer = undefined;
    decision.inputs!.fields[0].enum = ["REL-25", "REL-26"];
    const runtime = createWorkflowRuntime();
    const started = await runtime.start({
      protocol,
      runRoot,
      runId: "optional-decision-run",
    });
    const awaiting = await runtime.submit(runRoot, {
      actionId: started.pendingAction!.id,
      nodeId: "start",
      status: "succeeded",
      summary: "Ready for review.",
    });

    expect(awaiting.pendingAction).toMatchObject({
      rationale: { required: false },
      reviewer: { subjects: [], authorities: [] },
      requiredInputs: {
        fields: [{ id: "ticket", enum: ["REL-25", "REL-26"] }],
      },
    });
    const next = await runtime.submit(
      runRoot,
      decisionResponse(awaiting, {
        inputs: { ticket: "REL-26" },
        rationale: undefined,
        reviewer: {
          subject: "reviewer-any",
          authorities: ["release:review"],
        },
      }),
    );
    expect(next.currentNode).toBe("approved");
  });

  it("allows a declared decision choice to terminate the Run", async () => {
    const protocol = decisionProtocol();
    protocol.nodes.find((node) => node.id === "rejected")!.optional = true;
    protocol.nodes.find(
      (node) => node.id === "review",
    )!.decision!.choices[1].to = null;
    const runtime = createWorkflowRuntime();
    const started = await runtime.start({
      protocol,
      runRoot,
      runId: "terminal-decision-run",
    });
    const awaiting = await runtime.submit(runRoot, {
      actionId: started.pendingAction!.id,
      nodeId: "start",
      status: "succeeded",
      summary: "Ready for review.",
    });
    const completed = await runtime.submit(
      runRoot,
      decisionResponse(awaiting, { choiceId: "reject" }),
    );
    expect(completed).toMatchObject({
      disposition: "done",
      currentNode: null,
      revision: 2,
    });
  });

  it("keeps manual and standalone decision continuations equivalent", async () => {
    const runtime = createWorkflowRuntime();
    const runId = "decision-location-run";
    const manualLocation = {
      kind: "manual" as const,
      runRoot: path.join(root, "manual"),
    };
    const standaloneLocation = {
      kind: "standalone" as const,
      projectRoot: path.join(root, "standalone"),
      runId,
    };
    const protocol = decisionProtocol();
    const manualStarted = await runtime.start({
      protocol,
      location: manualLocation,
      runId,
    });
    const standaloneStarted = await runtime.start({
      protocol: structuredClone(protocol),
      location: standaloneLocation,
    });
    expect(standaloneStarted).toEqual(manualStarted);

    const manualAwaiting = await runtime.submit(manualLocation, {
      actionId: manualStarted.pendingAction!.id,
      nodeId: "start",
      status: "succeeded",
      summary: "Ready for review.",
    });
    const standaloneAwaiting = await runtime.submit(standaloneLocation, {
      actionId: standaloneStarted.pendingAction!.id,
      nodeId: "start",
      status: "succeeded",
      summary: "Ready for review.",
    });
    expect(standaloneAwaiting).toEqual(manualAwaiting);

    const manualNext = await runtime.submit(
      manualLocation,
      decisionResponse(manualAwaiting),
    );
    const standaloneNext = await runtime.submit(
      standaloneLocation,
      decisionResponse(standaloneAwaiting),
    );
    expect(standaloneNext).toMatchObject({
      disposition: manualNext.disposition,
      revision: manualNext.revision,
      currentNode: manualNext.currentNode,
      attemptId: manualNext.attemptId,
      decisionReceipts: [
        {
          ...manualNext.decisionReceipts[0],
          timestamp: expect.any(String),
        },
      ],
    });
  });

  it("renders and submits decisions through generated adapters", async () => {
    const projectRoot = path.join(root, "generated-project");
    const protocol = decisionProtocol();
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
    const guardScript = path.join(
      generated.packageRoot,
      "scripts",
      "workflow-guard.mjs",
    );
    const handoffScript = path.join(
      generated.packageRoot,
      "scripts",
      "workflow-handoff.mjs",
    );
    const run = (script: string, args: string[]) =>
      execFileAsync(process.execPath, [script, ...args], {
        cwd: projectRoot,
        env: process.env,
      });
    const generatedRunRoot = path.join(projectRoot, "run");

    await run(stateScript, [
      "init",
      "--run-root",
      generatedRunRoot,
      "--run-id",
      "generated-decision-run",
    ]);
    await run(stateScript, [
      "record",
      "start",
      '{"summary":"Ready for review."}',
      "--run-root",
      generatedRunRoot,
    ]);
    const next = JSON.parse(
      (
        await run(stateScript, [
          "next",
          "--run-root",
          generatedRunRoot,
          "--json",
        ])
      ).stdout,
    ) as { pendingAction: { type: string; question: string } };
    expect(next.pendingAction).toMatchObject({
      type: "ask_user",
      question: "Should this release proceed?",
    });
    const decided = JSON.parse(
      (
        await run(stateScript, [
          "decide",
          "review",
          JSON.stringify({
            choiceId: "approve",
            reviewer: {
              subject: "reviewer-alice",
              authorities: ["release:approve"],
            },
            inputs: { ticket: "REL-25" },
            rationale: "The release checks are complete.",
          }),
          "--run-root",
          generatedRunRoot,
          "--json",
        ])
      ).stdout,
    ) as { currentNode: string; revision: number };
    expect(decided).toMatchObject({ currentNode: "approved", revision: 2 });
    await run(guardScript, [
      "entry",
      "approved",
      "--run-root",
      generatedRunRoot,
    ]);
    const handoff = JSON.parse(
      (await run(handoffScript, ["--run-root", generatedRunRoot, "--json"]))
        .stdout,
    ) as { continuation: { decisionReceipts: unknown[] } };
    expect(handoff.continuation.decisionReceipts).toHaveLength(1);

    const guardedRunRoot = path.join(projectRoot, "guarded-run");
    await run(stateScript, [
      "init",
      "--run-root",
      guardedRunRoot,
      "--run-id",
      "guarded-decision-run",
    ]);
    await run(stateScript, [
      "record",
      "start",
      '{"summary":"Ready for review."}',
      "--run-root",
      guardedRunRoot,
    ]);
    const guardedDecision = JSON.parse(
      (
        await run(guardScript, [
          "decision",
          "review",
          JSON.stringify({
            choiceId: "approve",
            reviewer: {
              subject: "reviewer-alice",
              authorities: ["release:approve"],
            },
            inputs: { ticket: "REL-25" },
            rationale: "The release checks are complete.",
          }),
          "--run-root",
          guardedRunRoot,
          "--apply",
          "--json",
        ])
      ).stdout,
    ) as { currentNode: string; revision: number };
    expect(guardedDecision).toMatchObject({
      currentNode: "approved",
      revision: 2,
    });

    for (const adapter of [stateScript, guardScript, handoffScript]) {
      const source = await fs.readFile(adapter, "utf8");
      expect(source).not.toContain("resolveWorkflowNext");
      expect(source).not.toContain("reviewer-policy");
      expect(source).not.toContain("decisionReceipts.push");
    }
  });

  it.each([
    [
      "hidden decision on machine Node",
      (protocol: WorkflowProtocol) => {
        protocol.nodes[0].decision = structuredClone(
          protocol.nodes[1].decision,
        );
      },
      "not a decision Node",
    ],
    [
      "duplicate choice mapping",
      (protocol: WorkflowProtocol) => {
        protocol.nodes[1].decision!.choices[1].to = "approved";
      },
      "duplicate choice mapping",
    ],
    [
      "unknown decision target",
      (protocol: WorkflowProtocol) => {
        protocol.nodes[1].decision!.choices[0].to = "missing";
      },
      "references unknown Node",
    ],
    [
      "executable input validator",
      (protocol: WorkflowProtocol) => {
        (
          protocol.nodes[1].decision!.inputs!.fields[0] as Record<
            string,
            unknown
          >
        ).validate = "return true";
      },
      "unsupported field: validate",
    ],
  ])("rejects %s before creating a Run", async (_label, mutate, message) => {
    const protocol = decisionProtocol();
    mutate(protocol);
    await expect(
      createWorkflowRuntime().start({
        protocol,
        runRoot,
        runId: "invalid-definition",
      }),
    ).rejects.toThrow(message);
    await expect(fs.access(path.join(runRoot, ".comet"))).rejects.toMatchObject(
      {
        code: "ENOENT",
      },
    );
  });
});
