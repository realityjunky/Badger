import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { normalizeWorkflow } from "../src/index.js";
import {
  createWorkflowRuntime,
  inspectWorkflowRun,
  listWorkflowRuns,
  projectWorkflowState,
  type StandaloneWorkflowRunLocation,
  type WorkflowRunRegistry,
  type WorkflowStateProjection,
} from "../src/workflow-runtime/public.js";

function protocol() {
  return normalizeWorkflow({
    kind: "workflow-kernel",
    name: "registry-workflow",
    goal: "Inspect durable workflow Runs.",
    customNodes: ["prepare", "finish"].map((id) => ({
      id,
      label: id,
      kind: "action" as const,
      responsibility: `Run ${id}.`,
      implementation: {
        skill: `${id}-skill`,
        operation: "default",
        scope: "main",
      },
      operations: ["require", "augment", "disable"],
      outputSchemas: [],
      guardrails: [],
    })),
  }).protocol;
}

describe("WorkflowRuntime Run registry", () => {
  let projectRoot: string;

  beforeEach(async () => {
    projectRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "badger-workflow-registry-"),
    );
  });

  it("ignores projections and stray directories without creating registry state", async () => {
    const runtime = createWorkflowRuntime();
    const started = await runtime.start({
      protocol: protocol(),
      location: location("real-run"),
    });
    const runsRoot = path.join(projectRoot, ".badger", "runs");
    await fs.mkdir(path.join(runsRoot, "empty-run"));
    await fs.mkdir(path.join(runsRoot, "invalid run id"));
    await fs.mkdir(path.join(runsRoot, "projection-only"));
    await fs.writeFile(
      path.join(runsRoot, "projection-only", "workflow-state.json"),
      JSON.stringify({ runId: "fake-run", status: "completed" }),
    );
    await fs.writeFile(path.join(runsRoot, "notes.txt"), "Not a Run.\n");
    const fakeProjection = path.join(
      runsRoot,
      "real-run",
      "workflow-state.json",
    );
    await fs.writeFile(fakeProjection, '{"status":"completed"}\n');

    const runs = await runtime.listRuns(projectRoot);

    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      runId: "real-run",
      status: "waiting",
      pendingAction: started.pendingAction,
    });
    await expect(fs.readFile(fakeProjection, "utf8")).resolves.toBe(
      '{"status":"completed"}\n',
    );
    const emptyProject = path.join(projectRoot, "empty-project");
    await fs.mkdir(emptyProject);
    await expect(runtime.listRuns(emptyProject)).resolves.toEqual([]);
    await expect(fs.readdir(emptyProject)).resolves.toEqual([]);
  });

  afterEach(async () => {
    await fs.rm(projectRoot, { recursive: true, force: true });
  });

  function location(runId: string): StandaloneWorkflowRunLocation {
    return { kind: "standalone", projectRoot, runId };
  }

  it("lists a project's Runs in Run id order with current state and history", async () => {
    const runtime = createWorkflowRuntime();
    const registry: WorkflowRunRegistry = runtime;
    const started = await runtime.start({
      protocol: protocol(),
      location: location("z-run"),
    });
    await runtime.start({
      protocol: protocol(),
      location: location("a-run"),
    });
    const advanced = await runtime.submit(location("z-run"), {
      actionId: started.pendingAction!.id,
      nodeId: "prepare",
      status: "succeeded",
      summary: "Prepared the input.",
    });

    const runs = await registry.listRuns(projectRoot);

    expect(runs.map((run) => run.runId)).toEqual(["a-run", "z-run"]);
    expect(runs[0]).toMatchObject({
      location: location("a-run"),
      runRoot: path.join(projectRoot, ".badger", "runs", "a-run"),
      status: "waiting",
      currentNode: "prepare",
      pendingAction: { type: "invoke_skill" },
      history: [],
    });
    expect(runs[1]).toMatchObject({
      location: location("z-run"),
      status: "waiting",
      currentNode: "finish",
      pendingAction: advanced.pendingAction,
      history: [
        {
          event: "outcome-recorded",
          node: "prepare",
          status: "succeeded",
          at: expect.any(String),
        },
      ],
    });
  });

  it.each(["manual", "standalone"] as const)(
    "inspects a %s Run and projects its completion history through the public seam",
    async (kind) => {
      const target =
        kind === "manual"
          ? { kind, runRoot: path.join(projectRoot, "manual-run") }
          : location("standalone-run");
      const runtime = createWorkflowRuntime();
      const started = await runtime.start({
        protocol: protocol(),
        location: target,
      });

      await expect(runtime.inspect(target)).resolves.toEqual(started);
      await expect(inspectWorkflowRun(target)).resolves.toEqual(started);
      const projected: WorkflowStateProjection | null =
        await runtime.projectState(target);
      expect(projected).toMatchObject({
        runId: started.runId,
        status: "waiting",
        currentNode: "prepare",
        pendingAction: started.pendingAction,
        history: [],
      });
      projected!.pendingAction!.id = "modified-by-reader";
      await expect(runtime.inspect(target)).resolves.toEqual(started);

      const second = await runtime.submit(target, {
        actionId: started.pendingAction!.id,
        nodeId: "prepare",
        status: "succeeded",
        summary: "Prepared the input.",
      });
      const completed = await runtime.submit(target, {
        actionId: second.pendingAction!.id,
        nodeId: "finish",
        status: "succeeded",
        summary: "Finished the workflow.",
      });

      await expect(runtime.inspect(target)).resolves.toEqual(completed);
      const state = await projectWorkflowState(target);
      expect(state).toMatchObject({
        status: "completed",
        currentNode: null,
        pendingAction: null,
        completedNodes: ["prepare", "finish"],
        history: [
          { node: "prepare", status: "succeeded" },
          { node: "finish", status: "succeeded" },
        ],
      });
      await expect(runtime.projectState(target)).resolves.toEqual(state);
      if (kind === "standalone") {
        expect(await listWorkflowRuns(projectRoot)).toMatchObject([state]);
      }
    },
  );

  it("returns empty read models for missing Runs without writing to the project", async () => {
    const runtime = createWorkflowRuntime();
    await expect(runtime.listRuns(projectRoot)).resolves.toEqual([]);
    await expect(runtime.inspect(location("missing-run"))).resolves.toBeNull();
    await expect(
      runtime.projectState(location("missing-run")),
    ).resolves.toBeNull();
    await expect(fs.readdir(projectRoot)).resolves.toEqual([]);
    await expect(runtime.listRuns("")).rejects.toThrow("project root");
  });

  it("ignores linked Run directories and refuses a linked registry directory", async () => {
    const runtime = createWorkflowRuntime();
    await runtime.start({
      protocol: protocol(),
      location: location("real-run"),
    });
    const runsRoot = path.join(projectRoot, ".badger", "runs");
    await fs.symlink(
      path.join(runsRoot, "real-run"),
      path.join(runsRoot, "alias"),
      "junction",
    );

    expect(
      (await runtime.listRuns(projectRoot)).map((run) => run.runId),
    ).toEqual(["real-run"]);

    await fs.rename(runsRoot, path.join(projectRoot, "moved-runs"));
    await fs.symlink(
      path.join(projectRoot, "moved-runs"),
      runsRoot,
      "junction",
    );
    await expect(runtime.listRuns(projectRoot)).rejects.toThrow(
      /symbolic link|junction/u,
    );
  });
});
