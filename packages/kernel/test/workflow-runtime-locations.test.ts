import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { normalizeWorkflow } from "../src/workflow/contract.js";
import { createWorkflowRuntime } from "../src/workflow-runtime/public.js";
import type { WorkflowInput, WorkflowProtocol } from "../src/types.js";
import type {
  StartWorkflowRunOptions,
  WorkflowRunLocation,
} from "../src/workflow-runtime/types.js";
import { vitestCli } from "./fixtures/vitest-cli.js";

function protocol(
  outputSchemas: WorkflowInput["outputSchemas"] = [],
): WorkflowProtocol {
  const input: WorkflowInput = {
    kind: "workflow-kernel",
    name: "location-workflow",
    goal: "Run a location workflow.",
    customNodes: [
      {
        id: "prepare",
        label: "Prepare",
        kind: "action",
        responsibility: "Prepare the synthetic input.",
        implementation: {
          skill: "prepare-skill",
          operation: "default",
          scope: "main",
        },
        operations: ["require", "augment", "disable"],
        outputSchemas: [],
        guardrails: [],
      },
      {
        id: "finish",
        label: "Finish",
        kind: "action",
        responsibility: "Finish the synthetic workflow.",
        implementation: {
          skill: "finish-skill",
          operation: "default",
          scope: "main",
        },
        operations: ["require", "augment", "disable"],
        outputSchemas: [],
        guardrails: [],
      },
    ],
    outputSchemas,
  };
  if (outputSchemas.length > 0) {
    input.customNodes[0].outputSchemas = outputSchemas.map(
      (schema) => schema.id,
    );
  }
  return normalizeWorkflow(input).protocol;
}

function outputSchema(): NonNullable<WorkflowInput["outputSchemas"]>[number] {
  return {
    id: "prepare.v1",
    description: "Preparation output.",
    artifacts: [
      {
        id: "result",
        kind: "file",
        required: true,
        paths: ["prepare.txt"],
        validations: ["artifact-exists"],
      },
    ],
    evidence: [{ id: "summary", required: true }],
  };
}

function startOptions(
  location: WorkflowRunLocation,
  workflowProtocol: WorkflowProtocol,
  runId: string,
): StartWorkflowRunOptions {
  if (location.kind === "manual") {
    return { protocol: workflowProtocol, location, runId };
  }
  return { protocol: workflowProtocol, location };
}

interface LocationCase {
  name: string;
  create(root: string, runId: string): WorkflowRunLocation;
}

const locationCases: LocationCase[] = [
  {
    name: "manual",
    create(root, _runId) {
      return {
        kind: "manual",
        runRoot: path.join(root, "manual-change"),
      };
    },
  },
  {
    name: "standalone",
    create(root, runId) {
      return {
        kind: "standalone",
        projectRoot: path.join(root, "standalone-project"),
        runId,
      };
    },
  },
];

const execFileAsync = promisify(execFile);

function locationRunRoot(location: WorkflowRunLocation): string {
  return location.kind === "manual"
    ? location.runRoot
    : path.join(location.projectRoot, ".badger", "runs", location.runId);
}

async function recoverInFreshProcess(
  location: WorkflowRunLocation,
  expected: Record<string, unknown>,
): Promise<void> {
  const childTest = path.join(
    process.cwd(),
    "test",
    `workflow-runtime-fresh-process-${randomUUID()}.test.ts`,
  );
  const sourceEntry = path.resolve("src/workflow-runtime/public.ts");
  const configPath = path.resolve("vitest.config.ts");
  try {
    await fs.writeFile(
      childTest,
      `import { expect, it } from "vitest";
import { createWorkflowRuntime } from ${JSON.stringify(sourceEntry)};

it("recovers the persisted WorkflowRuntime continuation", async () => {
  const location = JSON.parse(process.env.WORKFLOW_LOCATION_JSON!);
  const continuation = await createWorkflowRuntime().recover(location);
  expect(continuation).toMatchObject(
    JSON.parse(process.env.WORKFLOW_EXPECTED_JSON!),
  );
});
`,
    );
    await execFileAsync(
      process.execPath,
      [vitestCli, "run", "--config", configPath, childTest],
      {
        cwd: path.resolve("."),
        env: {
          PATH: process.env.PATH,
          WORKFLOW_EXPECTED_JSON: JSON.stringify(expected),
          WORKFLOW_LOCATION_JSON: JSON.stringify(location),
        },
      },
    );
  } finally {
    await fs.rm(childTest, { force: true });
  }
}

describe("WorkflowRuntime shared conformance", () => {
  describe.each(locationCases)("$name Run location", (locationCase) => {
    let root: string;

    beforeEach(async () => {
      root = await fs.mkdtemp(
        path.join(os.tmpdir(), "badger-workflow-location-"),
      );
    });

    afterEach(async () => {
      await fs.rm(root, { recursive: true, force: true });
    });

    it("shares multi-Node start, recovery, submission, and terminal behavior", async () => {
      const runId = `${locationCase.name}-run`;
      const location = locationCase.create(root, runId);
      const runtime = createWorkflowRuntime();
      const started = await runtime.start({
        ...startOptions(location, protocol(), runId),
      });

      expect(started).toMatchObject({
        disposition: "continue",
        runId,
        currentNode: "prepare",
        pendingAction: {
          type: "invoke_skill",
          ref: "location-workflow-prepare",
          stepId: "node-1-prepare",
        },
      });

      const resumed = await runtime.resume(location);
      expect(resumed).toEqual(started);

      const recovered = await createWorkflowRuntime().recover(location);
      expect(recovered).toEqual(started);

      const second = await runtime.submit(location, {
        actionId: recovered.pendingAction!.id,
        nodeId: "prepare",
        status: "succeeded",
        summary: "Prepared.",
      });
      expect(second.currentNode).toBe("finish");

      const completed = await createWorkflowRuntime().submit(location, {
        actionId: second.pendingAction!.id,
        nodeId: "finish",
        status: "succeeded",
        summary: "Finished.",
      });
      expect(completed).toMatchObject({
        disposition: "done",
        runId,
        currentNode: null,
        pendingAction: null,
      });
      expect(await createWorkflowRuntime().recover(location)).toEqual(
        completed,
      );
    });

    it("shares blocked repair and retry behavior", async () => {
      const runId = `${locationCase.name}-repair-run`;
      const location = locationCase.create(root, runId);
      const runtime = createWorkflowRuntime();
      const started = await runtime.start(
        startOptions(location, protocol([outputSchema()]), runId),
      );

      const blocked = await runtime.submit(location, {
        actionId: started.pendingAction!.id,
        nodeId: "prepare",
        status: "succeeded",
        summary: "Missing evidence.",
      });
      expect(blocked).toMatchObject({
        disposition: "blocked",
        currentNode: "prepare",
        pendingAction: started.pendingAction,
      });

      const failed = await runtime.submit(location, {
        actionId: started.pendingAction!.id,
        nodeId: "prepare",
        status: "failed",
        summary: "Transient failure.",
      });
      expect(failed).toMatchObject({
        disposition: "continue",
        currentNode: "prepare",
        pendingAction: started.pendingAction,
      });

      const runRoot =
        location.kind === "manual"
          ? location.runRoot
          : path.join(location.projectRoot, ".badger", "runs", location.runId);
      await fs.writeFile(path.join(runRoot, "prepare.txt"), "prepared\n");
      const second = await runtime.submit(location, {
        actionId: started.pendingAction!.id,
        nodeId: "prepare",
        status: "succeeded",
        summary: "Prepared after retry.",
        evidence: { summary: "prepared" },
      });
      const completed = await runtime.submit(location, {
        actionId: second.pendingAction!.id,
        nodeId: "finish",
        status: "succeeded",
        summary: "Finished after retry.",
      });
      expect(completed.disposition).toBe("done");
    });

    it("shares compiled identity and Node-to-step mapping", async () => {
      const runId = `${locationCase.name}-identity-run`;
      const location = locationCase.create(root, runId);
      const started = await createWorkflowRuntime().start(
        startOptions(location, protocol(), runId),
      );

      expect(started.execution).toMatchObject({
        protocolHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
        packageHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
        snapshotHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
        nodeToStep: {
          prepare: "node-1-prepare",
          finish: "node-2-finish",
        },
      });
      expect(started.execution.snapshotHash).toBe(
        started.execution.packageHash,
      );
    });

    it("recovers the pending action in a fresh process", async () => {
      const runId = `${locationCase.name}-fresh-process-run`;
      const location = locationCase.create(root, runId);
      await createWorkflowRuntime().start(
        startOptions(location, protocol(), runId),
      );

      await recoverInFreshProcess(location, {
        disposition: "continue",
        runId,
        currentNode: "prepare",
        pendingAction: { stepId: "node-1-prepare" },
      });
    });

    it("recovers a terminal continuation in a fresh process", async () => {
      const runId = `${locationCase.name}-fresh-terminal-run`;
      const location = locationCase.create(root, runId);
      const runtime = createWorkflowRuntime();
      const started = await runtime.start(
        startOptions(location, protocol(), runId),
      );
      const second = await runtime.submit(location, {
        actionId: started.pendingAction!.id,
        nodeId: "prepare",
        status: "succeeded",
        summary: "Prepared.",
      });
      await runtime.submit(location, {
        actionId: second.pendingAction!.id,
        nodeId: "finish",
        status: "succeeded",
        summary: "Finished.",
      });

      await recoverInFreshProcess(location, {
        disposition: "done",
        runId,
        currentNode: null,
        pendingAction: null,
      });
    });

    it.each([
      [
        "protocolHash",
        "WorkflowRuntime protocol identity does not match Skill snapshot",
      ],
      [
        "packageHash",
        "WorkflowRuntime package identity does not match Skill snapshot",
      ],
      [
        "snapshotHash",
        "WorkflowRuntime snapshot identity does not match Run state",
      ],
    ])(
      "rejects persisted %s identity drift before recovery",
      async (field, error) => {
        const runId = `${locationCase.name}-identity-drift-${field}`;
        const location = locationCase.create(root, runId);
        const runtime = createWorkflowRuntime();
        await runtime.start(startOptions(location, protocol(), runId));
        const statePath = path.join(
          locationRunRoot(location),
          ".badger",
          "run-state.json",
        );
        const state = JSON.parse(await fs.readFile(statePath, "utf8")) as {
          runtimeIdentity: Record<string, unknown>;
          skillHash: string;
        };
        if (field === "snapshotHash") {
          state.runtimeIdentity.snapshotHash = "0".repeat(64);
        } else {
          state.runtimeIdentity[field] = "0".repeat(64);
        }
        await fs.writeFile(statePath, JSON.stringify(state, null, 2) + "\n");

        await expect(runtime.recover(location)).rejects.toThrow(error);
      },
    );

    it("rejects persisted snapshot content drift before recovery", async () => {
      const runId = `${locationCase.name}-package-drift-run`;
      const location = locationCase.create(root, runId);
      const runtime = createWorkflowRuntime();
      const started = await runtime.start(
        startOptions(location, protocol(), runId),
      );
      const snapshotPath = path.join(
        locationRunRoot(location),
        ".badger",
        "skill-snapshots",
        started.execution.snapshotHash,
        "package.json",
      );
      const snapshot = JSON.parse(await fs.readFile(snapshotPath, "utf8")) as {
        definition: { goal: { statement: string } };
      };
      snapshot.definition.goal.statement = "Changed after start.";
      await fs.writeFile(
        snapshotPath,
        JSON.stringify(snapshot, null, 2) + "\n",
      );

      await expect(runtime.recover(location)).rejects.toThrow(
        "Skill snapshot is invalid or missing",
      );
    });

    it("rejects persisted pending-action drift before recovery", async () => {
      const runId = `${locationCase.name}-pending-drift-run`;
      const location = locationCase.create(root, runId);
      const runtime = createWorkflowRuntime();
      await runtime.start(startOptions(location, protocol(), runId));
      const pendingPath = path.join(
        locationRunRoot(location),
        ".badger",
        "pending-action.json",
      );
      const pending = JSON.parse(await fs.readFile(pendingPath, "utf8")) as {
        ref?: string;
      };
      pending.ref = "changed-after-start";
      await fs.writeFile(pendingPath, JSON.stringify(pending, null, 2) + "\n");

      await expect(runtime.recover(location)).rejects.toThrow(
        "WorkflowRuntime pending action does not match compiled step",
      );
    });
  });
});

describe("WorkflowRuntime cross-location parity", () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "badger-workflow-parity-"));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("returns identical continuations for equivalent manual and standalone Runs", async () => {
    const runId = "parity-run";
    const manualLocation = {
      kind: "manual" as const,
      runRoot: path.join(root, "manual"),
    };
    const standaloneLocation = {
      kind: "standalone" as const,
      projectRoot: path.join(root, "project"),
      runId,
    };
    const runtime = createWorkflowRuntime();
    const manualStarted = await runtime.start(
      startOptions(manualLocation, protocol(), runId),
    );
    const standaloneStarted = await runtime.start({
      protocol: protocol(),
      location: standaloneLocation,
    });
    expect(standaloneStarted).toEqual(manualStarted);

    const manualSecond = await runtime.submit(manualLocation, {
      actionId: manualStarted.pendingAction!.id,
      nodeId: "prepare",
      status: "succeeded",
      summary: "Prepared.",
    });
    const standaloneSecond = await runtime.submit(standaloneLocation, {
      actionId: standaloneStarted.pendingAction!.id,
      nodeId: "prepare",
      status: "succeeded",
      summary: "Prepared.",
    });
    expect(standaloneSecond).toEqual(manualSecond);

    const manualCompleted = await runtime.submit(manualLocation, {
      actionId: manualSecond.pendingAction!.id,
      nodeId: "finish",
      status: "succeeded",
      summary: "Finished.",
    });
    const standaloneCompleted = await runtime.submit(standaloneLocation, {
      actionId: standaloneSecond.pendingAction!.id,
      nodeId: "finish",
      status: "succeeded",
      summary: "Finished.",
    });
    expect(standaloneCompleted).toEqual(manualCompleted);
  });
});

describe("WorkflowRuntime standalone coordinates and Run-id validation", () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(
      path.join(os.tmpdir(), "badger-workflow-standalone-"),
    );
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it.each(["", ".", "..", "../escape", "/tmp/escape", "nested/path"])(
    "rejects unsafe Run id %j before resolving standalone storage",
    async (runId) => {
      const projectRoot = path.join(root, "project");
      const location = {
        kind: "standalone" as const,
        projectRoot,
        runId,
      };
      const runtime = createWorkflowRuntime();

      await expect(
        runtime.start({ protocol: protocol(), location }),
      ).rejects.toThrow(/Run id/u);
      await expect(runtime.recover(location)).rejects.toThrow(/Run id/u);
      await expect(
        runtime.submit(location, {
          actionId: "action",
          status: "succeeded",
          summary: "Invalid location.",
        }),
      ).rejects.toThrow(/Run id/u);
      await expect(fs.access(projectRoot)).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
  );

  it("rejects a non-string standalone project root before resolving storage", async () => {
    const location = {
      kind: "standalone" as const,
      projectRoot: 123 as unknown as string,
      runId: "valid-run",
    };

    await expect(
      createWorkflowRuntime().start({ protocol: protocol(), location }),
    ).rejects.toThrow("standalone project root must be a non-empty string");
  });

  it("rejects a symlinked standalone project root before writing a Run", async () => {
    if (process.platform === "win32") return;
    const outsideRoot = path.join(root, "outside");
    const projectRoot = path.join(root, "linked-project");
    await fs.mkdir(outsideRoot);
    await fs.symlink(outsideRoot, projectRoot, "dir");
    const location = {
      kind: "standalone" as const,
      projectRoot,
      runId: "symlink-root-run",
    };

    await expect(
      createWorkflowRuntime().start({ protocol: protocol(), location }),
    ).rejects.toThrow("Standalone project root cannot cross a symbolic link");
    await expect(
      fs.access(path.join(outsideRoot, ".badger")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a symlinked standalone Run directory before recovery", async () => {
    if (process.platform === "win32") return;
    const outsideRoot = path.join(root, "outside");
    const projectRoot = path.join(root, "project");
    await fs.mkdir(projectRoot, { recursive: true });
    await fs.mkdir(outsideRoot);
    await fs.symlink(outsideRoot, path.join(projectRoot, ".badger"), "dir");
    const location = {
      kind: "standalone" as const,
      projectRoot,
      runId: "symlink-run-root",
    };

    await expect(createWorkflowRuntime().recover(location)).rejects.toThrow(
      "Standalone Run root crosses a symbolic link",
    );
  });

  it("rejects a copied Run state before recovery can attach it", async () => {
    const location = {
      kind: "standalone" as const,
      projectRoot: path.join(root, "project"),
      runId: "original-run",
    };
    const runtime = createWorkflowRuntime();
    await runtime.start({ protocol: protocol(), location });
    const statePath = path.join(
      location.projectRoot,
      ".badger",
      "runs",
      location.runId,
      ".badger",
      "run-state.json",
    );
    const state = JSON.parse(await fs.readFile(statePath, "utf8")) as Record<
      string,
      unknown
    >;
    state.runId = "copied-run";
    await fs.writeFile(statePath, JSON.stringify(state, null, 2) + "\n");

    await expect(runtime.recover(location)).rejects.toThrow(
      "Standalone Run state does not match requested Run id: original-run",
    );
  });

  it("keeps standalone Run ids isolated through pending and terminal state", async () => {
    const first = {
      kind: "standalone" as const,
      projectRoot: path.join(root, "project"),
      runId: "first-run",
    };
    const second = { ...first, runId: "second-run" };
    const runtime = createWorkflowRuntime();
    const firstStarted = await runtime.start({
      protocol: protocol(),
      location: first,
    });
    const secondStarted = await runtime.start({
      protocol: protocol(),
      location: second,
    });

    expect((await runtime.recover(second)).pendingAction).toEqual(
      secondStarted.pendingAction,
    );
    const firstCompleted = await runtime.submit(first, {
      actionId: firstStarted.pendingAction!.id,
      nodeId: "prepare",
      status: "succeeded",
      summary: "First prepared.",
    });
    expect(firstCompleted.currentNode).toBe("finish");
    expect((await runtime.recover(second)).currentNode).toBe("prepare");
  });
});
