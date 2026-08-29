import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalizeWorkflow } from "../src/workflow/contract.js";
import { createWorkflowRuntime } from "../src/workflow-runtime/index.js";
import { readRunState } from "../src/engine/state.js";
import type { WorkflowInput, WorkflowProtocol } from "../src/types.js";

function workflowInput(nodes: WorkflowInput["customNodes"]): WorkflowInput {
  return {
    kind: "workflow-kernel",
    name: "demo-workflow",
    goal: "Run the demo workflow.",
    customNodes: nodes,
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
