import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalizeWorkflow } from "../src/workflow/contract.js";
import { createWorkflowRuntime } from "../src/workflow-runtime/index.js";
import { readRunState } from "../src/engine/state.js";
import {
  readArtifacts,
  readPendingAction,
  readTrajectory,
} from "../src/engine/run-store.js";
import type { WorkflowInput, WorkflowProtocol } from "../src/types.js";

function workflowInput(
  nodes: WorkflowInput["customNodes"],
  outputSchemas: WorkflowInput["outputSchemas"] = [],
): WorkflowInput {
  return {
    kind: "workflow-kernel",
    name: "demo-workflow",
    goal: "Run the demo workflow.",
    customNodes: nodes,
    outputSchemas,
  };
}

function outputSchema(
  id: string,
  artifactPath: string,
  evidenceId = "summary",
): NonNullable<WorkflowInput["outputSchemas"]>[number] {
  return {
    id,
    description: `${id} output.`,
    artifacts: [
      {
        id: "result",
        kind: "file",
        required: true,
        paths: [artifactPath],
        validations: ["artifact-exists"],
      },
    ],
    evidence: [{ id: evidenceId, required: true }],
  };
}

function node(
  id: string,
  options: Partial<WorkflowInput["customNodes"][number]> = {},
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
    guardrails: [],
    ...options,
  };
}

describe("WorkflowRuntime", () => {
  let root: string;
  let runRoot: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "comet-workflow-runtime-"));
    runRoot = path.join(root, "change");
    await fs.mkdir(runRoot, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("starts and resumes a persisted linear Node action", async () => {
    const input = workflowInput([node("prepare")]);
    const protocol = normalizeWorkflow(input).protocol;
    const runtime = createWorkflowRuntime();

    const started = await runtime.start({
      protocol,
      runRoot,
      runId: "demo-run",
    });

    expect(started).toMatchObject({
      disposition: "continue",
      runId: "demo-run",
      currentNode: "prepare",
      pendingAction: {
        type: "invoke_skill",
        ref: "demo-workflow-prepare",
        stepId: expect.any(String),
      },
    });
    expect((await readRunState(runRoot))?.runtimeIdentity).toEqual(
      started.execution,
    );

    const resumed = await runtime.resume(runRoot);

    expect(resumed).toEqual(started);
  });

  it("submits successful outcomes across a linear workflow to terminal completion", async () => {
    const protocol = normalizeWorkflow(
      workflowInput([node("prepare"), node("finish")]),
    ).protocol;
    const runtime = createWorkflowRuntime();

    const started = await runtime.start({
      protocol,
      runRoot,
      runId: "submit-run",
    });

    const second = await runtime.submit(runRoot, {
      actionId: started.pendingAction!.id,
      nodeId: "prepare",
      status: "succeeded",
      summary: "Prepared the workflow input.",
    });

    expect(second).toMatchObject({
      disposition: "continue",
      runId: "submit-run",
      currentNode: "finish",
      pendingAction: {
        type: "invoke_skill",
        ref: "demo-workflow-finish",
        stepId: "node-2-finish",
      },
    });

    const completed = await runtime.submit(runRoot, {
      actionId: second.pendingAction!.id,
      nodeId: "finish",
      status: "succeeded",
      summary: "Finished the workflow.",
    });

    expect(completed).toMatchObject({
      disposition: "done",
      runId: "submit-run",
      currentNode: null,
      pendingAction: null,
    });
    const completedState = await readRunState(runRoot);
    expect(
      (await readTrajectory(runRoot, completedState!.trajectoryRef))
        .filter((event) => event.type === "action_proposed")
        .map((event) => (event.data.action as { stepId: string }).stepId),
    ).toEqual(["node-1-prepare", "node-2-finish"]);
  });

  it("blocks incomplete success and repairs the same pending action", async () => {
    const protocol = normalizeWorkflow(
      workflowInput(
        [
          node("prepare", {
            requiredSkillCalls: [
              {
                skill: "support-skill",
                operation: "require",
                scope: "main",
              },
            ],
            augmentations: [
              {
                skill: "mandatory-augmentation",
                operation: "augment",
                scope: "main",
                enforcement: "evidence-only",
              },
              {
                skill: "advisory-augmentation",
                operation: "augment",
                scope: "main",
                enforcement: "advisory",
              },
            ],
            outputSchemas: ["prepare.v1"],
            guardrails: [
              {
                id: "prepare-guardrail",
                label: "Preparation is safe.",
                validation: "evidence-only",
              },
            ],
          }),
        ],
        [outputSchema("prepare.v1", "prepare.txt")],
      ),
    ).protocol;
    const runtime = createWorkflowRuntime();
    const started = await runtime.start({
      protocol,
      runRoot,
      runId: "repair-run",
    });
    const beforeState = await readRunState(runRoot);
    const beforePending = started.pendingAction;

    const blocked = await runtime.submit(runRoot, {
      actionId: beforePending!.id,
      nodeId: "prepare",
      status: "succeeded",
      summary: "Preparation attempted.",
    });

    expect(blocked).toMatchObject({
      disposition: "blocked",
      currentNode: "prepare",
      pendingAction: beforePending,
    });
    expect(blocked.blockers).toEqual(
      expect.arrayContaining([
        "Missing Output Schema evidence: prepare.v1.summary",
        "Missing Output Schema artifacts: prepare.v1.result",
        "Missing required Skill evidence: required-skill:prepare.support-skill",
        "Missing augmentation evidence: augmentation:prepare.mandatory-augmentation",
        "Missing guardrail evidence: guardrail:prepare.prepare-guardrail",
      ]),
    );
    expect(blocked.blockers).not.toContain(
      "Missing augmentation evidence: augmentation:prepare.advisory-augmentation",
    );
    expect(await readRunState(runRoot)).toEqual(beforeState);
    expect(await readPendingAction(runRoot, beforeState!.pendingRef)).toEqual(
      beforePending,
    );

    await fs.writeFile(path.join(runRoot, "prepare.txt"), "prepared\n");
    const repaired = await runtime.submit(runRoot, {
      actionId: beforePending!.id,
      nodeId: "prepare",
      status: "succeeded",
      summary: "Preparation repaired.",
      evidence: {
        summary: "prepared",
        completedChecks: [
          "required-skill:prepare.support-skill",
          "augmentation:prepare.mandatory-augmentation",
          "guardrail:prepare.prepare-guardrail",
        ],
      },
    });

    expect(repaired).toMatchObject({
      disposition: "done",
      currentNode: null,
      pendingAction: null,
    });
    expect(
      (await readTrajectory(runRoot, beforeState!.trajectoryRef)).filter(
        (event) => event.type === "action_proposed",
      ),
    ).toHaveLength(1);
  });

  it("delegates failed outcomes to Engine retry behavior without completion validation", async () => {
    const protocol = normalizeWorkflow(
      workflowInput(
        [node("prepare", { outputSchemas: ["prepare.v1"] })],
        [outputSchema("prepare.v1", "prepare.txt")],
      ),
    ).protocol;
    const runtime = createWorkflowRuntime();
    const started = await runtime.start({
      protocol,
      runRoot,
      runId: "failure-run",
    });

    const retried = await runtime.submit(runRoot, {
      actionId: started.pendingAction!.id,
      nodeId: "prepare",
      status: "failed",
      summary: "Preparation failed transiently.",
    });

    expect(retried).toMatchObject({
      disposition: "continue",
      currentNode: "prepare",
      pendingAction: started.pendingAction,
      blockers: [],
    });
    expect((await readRunState(runRoot))?.retries).toEqual({
      [started.pendingAction!.id]: 1,
    });
  });

  it("returns a blocked continuation when Engine retries are exhausted", async () => {
    const normalized = normalizeWorkflow(workflowInput([node("prepare")]));
    const runtime = createWorkflowRuntime();
    const started = await runtime.start({
      protocol: normalized.protocol,
      runRoot,
      runId: "retry-limit-run",
    });

    let continuation = started;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      continuation = await runtime.submit(runRoot, {
        actionId: started.pendingAction!.id,
        nodeId: "prepare",
        status: "failed",
        summary: `Attempt ${attempt + 1} failed.`,
      });
    }

    expect(continuation).toMatchObject({
      disposition: "blocked",
      currentNode: "prepare",
      pendingAction: null,
    });
    expect(continuation.blockers[0]).toContain("Retry budget exhausted");
  });

  it("rejects stale, unrelated, duplicate, and terminal submissions", async () => {
    const protocol = normalizeWorkflow(
      workflowInput([node("prepare"), node("finish")]),
    ).protocol;
    const runtime = createWorkflowRuntime();
    const started = await runtime.start({
      protocol,
      runRoot,
      runId: "rejection-run",
    });

    await expect(
      runtime.submit(runRoot, {
        actionId: "stale-action",
        nodeId: "prepare",
        status: "succeeded",
        summary: "Stale.",
      }),
    ).rejects.toThrow("Outcome does not match pending action: stale-action");
    await expect(
      runtime.submit(runRoot, {
        actionId: started.pendingAction!.id,
        nodeId: "finish",
        status: "succeeded",
        summary: "Out of order.",
      }),
    ).rejects.toThrow("Submission Node does not match pending Node: finish");
    expect(await runtime.resume(runRoot)).toEqual(started);

    const second = await runtime.submit(runRoot, {
      actionId: started.pendingAction!.id,
      nodeId: "prepare",
      status: "succeeded",
      summary: "Prepared.",
    });
    await expect(
      runtime.submit(runRoot, {
        actionId: started.pendingAction!.id,
        nodeId: "prepare",
        status: "succeeded",
        summary: "Duplicate.",
      }),
    ).rejects.toThrow(
      `Outcome does not match pending action: ${started.pendingAction!.id}`,
    );

    const completed = await runtime.submit(runRoot, {
      actionId: second.pendingAction!.id,
      nodeId: "finish",
      status: "succeeded",
      summary: "Finished.",
    });
    expect(completed.disposition).toBe("done");
    await expect(
      runtime.submit(runRoot, {
        actionId: second.pendingAction!.id,
        nodeId: "finish",
        status: "succeeded",
        summary: "Duplicate terminal outcome.",
      }),
    ).rejects.toThrow("Run is completed");
    expect(await runtime.resume(runRoot)).toEqual(completed);
  });

  it("completes an empty route through its terminal checkpoint", async () => {
    const protocol = normalizeWorkflow(workflowInput([])).protocol;
    const runtime = createWorkflowRuntime();
    const started = await runtime.start({
      protocol,
      runRoot,
      runId: "checkpoint-run",
    });

    const completed = await runtime.submit(runRoot, {
      actionId: started.pendingAction!.id,
      status: "succeeded",
      summary: "Checkpoint recorded.",
    });

    expect(completed).toMatchObject({
      disposition: "done",
      currentNode: null,
      pendingAction: null,
    });
  });

  it("keeps protected artifact reads bounded and non-mutating", async () => {
    const protocol = normalizeWorkflow(
      workflowInput(
        [node("prepare", { outputSchemas: ["prepare.v1"] })],
        [outputSchema("prepare.v1", "prepare.txt")],
      ),
    ).protocol;
    const runtime = createWorkflowRuntime();
    const started = await runtime.start({
      protocol,
      runRoot,
      runId: "bounded-artifact-run",
    });
    const beforeState = await readRunState(runRoot);
    const beforeTrajectory = await readTrajectory(
      runRoot,
      beforeState!.trajectoryRef,
    );
    await fs.writeFile(
      path.join(runRoot, "prepare.txt"),
      Buffer.alloc(2 * 1024 * 1024 + 1, "x"),
    );

    const blocked = await runtime.submit(runRoot, {
      actionId: started.pendingAction!.id,
      nodeId: "prepare",
      status: "succeeded",
      summary: "Too large.",
      evidence: { summary: "present" },
    });
    expect(blocked).toMatchObject({
      disposition: "blocked",
      currentNode: "prepare",
      pendingAction: started.pendingAction,
    });
    expect(blocked.blockers[0]).toContain("exceeds 2097152 bytes");
    expect(await readRunState(runRoot)).toEqual(beforeState);
    expect(await readArtifacts(runRoot, beforeState!.artifactsRef)).toEqual({});
    expect(await readTrajectory(runRoot, beforeState!.trajectoryRef)).toEqual(
      beforeTrajectory,
    );
  });

  it("rejects protected artifact paths that cross a symlink", async () => {
    if (process.platform === "win32") return;
    const outside = path.join(root, "outside.txt");
    await fs.writeFile(outside, "outside\n");
    const protocol = normalizeWorkflow(
      workflowInput(
        [node("prepare", { outputSchemas: ["prepare.v1"] })],
        [outputSchema("prepare.v1", "prepare.txt")],
      ),
    ).protocol;
    const runtime = createWorkflowRuntime();
    const started = await runtime.start({
      protocol,
      runRoot,
      runId: "symlink-artifact-run",
    });
    await fs.symlink(outside, path.join(runRoot, "prepare.txt"));

    await expect(
      runtime.submit(runRoot, {
        actionId: started.pendingAction!.id,
        nodeId: "prepare",
        status: "succeeded",
        summary: "Unsafe.",
        evidence: { summary: "present" },
      }),
    ).rejects.toThrow("crosses a symbolic link");
    expect(await runtime.resume(runRoot)).toEqual(started);
  });

  it("accepts protected artifact path patterns", async () => {
    const protocol = normalizeWorkflow(
      workflowInput(
        [node("prepare", { outputSchemas: ["prepare.v1"] })],
        [outputSchema("prepare.v1", "outputs/*.txt")],
      ),
    ).protocol;
    const runtime = createWorkflowRuntime();
    const started = await runtime.start({
      protocol,
      runRoot,
      runId: "pattern-artifact-run",
    });
    await fs.mkdir(path.join(runRoot, "outputs"));
    await fs.writeFile(path.join(runRoot, "outputs", "result.txt"), "ok\n");

    const completed = await runtime.submit(runRoot, {
      actionId: started.pendingAction!.id,
      nodeId: "prepare",
      status: "succeeded",
      summary: "Pattern artifact found.",
      evidence: { summary: "present" },
    });

    expect(completed.disposition).toBe("done");
  });

  it("excludes disabled Nodes and exposes the active Node-to-step mapping", async () => {
    const protocol = normalizeWorkflow(
      workflowInput([
        node("prepare"),
        node("disabled", { disabled: true }),
        node("finish"),
      ]),
    ).protocol;
    const runtime = createWorkflowRuntime();

    const continuation = await runtime.start({
      protocol,
      runRoot,
      runId: "disabled-run",
    });

    expect(continuation.currentNode).toBe("prepare");
    expect(continuation.execution.nodeToStep).toEqual({
      prepare: continuation.pendingAction!.stepId,
      finish: expect.stringMatching(/^node-2-finish$/u),
    });
    expect(continuation.execution.nodeToStep).not.toHaveProperty("disabled");
  });

  it("uses the protocol's single declared route order", async () => {
    const normalized = normalizeWorkflow(
      workflowInput([node("finish"), node("prepare")]),
    );
    const protocol = structuredClone(normalized.protocol);
    protocol.evals[0].expectedNodeOrder = ["prepare", "finish"];
    protocol.evals[0].expectedRoutes![0].nodeOrder = ["prepare", "finish"];
    protocol.edges = [
      { from: "prepare", to: "finish", condition: "success" },
      { from: "prepare", to: "prepare", condition: "failure" },
      { from: "prepare", to: "prepare", condition: "pause" },
      { from: "finish", to: null, condition: "success" },
      { from: "finish", to: "finish", condition: "failure" },
      { from: "finish", to: "finish", condition: "pause" },
    ];
    const runtime = createWorkflowRuntime();

    const continuation = await runtime.start({
      protocol,
      runRoot,
      runId: "route-order-run",
    });

    expect(continuation.currentNode).toBe("prepare");
    expect(continuation.pendingAction?.stepId).toBe("node-1-prepare");
  });

  it("uses an explicit terminal checkpoint for an empty active route", async () => {
    const protocol = normalizeWorkflow(workflowInput([])).protocol;
    const runtime = createWorkflowRuntime();

    const continuation = await runtime.start({
      protocol,
      runRoot,
      runId: "empty-run",
    });

    expect(continuation).toMatchObject({
      disposition: "continue",
      currentNode: null,
      pendingAction: {
        type: "checkpoint",
        stepId: "terminal-checkpoint",
      },
      execution: { nodeToStep: {} },
    });
  });

  it("produces stable protocol and compiled package identity", async () => {
    const protocol = normalizeWorkflow(
      workflowInput([node("prepare"), node("finish")]),
    ).protocol;
    const runtime = createWorkflowRuntime();
    const firstRoot = path.join(root, "first");
    const secondRoot = path.join(root, "second");
    await fs.mkdir(firstRoot, { recursive: true });
    await fs.mkdir(secondRoot, { recursive: true });

    const first = await runtime.start({
      protocol,
      runRoot: firstRoot,
      runId: "first-run",
    });
    const second = await runtime.start({
      protocol: structuredClone(protocol),
      runRoot: secondRoot,
      runId: "second-run",
    });

    expect(second.execution).toEqual(first.execution);
    expect(first.execution.protocolHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(first.execution.packageHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(first.execution.snapshotHash).toBe(first.execution.packageHash);
  });

  it("resumes from the immutable compiled snapshot after protocol input changes", async () => {
    const protocol = normalizeWorkflow(
      workflowInput([node("prepare")]),
    ).protocol;
    const runtime = createWorkflowRuntime();
    const started = await runtime.start({
      protocol,
      runRoot,
      runId: "immutable-run",
    });
    protocol.nodes[0].label = "Changed after start";

    const resumed = await runtime.resume(runRoot);

    expect(resumed).toEqual(started);
  });

  it("resumes a route whose Node order is not lexicographically sorted", async () => {
    const protocol = normalizeWorkflow(
      workflowInput([node("zeta"), node("alpha")]),
    ).protocol;
    const runtime = createWorkflowRuntime();
    const started = await runtime.start({
      protocol,
      runRoot,
      runId: "non-lexical-run",
    });

    const resumed = await runtime.resume(runRoot);

    expect(resumed).toEqual(started);
  });

  it.each([
    {
      name: "conditional transitions",
      mutate(protocol: WorkflowProtocol) {
        protocol.edges[0].when = "choose-later";
      },
      error: /conditional transition/u,
    },
    {
      name: "ambiguous success routes",
      mutate(protocol: WorkflowProtocol) {
        protocol.edges.push({
          from: "prepare",
          to: null,
          condition: "success",
        });
      },
      error: /ambiguous success transitions/u,
    },
    {
      name: "success cycles",
      mutate(protocol: WorkflowProtocol) {
        protocol.edges = protocol.edges.map((edge) =>
          edge.from === "finish" && edge.condition === "success"
            ? { ...edge, to: "prepare" }
            : edge,
        );
      },
      error: /linear|cycle/u,
    },
    {
      name: "repeated Node visits",
      mutate(protocol: WorkflowProtocol) {
        protocol.evals[0].expectedNodeOrder = ["prepare", "finish", "prepare"];
      },
      error: /repeated Workflow Node visits/u,
    },
  ])("rejects $name before creating Run state", async ({ mutate, error }) => {
    const protocol = normalizeWorkflow(
      workflowInput([node("prepare"), node("finish")]),
    ).protocol;
    mutate(protocol);
    const runtime = createWorkflowRuntime();

    await expect(
      runtime.start({ protocol, runRoot, runId: "rejected-run" }),
    ).rejects.toThrow(error);
    await expect(fs.access(path.join(runRoot, ".comet"))).rejects.toMatchObject(
      {
        code: "ENOENT",
      },
    );
  });
});
