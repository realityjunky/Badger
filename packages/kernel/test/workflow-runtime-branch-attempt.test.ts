import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalizeWorkflow } from "../src/workflow/contract.js";
import { generatePackage } from "../src/factory/generate.js";
import { createWorkflowRuntime } from "../src/workflow-runtime/public.js";
import { readRunState } from "../src/engine/state.js";
import { readTrajectory } from "../src/engine/run-store.js";
import { projectWorkflowState } from "../src/workflow-runtime/index.js";
import type { WorkflowInput, WorkflowProtocol } from "../src/types.js";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

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

function branchProtocol(): WorkflowProtocol {
  const input: WorkflowInput = {
    kind: "workflow-kernel",
    name: "branch-workflow",
    goal: "Run one declared branch.",
    customNodes: [node("start"), node("fast"), node("safe"), node("finish")],
    routing: {
      fields: [{ id: "mode", values: ["fast", "safe"] }],
      transitions: [
        {
          from: "start",
          to: "fast",
          condition: "success",
          when: { field: "mode", equals: "fast" },
        },
        {
          from: "start",
          to: "safe",
          condition: "success",
          when: { field: "mode", equals: "safe" },
        },
        { from: "fast", to: "finish", condition: "success" },
        { from: "safe", to: "finish", condition: "success" },
        { from: "finish", to: null, condition: "success" },
      ],
    },
  };
  return normalizeWorkflow(input).protocol;
}

function fallbackProtocol(): WorkflowProtocol {
  const input: WorkflowInput = {
    kind: "workflow-kernel",
    name: "fallback-workflow",
    goal: "Run a fallback branch.",
    customNodes: [
      node("start"),
      node("fast"),
      node("safe"),
      node("fallback"),
      node("finish"),
    ],
    routing: {
      fields: [
        { id: "mode", values: ["fast", "safe"] },
        { id: "quality", values: ["high", "low"] },
      ],
      transitions: [
        {
          from: "start",
          to: "fast",
          condition: "success",
          when: {
            all: [
              { field: "mode", equals: "fast" },
              { field: "quality", equals: "high" },
            ],
          },
        },
        {
          from: "start",
          to: "safe",
          condition: "success",
          when: { field: "mode", equals: "safe" },
        },
        { from: "start", to: "fallback", condition: "success" },
        { from: "fast", to: "finish", condition: "success" },
        { from: "safe", to: "finish", condition: "success" },
        { from: "fallback", to: "finish", condition: "success" },
        { from: "finish", to: null, condition: "success" },
      ],
    },
  };
  return normalizeWorkflow(input).protocol;
}

function noDefaultProtocol(): WorkflowProtocol {
  const protocol = fallbackProtocol();
  protocol.nodes.find((node) => node.id === "fallback")!.optional = true;
  protocol.edges = protocol.edges.filter(
    (edge) => !(edge.from === "start" && edge.when === undefined),
  );
  protocol.routing!.transitions = structuredClone(protocol.edges);
  return protocol;
}

describe("WorkflowRuntime revisioned branches and Attempts", () => {
  let root: string;
  let runRoot: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "badger-workflow-branch-"));
    runRoot = path.join(root, "change");
    await fs.mkdir(runRoot, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("selects a declared branch and advances the revision once", async () => {
    const runtime = createWorkflowRuntime();
    const started = await runtime.start({
      protocol: branchProtocol(),
      runRoot,
      runId: "branch-run",
    });

    expect(started).toMatchObject({
      disposition: "continue",
      revision: 0,
      execution: {
        capabilityVersion: 3,
        resolverHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
      },
      currentNode: "start",
      cycleId: null,
      attemptId: expect.any(String),
      visitOrdinal: 1,
      pendingAction: {
        type: "invoke_skill",
        attemptId: expect.any(String),
        retryOrdinal: 0,
      },
    });

    const next = await runtime.submit(runRoot, {
      actionId: started.pendingAction!.id,
      nodeId: "start",
      status: "succeeded",
      summary: "Selected the fast branch.",
      routing: { mode: "fast" },
    });

    expect(next).toMatchObject({
      disposition: "continue",
      revision: 1,
      currentNode: "fast",
      cycleId: null,
      visitOrdinal: 2,
      pendingAction: {
        type: "invoke_skill",
        retryOrdinal: 0,
      },
    });
    expect(next.attemptId).not.toBe(started.attemptId);
    expect(next.pendingAction!.id).not.toBe(started.pendingAction!.id);
  });

  it("evaluates conjunctions and selects the default only when no condition matches", async () => {
    const runtime = createWorkflowRuntime();
    const protocol = fallbackProtocol();
    const started = await runtime.start({
      protocol,
      runRoot,
      runId: "fallback-run",
    });

    const fast = await runtime.submit(runRoot, {
      actionId: started.pendingAction!.id,
      nodeId: "start",
      status: "succeeded",
      summary: "Fast route.",
      routing: { mode: "fast", quality: "high" },
    });
    expect(fast.currentNode).toBe("fast");

    const fallbackRoot = path.join(root, "fallback-change");
    const fallbackStarted = await runtime.start({
      protocol,
      runRoot: fallbackRoot,
      runId: "fallback-run",
    });
    const fallback = await runtime.submit(fallbackRoot, {
      actionId: fallbackStarted.pendingAction!.id,
      nodeId: "start",
      status: "succeeded",
      summary: "Fallback route.",
    });
    expect(fallback.currentNode).toBe("fallback");
  });

  it("returns a route blocker without mutating state when no condition matches", async () => {
    const runtime = createWorkflowRuntime();
    const started = await runtime.start({
      protocol: noDefaultProtocol(),
      runRoot,
      runId: "blocked-route-run",
    });
    const stateBefore = await readRunState(runRoot);
    const trajectoryBefore = await readTrajectory(
      runRoot,
      stateBefore!.trajectoryRef,
    );

    const blocked = await runtime.submit(runRoot, {
      actionId: started.pendingAction!.id,
      nodeId: "start",
      status: "succeeded",
      summary: "No route value.",
    });

    expect(blocked).toMatchObject({
      disposition: "blocked",
      revision: 0,
      currentNode: "start",
      attemptId: started.attemptId,
      pendingAction: started.pendingAction,
      blockers: [
        "Route blocker: no matching success transition from Node start",
      ],
    });
    expect(await readRunState(runRoot)).toEqual(stateBefore);
    expect(await readTrajectory(runRoot, stateBefore!.trajectoryRef)).toEqual(
      trajectoryBefore,
    );
  });

  it("keeps retries in one Attempt and records every outcome in the visit ledger", async () => {
    const runtime = createWorkflowRuntime();
    const started = await runtime.start({
      protocol: branchProtocol(),
      runRoot,
      runId: "retry-run",
    });

    const retried = await runtime.submit(runRoot, {
      actionId: started.pendingAction!.id,
      nodeId: "start",
      status: "failed",
      summary: "Transient failure.",
    });
    expect(retried).toMatchObject({
      disposition: "continue",
      revision: 1,
      currentNode: "start",
      attemptId: started.attemptId,
      visitOrdinal: 1,
      retryOrdinal: 1,
    });
    expect(retried.pendingAction?.id).not.toBe(started.pendingAction!.id);
    expect(retried.pendingAction).toMatchObject({
      attemptId: started.attemptId,
      retryOrdinal: 1,
    });

    const next = await runtime.submit(runRoot, {
      actionId: retried.pendingAction!.id,
      nodeId: "start",
      status: "succeeded",
      summary: "Selected the safe branch.",
      routing: { mode: "safe" },
      evidence: { branch: "safe" },
    });
    expect(next).toMatchObject({
      revision: 2,
      currentNode: "safe",
      visitOrdinal: 2,
      retryOrdinal: 0,
    });
    expect(next.attemptId).not.toBe(started.attemptId);

    const state = await readRunState(runRoot);
    expect(state?.workflowRuntime?.visits[0].outcomes).toEqual([
      {
        actionId: started.pendingAction!.id,
        status: "failed",
        summary: "Transient failure.",
        retryOrdinal: 0,
      },
      {
        actionId: retried.pendingAction!.id,
        status: "succeeded",
        summary: "Selected the safe branch.",
        retryOrdinal: 1,
        routing: { mode: "safe" },
        evidence: { branch: "safe" },
      },
    ]);
    const projection = await projectWorkflowState(runRoot);
    expect(projection?.visits[0].outcomes).toHaveLength(2);
  });

  it("rejects stale submissions without changing the committed branch", async () => {
    const runtime = createWorkflowRuntime();
    const started = await runtime.start({
      protocol: branchProtocol(),
      runRoot,
      runId: "stale-run",
    });
    const next = await runtime.submit(runRoot, {
      actionId: started.pendingAction!.id,
      nodeId: "start",
      status: "succeeded",
      summary: "Selected the fast branch.",
      routing: { mode: "fast" },
    });
    const stateBefore = await readRunState(runRoot);

    await expect(
      runtime.submit(runRoot, {
        actionId: started.pendingAction!.id,
        nodeId: "start",
        status: "succeeded",
        summary: "Replay.",
        routing: { mode: "fast" },
      }),
    ).rejects.toThrow(
      `Outcome does not match pending action: ${started.pendingAction!.id}`,
    );
    expect(await readRunState(runRoot)).toEqual(stateBefore);
    expect((await runtime.recover(runRoot)).pendingAction).toEqual(
      next.pendingAction,
    );
  });

  it("blocks an unknown routing value without changing the pending Attempt", async () => {
    const runtime = createWorkflowRuntime();
    const started = await runtime.start({
      protocol: branchProtocol(),
      runRoot,
      runId: "invalid-value-run",
    });
    const stateBefore = await readRunState(runRoot);
    const trajectoryBefore = await readTrajectory(
      runRoot,
      stateBefore!.trajectoryRef,
    );

    const blocked = await runtime.submit(runRoot, {
      actionId: started.pendingAction!.id,
      nodeId: "start",
      status: "succeeded",
      summary: "Invalid route value.",
      routing: { mode: "unknown" },
    });

    expect(blocked).toMatchObject({
      disposition: "blocked",
      revision: 0,
      attemptId: started.attemptId,
      pendingAction: started.pendingAction,
      blockers: ["Route blocker: invalid routing value for mode: unknown"],
    });
    expect(await readRunState(runRoot)).toEqual(stateBefore);
    expect(await readTrajectory(runRoot, stateBefore!.trajectoryRef)).toEqual(
      trajectoryBefore,
    );
  });

  it("blocks an unknown routing field without changing the pending Attempt", async () => {
    const runtime = createWorkflowRuntime();
    const started = await runtime.start({
      protocol: branchProtocol(),
      runRoot,
      runId: "invalid-field-run",
    });
    const stateBefore = await readRunState(runRoot);
    const blocked = await runtime.submit(runRoot, {
      actionId: started.pendingAction!.id,
      nodeId: "start",
      status: "succeeded",
      summary: "Invalid route field.",
      routing: { unknown: "fast" },
    });

    expect(blocked).toMatchObject({
      disposition: "blocked",
      revision: 0,
      attemptId: started.attemptId,
      pendingAction: started.pendingAction,
      blockers: ["Route blocker: unknown routing field: unknown"],
    });
    expect(await readRunState(runRoot)).toEqual(stateBefore);
  });

  it.each([
    [
      "ambiguous conditional transitions",
      (protocol: WorkflowProtocol) => {
        protocol.edges.splice(1, 0, {
          from: "start",
          to: "safe",
          condition: "success",
          when: { field: "mode", equals: "fast" },
        });
      },
      "ambiguous conditional transitions from Node start",
    ],
    [
      "unknown routing field",
      (protocol: WorkflowProtocol) => {
        protocol.edges[0].when = { field: "unknown", equals: "fast" };
      },
      "unknown routing field",
    ],
    [
      "unknown routing value",
      (protocol: WorkflowProtocol) => {
        protocol.edges[0].when = { field: "mode", equals: "unknown" };
      },
      "unknown value for mode",
    ],
    [
      "disabled target",
      (protocol: WorkflowProtocol) => {
        protocol.nodes.find((node) => node.id === "fast")!.disabled = true;
      },
      "targets disabled Node: fast",
    ],
    [
      "unknown target",
      (protocol: WorkflowProtocol) => {
        protocol.edges[0].to = "missing";
      },
      "references unknown Node: missing",
    ],
    [
      "multiple defaults",
      (protocol: WorkflowProtocol) => {
        protocol.edges.splice(3, 0, {
          from: "start",
          to: "safe",
          condition: "success",
        });
      },
      "multiple default transitions from Node start",
    ],
    [
      "undeclared cycle",
      (protocol: WorkflowProtocol) => {
        protocol.edges.find(
          (edge) => edge.from === "finish" && edge.condition === "success",
        )!.to = "start";
      },
      "undeclared cycle",
    ],
  ])("rejects %s before creating a Run", async (_label, mutate, message) => {
    const protocol = fallbackProtocol();
    mutate(protocol);
    await expect(
      createWorkflowRuntime().start({
        protocol,
        runRoot,
        runId: "invalid-run",
      }),
    ).rejects.toThrow(message);
    await expect(
      fs.access(path.join(runRoot, ".badger")),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rejects an unreachable required Node before Run creation", async () => {
    const protocol = fallbackProtocol();
    const orphan = structuredClone(protocol.nodes[0]);
    orphan.id = "orphan";
    protocol.nodes.push(orphan);
    await expect(
      createWorkflowRuntime().start({ protocol, runRoot, runId: "orphan-run" }),
    ).rejects.toThrow("required Node is unreachable: orphan");
    await expect(
      fs.access(path.join(runRoot, ".badger")),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("requires an explicit revisioned capability for direct branch protocols", async () => {
    const protocol = branchProtocol();
    delete protocol.capabilities;
    await expect(
      createWorkflowRuntime().start({
        protocol,
        runRoot,
        runId: "uncapable-run",
      }),
    ).rejects.toThrow(
      "revisioned capabilities are required for branch routing",
    );
    await expect(
      fs.access(path.join(runRoot, ".badger")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("returns equivalent branch continuations for manual and standalone locations", async () => {
    const runtime = createWorkflowRuntime();
    const runId = "location-branch-run";
    const manualLocation = {
      kind: "manual" as const,
      runRoot: path.join(root, "manual"),
    };
    const standaloneLocation = {
      kind: "standalone" as const,
      projectRoot: path.join(root, "standalone"),
      runId,
    };
    const protocol = branchProtocol();
    const manual = await runtime.start({
      protocol,
      location: manualLocation,
      runId,
    });
    const standalone = await runtime.start({
      protocol: structuredClone(protocol),
      location: standaloneLocation,
    });
    expect(standalone).toEqual(manual);

    const manualNext = await runtime.submit(manualLocation, {
      actionId: manual.pendingAction!.id,
      nodeId: "start",
      status: "succeeded",
      summary: "Selected the fast branch.",
      routing: { mode: "fast" },
    });
    const standaloneNext = await runtime.submit(standaloneLocation, {
      actionId: standalone.pendingAction!.id,
      nodeId: "start",
      status: "succeeded",
      summary: "Selected the fast branch.",
      routing: { mode: "fast" },
    });
    expect(standaloneNext).toEqual(manualNext);
    expect(await createWorkflowRuntime().recover(standaloneLocation)).toEqual(
      standaloneNext,
    );
  });

  it("keeps generated adapters as routing-free WorkflowRuntime projections", async () => {
    const projectRoot = path.join(root, "generated-project");
    const protocol = branchProtocol();
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
      destination: path.join(projectRoot, "generated"),
      projectRoot,
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
    const runRoot = path.join(projectRoot, "run");

    await run(stateScript, [
      "init",
      "--run-root",
      runRoot,
      "--run-id",
      "adapter-run",
    ]);
    const recovered = JSON.parse(
      (await run(stateScript, ["resume", "--run-root", runRoot, "--json"]))
        .stdout,
    ) as { revision: number; currentNode: string; attemptId: string };
    expect(recovered).toMatchObject({
      revision: 0,
      currentNode: "start",
      attemptId: expect.any(String),
    });
    const next = JSON.parse(
      (
        await run(stateScript, [
          "record",
          "start",
          '{"summary":"Fast route.","routing":{"mode":"fast"}}',
          "--run-root",
          runRoot,
          "--json",
        ])
      ).stdout,
    ) as { revision: number; currentNode: string };
    expect(next).toMatchObject({ revision: 1, currentNode: "fast" });

    const handoff = JSON.parse(
      (await run(handoffScript, ["--run-root", runRoot, "--json"])).stdout,
    ) as { continuation: { revision: number; currentNode: string } };
    expect(handoff.continuation).toMatchObject({
      revision: 1,
      currentNode: "fast",
    });
    await run(guardScript, ["entry", "fast", "--run-root", runRoot]);

    const stateAdapter = await fs.readFile(stateScript, "utf8");
    const guardAdapter = await fs.readFile(guardScript, "utf8");
    const handoffAdapter = await fs.readFile(handoffScript, "utf8");
    for (const adapter of [stateAdapter, guardAdapter, handoffAdapter]) {
      expect(adapter).not.toContain("resolveWorkflowNext");
      expect(adapter).not.toContain("completedNodes");
      expect(adapter).not.toContain("first-incomplete");
    }
  });
});
