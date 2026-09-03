import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { readRunState } from "../src/engine/state.js";
import { readTrajectory } from "../src/engine/run-store.js";
import { generatePackage } from "../src/factory/generate.js";
import { normalizeWorkflow } from "../src/workflow/contract.js";
import { createWorkflowRuntime } from "../src/workflow-runtime/index.js";
import type {
  WorkflowContinuation,
  WorkflowRunLocation,
} from "../src/workflow-runtime/types.js";
import type { WorkflowInput } from "../src/types.js";

const execFileAsync = promisify(execFile);

function artifactWorkflow(): ReturnType<typeof normalizeWorkflow>["protocol"] {
  const input = {
    kind: "workflow-kernel" as const,
    name: "artifact-workflow",
    goal: "Capture one durable artifact.",
    capabilities: {
      version: 3 as const,
      features: [
        "conditional-routing",
        "revisioned-attempts",
        "versioned-artifacts",
      ],
    },
    customNodes: [
      {
        id: "prepare",
        label: "Prepare",
        kind: "action" as const,
        responsibility: "Prepare a synthetic artifact.",
        implementation: {
          skill: "prepare-skill",
          operation: "default" as const,
          scope: "main" as const,
        },
        operations: ["require", "augment", "disable"] as const,
        outputSchemas: ["prepare.v1"],
        guardrails: [],
      },
    ],
    outputSchemas: [
      {
        id: "prepare.v1",
        description: "Prepared artifact.",
        artifacts: [
          {
            id: "result",
            kind: "file" as const,
            required: true,
            paths: ["result.txt"],
            validations: ["artifact-exists" as const],
            lifetime: "run" as const,
          },
        ],
        evidence: [{ id: "summary", required: true }],
      },
    ],
  } as unknown as WorkflowInput;
  return normalizeWorkflow(input).protocol;
}

function cyclicArtifactWorkflow(): ReturnType<
  typeof normalizeWorkflow
>["protocol"] {
  const actionNode = (id: string, outputSchemas: string[] = []) => ({
    id,
    label: id,
    kind: "action" as const,
    responsibility: `Run ${id}.`,
    implementation: {
      skill: `${id}-skill`,
      operation: "default" as const,
      scope: "main" as const,
    },
    operations: ["require", "augment", "disable"] as const,
    outputSchemas,
    guardrails: [],
  });
  const input: WorkflowInput = {
    kind: "workflow-kernel",
    name: "cyclic-artifact-workflow",
    goal: "Version and carry artifacts through repeated cycles.",
    capabilities: {
      version: 3,
      features: [
        "conditional-routing",
        "revisioned-attempts",
        "bounded-cycles",
        "versioned-artifacts",
      ],
    },
    customNodes: [actionNode("produce", ["produce.v1"]), actionNode("consume")],
    outputSchemas: [
      {
        id: "produce.v1",
        description: "Versioned synthetic artifacts.",
        artifacts: [
          {
            id: "attempt",
            kind: "file",
            required: true,
            paths: ["artifacts/*/attempt.txt"],
            validations: ["artifact-exists"],
          },
          {
            id: "cycle",
            kind: "file",
            required: true,
            paths: ["artifacts/cycle-*.txt"],
            validations: ["artifact-exists"],
            lifetime: "cycle",
          },
          {
            id: "run",
            kind: "file",
            required: true,
            paths: ["artifacts/run-*.txt"],
            validations: ["artifact-exists"],
            lifetime: "run",
          },
        ],
        evidence: [{ id: "summary", required: true }],
      },
    ],
    routing: {
      fields: [{ id: "next", values: ["repeat", "finish"] }],
      transitions: [
        { from: "produce", to: "consume", condition: "success" },
        {
          from: "consume",
          to: "produce",
          condition: "success",
          when: { field: "next", equals: "repeat" },
        },
        {
          from: "consume",
          to: null,
          condition: "success",
          when: { field: "next", equals: "finish" },
        },
      ],
    },
    cycles: [
      {
        key: "artifact-cycle",
        entry: "produce",
        repeatTransitions: [{ from: "consume", to: "produce" }],
        maxInstances: 2,
      },
    ],
  };
  return normalizeWorkflow(input).protocol;
}

function carryArtifactWorkflow(
  lifetime: "attempt" | "cycle" | "run" = "run",
): ReturnType<typeof normalizeWorkflow>["protocol"] {
  const actionNode = (id: string, outputSchemas: string[] = []) => ({
    id,
    label: id,
    kind: "action" as const,
    responsibility: `Run ${id}.`,
    implementation: {
      skill: `${id}-skill`,
      operation: "default" as const,
      scope: "main" as const,
    },
    operations: ["require", "augment", "disable"] as const,
    outputSchemas,
    guardrails: [],
  });
  return normalizeWorkflow({
    kind: "workflow-kernel",
    name: `${lifetime}-carry-workflow`,
    goal: "Carry one exact artifact version.",
    capabilities: {
      version: 3,
      features: [
        "conditional-routing",
        "revisioned-attempts",
        "versioned-artifacts",
      ],
    },
    customNodes: [actionNode("produce", ["produce.v1"]), actionNode("consume")],
    outputSchemas: [
      {
        id: "produce.v1",
        description: "Produced artifact.",
        artifacts: [
          {
            id: "result",
            kind: "file",
            required: true,
            paths:
              lifetime === "attempt"
                ? ["artifacts/*/result.txt"]
                : ["result.txt"],
            validations: ["artifact-exists"],
            lifetime,
          },
        ],
        evidence: [{ id: "summary", required: true }],
      },
    ],
  }).protocol;
}

async function committedEvidence(runRoot: string) {
  const state = await readRunState(runRoot);
  return {
    state,
    trajectory: await readTrajectory(runRoot, state!.trajectoryRef),
  };
}

function runRootFor(location: WorkflowRunLocation): string {
  return location.kind === "manual"
    ? location.runRoot
    : path.join(location.projectRoot, ".badger", "runs", location.runId);
}

function artifactProjection(continuation: WorkflowContinuation) {
  return {
    revision: continuation.revision,
    currentNode: continuation.currentNode,
    cycleId: continuation.cycleId,
    attemptId: continuation.attemptId,
    artifactVersions: continuation.artifactVersions.map(
      ({ timestamp: _timestamp, ...version }) => version,
    ),
    artifactSelections: continuation.artifactSelections.map(
      ({ timestamp: _timestamp, ...selection }) => selection,
    ),
    currentArtifactVersions: continuation.currentArtifactVersions,
  };
}

async function recoverArtifactsInFreshProcess(
  location: WorkflowRunLocation,
  expected: WorkflowContinuation,
): Promise<void> {
  const childTest = path.join(
    process.cwd(),
    "test",
    `workflow-runtime-artifact-fresh-${randomUUID()}.test.ts`,
  );
  const sourceEntry = path.resolve("src/workflow-runtime/public.ts");
  try {
    await fs.writeFile(
      childTest,
      `import { expect, it } from "vitest";
import { createWorkflowRuntime } from ${JSON.stringify(sourceEntry)};

it("recovers the artifact ledger", async () => {
  const location = JSON.parse(process.env.WORKFLOW_ARTIFACT_LOCATION!);
  const expected = JSON.parse(process.env.WORKFLOW_ARTIFACT_EXPECTED!);
  await expect(createWorkflowRuntime().recover(location)).resolves.toEqual(expected);
});
`,
    );
    await execFileAsync(
      process.execPath,
      [
        path.resolve("node_modules/vitest/vitest.mjs"),
        "run",
        "--config",
        path.resolve("vitest.config.ts"),
        childTest,
      ],
      {
        cwd: path.resolve("."),
        env: {
          PATH: process.env.PATH,
          WORKFLOW_ARTIFACT_LOCATION: JSON.stringify(location),
          WORKFLOW_ARTIFACT_EXPECTED: JSON.stringify(expected),
        },
      },
    );
  } finally {
    await fs.rm(childTest, { force: true });
  }
}

describe("WorkflowRuntime artifact versions", () => {
  let root: string;
  let runRoot: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(
      path.join(os.tmpdir(), "badger-workflow-artifact-"),
    );
    runRoot = path.join(root, "run");
    await fs.mkdir(runRoot);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("records an immutable content-bound Run artifact version", async () => {
    const runtime = createWorkflowRuntime();
    const started = await runtime.start({
      protocol: artifactWorkflow(),
      runRoot,
      runId: "artifact-run",
    });
    await fs.writeFile(path.join(runRoot, "result.txt"), "first\n");

    const completed = await runtime.submit(runRoot, {
      actionId: started.pendingAction!.id,
      nodeId: "prepare",
      status: "succeeded",
      summary: "Captured the artifact.",
      evidence: { summary: "captured" },
      artifacts: { result: "result.txt" },
    });

    expect(completed).toMatchObject({
      disposition: "done",
      artifactVersions: [
        {
          id: expect.stringMatching(/^artifact-version-/u),
          artifactId: "prepare.v1.result",
          lifetime: "run",
          path: "result.txt",
          contentHash:
            "b640e840b19d378660b32fb51ae18d67dccb4a8596a29e7bd72c1b2ae5928f41",
          producer: {
            runId: "artifact-run",
            nodeId: "prepare",
            cycleId: null,
            attemptId: started.attemptId,
            actionId: started.pendingAction!.id,
            revision: 0,
          },
        },
      ],
      currentArtifactVersions: {
        "prepare.v1.result": expect.stringMatching(/^artifact-version-/u),
      },
    });
    expect(completed.artifactVersions[0].timestamp).toEqual(expect.any(String));
    expect(completed.currentArtifactVersions["prepare.v1.result"]).toBe(
      completed.artifactVersions[0].id,
    );
    await expect(runtime.recover(runRoot)).resolves.toEqual(completed);
  });

  it("does not capture ambient output without an explicit update or version", async () => {
    const runtime = createWorkflowRuntime();
    const started = await runtime.start({
      protocol: artifactWorkflow(),
      runRoot,
      runId: "explicit-artifact-run",
    });
    await fs.writeFile(path.join(runRoot, "result.txt"), "ambient\n");
    const before = await committedEvidence(runRoot);

    const blocked = await runtime.submit(runRoot, {
      actionId: started.pendingAction!.id,
      nodeId: "prepare",
      status: "succeeded",
      summary: "Did not declare an artifact update.",
      evidence: { summary: "present" },
    });

    expect(blocked).toMatchObject({
      disposition: "blocked",
      pendingAction: started.pendingAction,
      artifactVersions: [],
      blockers: [expect.stringContaining("explicit update or version")],
    });
    expect(await committedEvidence(runRoot)).toEqual(before);
  });

  it("versions all lifetimes and carries exact versions through repeated Cycles", async () => {
    const runtime = createWorkflowRuntime();
    const started = await runtime.start({
      protocol: cyclicArtifactWorkflow(),
      runRoot,
      runId: "cyclic-artifact-run",
    });
    await fs.mkdir(path.join(runRoot, "artifacts"));
    const firstAttemptPath = `artifacts/${started.attemptId}/attempt.txt`;
    await fs.mkdir(path.dirname(path.join(runRoot, firstAttemptPath)), {
      recursive: true,
    });
    await fs.writeFile(path.join(runRoot, firstAttemptPath), "attempt one\n");
    await fs.writeFile(
      path.join(runRoot, "artifacts", "cycle-1.txt"),
      "cycle one\n",
    );
    await fs.writeFile(
      path.join(runRoot, "artifacts", "run-1.txt"),
      "run one\n",
    );

    const firstConsume = await runtime.submit(runRoot, {
      actionId: started.pendingAction!.id,
      nodeId: "produce",
      status: "succeeded",
      summary: "Produced the first versions.",
      evidence: { summary: "first" },
      artifacts: {
        attempt: firstAttemptPath,
        cycle: "artifacts/cycle-1.txt",
        run: "artifacts/run-1.txt",
      },
    });
    expect(firstConsume.artifactVersions).toHaveLength(3);
    expect(
      firstConsume.artifactVersions.map((version) => version.lifetime),
    ).toEqual(["attempt", "cycle", "run"]);
    expect(firstConsume.currentArtifactVersions).toEqual({
      "produce.v1.cycle": expect.any(String),
      "produce.v1.run": expect.any(String),
    });
    const firstCycleVersion = firstConsume.artifactVersions.find(
      (version) => version.lifetime === "cycle",
    )!;
    const firstRunVersion = firstConsume.artifactVersions.find(
      (version) => version.lifetime === "run",
    )!;
    const originalRunVersion = structuredClone(firstRunVersion);

    const secondProduce = await runtime.submit(runRoot, {
      actionId: firstConsume.pendingAction!.id,
      nodeId: "consume",
      status: "succeeded",
      summary: "Carried the first persistent versions.",
      routing: { next: "repeat" },
      artifactVersions: {
        cycle: firstCycleVersion.id,
        run: firstRunVersion.id,
      },
    });
    expect(secondProduce.artifactVersions).toHaveLength(3);
    expect(secondProduce.artifactSelections).toHaveLength(5);
    expect(secondProduce.currentArtifactVersions).toEqual({
      "produce.v1.run": firstRunVersion.id,
    });
    expect(secondProduce.cycleId).not.toBe(started.cycleId);

    const secondAttemptPath = `artifacts/${secondProduce.attemptId}/attempt.txt`;
    await fs.mkdir(path.dirname(path.join(runRoot, secondAttemptPath)), {
      recursive: true,
    });
    await fs.writeFile(path.join(runRoot, secondAttemptPath), "attempt two\n");
    await fs.writeFile(
      path.join(runRoot, "artifacts", "cycle-2.txt"),
      "cycle two\n",
    );
    const secondConsume = await runtime.submit(runRoot, {
      actionId: secondProduce.pendingAction!.id,
      nodeId: "produce",
      status: "succeeded",
      summary: "Produced the second versions.",
      evidence: { summary: "second" },
      artifacts: {
        attempt: secondAttemptPath,
        cycle: "artifacts/cycle-2.txt",
      },
      artifactVersions: {
        run: firstRunVersion.id,
      },
    });
    expect(secondConsume.artifactVersions).toHaveLength(5);
    expect(
      secondConsume.artifactVersions.filter(
        (version) => version.artifactId === "produce.v1.run",
      ),
    ).toEqual([originalRunVersion]);
    const secondCycleVersion = secondConsume.artifactVersions.find(
      (version) =>
        version.lifetime === "cycle" &&
        version.producer.cycleId === secondConsume.cycleId,
    )!;

    const completed = await runtime.submit(runRoot, {
      actionId: secondConsume.pendingAction!.id,
      nodeId: "consume",
      status: "succeeded",
      summary: "Finished with explicit prior Run provenance.",
      routing: { next: "finish" },
      artifactVersions: {
        cycle: secondCycleVersion.id,
        run: firstRunVersion.id,
      },
    });
    expect(completed.disposition).toBe("done");
    expect(completed.artifactVersions).toHaveLength(5);
    expect(completed.artifactVersions[2]).toEqual(originalRunVersion);
    expect(completed.artifactSelections.at(-1)).toMatchObject({
      artifactId: "produce.v1.run",
      versionId: firstRunVersion.id,
      cycleId: secondConsume.cycleId,
      attemptId: secondConsume.attemptId,
    });
    expect(completed.currentArtifactVersions).toEqual({
      "produce.v1.run": firstRunVersion.id,
    });
    await expect(runtime.recover(runRoot)).resolves.toEqual(completed);
  });

  it("rejects an undeclared artifact update before mutation", async () => {
    const runtime = createWorkflowRuntime();
    const started = await runtime.start({
      protocol: carryArtifactWorkflow(),
      runRoot,
      runId: "undeclared-artifact-run",
    });
    await fs.writeFile(path.join(runRoot, "result.txt"), "result\n");
    const before = await committedEvidence(runRoot);

    const blocked = await runtime.submit(runRoot, {
      actionId: started.pendingAction!.id,
      nodeId: "produce",
      status: "succeeded",
      summary: "Attempted an undeclared update.",
      evidence: { summary: "present" },
      artifacts: { undeclared: "result.txt" },
    });

    expect(blocked).toMatchObject({
      disposition: "blocked",
      revision: started.revision,
      attemptId: started.attemptId,
      pendingAction: started.pendingAction,
      artifactVersions: [],
      blockers: [expect.stringContaining("artifact id is not declared")],
    });
    expect(await committedEvidence(runRoot)).toEqual(before);
  });

  it("rejects artifact lifetime declarations without their capability", async () => {
    const protocol = artifactWorkflow();
    protocol.capabilities!.features = protocol.capabilities!.features.filter(
      (feature) => feature !== "versioned-artifacts",
    );

    await expect(
      createWorkflowRuntime().start({
        protocol,
        runRoot,
        runId: "missing-artifact-capability-run",
      }),
    ).rejects.toThrow("requires versioned-artifacts capability");
    await expect(
      fs.access(path.join(runRoot, ".badger")),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rejects a Cycle-persistent update outside a declared Cycle", async () => {
    const runtime = createWorkflowRuntime();
    const started = await runtime.start({
      protocol: carryArtifactWorkflow("cycle"),
      runRoot,
      runId: "incompatible-lifetime-run",
    });
    await fs.writeFile(path.join(runRoot, "result.txt"), "result\n");
    const before = await committedEvidence(runRoot);

    const blocked = await runtime.submit(runRoot, {
      actionId: started.pendingAction!.id,
      nodeId: "produce",
      status: "succeeded",
      summary: "Attempted an incompatible update.",
      evidence: { summary: "present" },
      artifacts: { result: "result.txt" },
    });

    expect(blocked).toMatchObject({
      disposition: "blocked",
      revision: started.revision,
      pendingAction: started.pendingAction,
      blockers: [
        expect.stringContaining(
          "Cycle-persistent artifact update requires a current Cycle",
        ),
      ],
    });
    expect(await committedEvidence(runRoot)).toEqual(before);
  });

  it("rejects stale references and physical content drift before carry-forward", async () => {
    const runtime = createWorkflowRuntime();
    const started = await runtime.start({
      protocol: carryArtifactWorkflow(),
      runRoot,
      runId: "stale-artifact-run",
    });
    await fs.writeFile(path.join(runRoot, "result.txt"), "captured\n");
    const consuming = await runtime.submit(runRoot, {
      actionId: started.pendingAction!.id,
      nodeId: "produce",
      status: "succeeded",
      summary: "Captured the Run artifact.",
      evidence: { summary: "captured" },
      artifacts: { result: "result.txt" },
    });
    const version = consuming.artifactVersions[0];
    const before = await committedEvidence(runRoot);

    const stale = await runtime.submit(runRoot, {
      actionId: consuming.pendingAction!.id,
      nodeId: "consume",
      status: "succeeded",
      summary: "Selected an unknown version.",
      artifactVersions: { result: "artifact-version-unknown" },
    });
    expect(stale).toMatchObject({
      disposition: "blocked",
      revision: consuming.revision,
      pendingAction: consuming.pendingAction,
      blockers: [expect.stringContaining("artifact version is unknown")],
    });
    expect(await committedEvidence(runRoot)).toEqual(before);

    await fs.writeFile(path.join(runRoot, "result.txt"), "changed\n");
    const drifted = await runtime.submit(runRoot, {
      actionId: consuming.pendingAction!.id,
      nodeId: "consume",
      status: "succeeded",
      summary: "Selected drifted content.",
      artifactVersions: { result: version.id },
    });
    expect(drifted).toMatchObject({
      disposition: "blocked",
      revision: consuming.revision,
      pendingAction: consuming.pendingAction,
      blockers: [expect.stringContaining("artifact content drift detected")],
    });
    expect(await committedEvidence(runRoot)).toEqual(before);
  });

  it("does not carry an Attempt-scoped version into a later Attempt", async () => {
    const runtime = createWorkflowRuntime();
    const started = await runtime.start({
      protocol: carryArtifactWorkflow("attempt"),
      runRoot,
      runId: "attempt-artifact-run",
    });
    const attemptPath = `artifacts/${started.attemptId}/result.txt`;
    await fs.mkdir(path.dirname(path.join(runRoot, attemptPath)), {
      recursive: true,
    });
    await fs.writeFile(path.join(runRoot, attemptPath), "attempt\n");
    const consuming = await runtime.submit(runRoot, {
      actionId: started.pendingAction!.id,
      nodeId: "produce",
      status: "succeeded",
      summary: "Captured the Attempt artifact.",
      evidence: { summary: "captured" },
      artifacts: { result: attemptPath },
    });
    const before = await committedEvidence(runRoot);

    const blocked = await runtime.submit(runRoot, {
      actionId: consuming.pendingAction!.id,
      nodeId: "consume",
      status: "succeeded",
      summary: "Attempted stale carry-forward.",
      artifactVersions: { result: consuming.artifactVersions[0].id },
    });

    expect(blocked).toMatchObject({
      disposition: "blocked",
      revision: consuming.revision,
      pendingAction: consuming.pendingAction,
      blockers: [expect.stringContaining("stale for this Attempt")],
    });
    expect(await committedEvidence(runRoot)).toEqual(before);
  });

  it("keeps version capture bounded and rejects symbolic-link paths", async () => {
    const runtime = createWorkflowRuntime();
    const started = await runtime.start({
      protocol: carryArtifactWorkflow(),
      runRoot,
      runId: "protected-artifact-run",
    });
    const resultPath = path.join(runRoot, "result.txt");
    await fs.writeFile(resultPath, Buffer.alloc(2 * 1024 * 1024 + 1, "x"));
    const before = await committedEvidence(runRoot);

    const oversized = await runtime.submit(runRoot, {
      actionId: started.pendingAction!.id,
      nodeId: "produce",
      status: "succeeded",
      summary: "Attempted oversized capture.",
      evidence: { summary: "present" },
      artifacts: { result: "result.txt" },
    });
    expect(oversized).toMatchObject({
      disposition: "blocked",
      pendingAction: started.pendingAction,
      artifactVersions: [],
      blockers: [expect.stringContaining("exceeds 2097152 bytes")],
    });
    expect(await committedEvidence(runRoot)).toEqual(before);

    if (process.platform !== "win32") {
      const outside = path.join(root, "outside.txt");
      await fs.writeFile(outside, "outside\n");
      await fs.rm(resultPath);
      await fs.symlink(outside, resultPath);
      await expect(
        runtime.submit(runRoot, {
          actionId: started.pendingAction!.id,
          nodeId: "produce",
          status: "succeeded",
          summary: "Attempted linked capture.",
          evidence: { summary: "present" },
          artifacts: { result: "result.txt" },
        }),
      ).rejects.toThrow("crosses a symbolic link");
      expect(await committedEvidence(runRoot)).toEqual(before);
    }
  });

  it("bounds wildcard fan-out before version capture", async () => {
    const protocol = carryArtifactWorkflow();
    protocol.outputSchemas[0].artifacts[0].paths = ["outputs/*.txt"];
    const runtime = createWorkflowRuntime();
    const started = await runtime.start({
      protocol,
      runRoot,
      runId: "artifact-fanout-run",
    });
    const outputs = path.join(runRoot, "outputs");
    await fs.mkdir(outputs);
    await Promise.all(
      Array.from({ length: 257 }, (_, index) =>
        fs.writeFile(
          path.join(outputs, `${String(index).padStart(3, "0")}.txt`),
          "bounded\n",
        ),
      ),
    );
    const before = await committedEvidence(runRoot);

    await expect(
      runtime.submit(runRoot, {
        actionId: started.pendingAction!.id,
        nodeId: "produce",
        status: "succeeded",
        summary: "Attempted unbounded fan-out.",
        evidence: { summary: "present" },
        artifacts: { result: "outputs/000.txt" },
      }),
    ).rejects.toThrow("exceeds 256 matching paths");
    expect(await committedEvidence(runRoot)).toEqual(before);
  });

  it("keeps version identities equivalent across manual and standalone Runs", async () => {
    const runtime = createWorkflowRuntime();
    const runId = "artifact-location-run";
    const manual: WorkflowRunLocation = {
      kind: "manual",
      runRoot: path.join(root, "manual"),
    };
    const standalone: WorkflowRunLocation = {
      kind: "standalone",
      projectRoot: path.join(root, "standalone"),
      runId,
    };
    await fs.mkdir(manual.runRoot);
    const protocol = carryArtifactWorkflow();
    const manualStarted = await runtime.start({
      protocol,
      location: manual,
      runId,
    });
    const standaloneStarted = await runtime.start({
      protocol,
      location: standalone,
    });
    for (const location of [manual, standalone]) {
      await fs.writeFile(
        path.join(runRootFor(location), "result.txt"),
        "same\n",
      );
    }

    const manualConsume = await runtime.submit(manual, {
      actionId: manualStarted.pendingAction!.id,
      nodeId: "produce",
      status: "succeeded",
      summary: "Captured the artifact.",
      evidence: { summary: "captured" },
      artifacts: { result: "result.txt" },
    });
    const standaloneConsume = await runtime.submit(standalone, {
      actionId: standaloneStarted.pendingAction!.id,
      nodeId: "produce",
      status: "succeeded",
      summary: "Captured the artifact.",
      evidence: { summary: "captured" },
      artifacts: { result: "result.txt" },
    });
    expect(artifactProjection(standaloneConsume)).toEqual(
      artifactProjection(manualConsume),
    );

    const manualCompleted = await runtime.submit(manual, {
      actionId: manualConsume.pendingAction!.id,
      nodeId: "consume",
      status: "succeeded",
      summary: "Consumed the exact version.",
      artifactVersions: {
        result: manualConsume.artifactVersions[0].id,
      },
    });
    const standaloneCompleted = await runtime.submit(standalone, {
      actionId: standaloneConsume.pendingAction!.id,
      nodeId: "consume",
      status: "succeeded",
      summary: "Consumed the exact version.",
      artifactVersions: {
        result: standaloneConsume.artifactVersions[0].id,
      },
    });
    expect(artifactProjection(standaloneCompleted)).toEqual(
      artifactProjection(manualCompleted),
    );
    await expect(runtime.recover(manual)).resolves.toEqual(manualCompleted);
    await expect(runtime.recover(standalone)).resolves.toEqual(
      standaloneCompleted,
    );
  });

  it("recovers exact artifact ledgers in fresh processes for both locations", async () => {
    const runtime = createWorkflowRuntime();
    const protocol = carryArtifactWorkflow();
    const locations: WorkflowRunLocation[] = [
      { kind: "manual", runRoot: path.join(root, "fresh-manual") },
      {
        kind: "standalone",
        projectRoot: path.join(root, "fresh-standalone"),
        runId: "fresh-artifact-run",
      },
    ];
    await fs.mkdir((locations[0] as { runRoot: string }).runRoot);
    for (const [index, location] of locations.entries()) {
      const runId =
        location.kind === "standalone"
          ? location.runId
          : `fresh-artifact-run-${index}`;
      const started = await runtime.start(
        location.kind === "standalone"
          ? { protocol, location }
          : { protocol, location, runId },
      );
      await fs.writeFile(
        path.join(runRootFor(location), "result.txt"),
        "fresh\n",
      );
      const consuming = await runtime.submit(location, {
        actionId: started.pendingAction!.id,
        nodeId: "produce",
        status: "succeeded",
        summary: "Captured for fresh recovery.",
        evidence: { summary: "captured" },
        artifacts: { result: "result.txt" },
      });
      await recoverArtifactsInFreshProcess(location, consuming);
    }
  });

  it("rejects a persisted artifact version with an unknown producer", async () => {
    const runtime = createWorkflowRuntime();
    const started = await runtime.start({
      protocol: carryArtifactWorkflow(),
      runRoot,
      runId: "unknown-producer-run",
    });
    await fs.writeFile(path.join(runRoot, "result.txt"), "producer\n");
    await runtime.submit(runRoot, {
      actionId: started.pendingAction!.id,
      nodeId: "produce",
      status: "succeeded",
      summary: "Captured the producer.",
      evidence: { summary: "captured" },
      artifacts: { result: "result.txt" },
    });
    const statePath = path.join(runRoot, ".badger", "run-state.json");
    const state = JSON.parse(await fs.readFile(statePath, "utf8")) as {
      workflowRuntime: {
        artifactVersions: Array<{
          producer: { attemptId: string };
        }>;
      };
    };
    state.workflowRuntime.artifactVersions[0].producer.attemptId =
      "attempt-unknown";
    await fs.writeFile(statePath, JSON.stringify(state, null, 2) + "\n");

    await expect(runtime.recover(runRoot)).rejects.toThrow(
      "artifact producer is invalid",
    );
  });

  it("projects and forwards artifact versions through generated adapters", async () => {
    const protocol = carryArtifactWorkflow();
    const projectRoot = path.join(root, "generated-project");
    const generated = await generatePackage({
      proposal: {
        schemaVersion: 1,
        name: protocol.name,
        goal: protocol.goal,
        intent: "new-skill",
        planHash: "artifact-plan",
        workflow: protocol as unknown as WorkflowInput,
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
    const generatedRunRoot = path.join(projectRoot, "run");
    const run = (script: string, args: string[]) =>
      execFileAsync(process.execPath, [script, ...args], {
        cwd: projectRoot,
        env: process.env,
      });

    await run(stateScript, [
      "init",
      "--run-root",
      generatedRunRoot,
      "--run-id",
      "generated-artifact-run",
    ]);
    await fs.writeFile(
      path.join(generatedRunRoot, "result.txt"),
      "generated\n",
    );
    const consuming = JSON.parse(
      (
        await run(stateScript, [
          "record",
          "produce",
          JSON.stringify({
            summary: "Generated artifact.",
            artifacts: { result: "result.txt" },
          }),
          "--run-root",
          generatedRunRoot,
          "--json",
        ])
      ).stdout,
    ) as WorkflowContinuation;
    expect(consuming).toMatchObject({
      currentNode: "consume",
      artifactVersions: [
        expect.objectContaining({ artifactId: "produce.v1.result" }),
      ],
    });

    const completed = JSON.parse(
      (
        await run(guardScript, [
          "exit",
          "consume",
          JSON.stringify({
            summary: "Consumed generated artifact.",
            artifactVersions: {
              result: consuming.artifactVersions[0].id,
            },
          }),
          "--run-root",
          generatedRunRoot,
          "--apply",
          "--json",
        ])
      ).stdout,
    ) as WorkflowContinuation;
    expect(completed).toMatchObject({
      disposition: "done",
      artifactVersions: consuming.artifactVersions,
      currentArtifactVersions: {
        "produce.v1.result": consuming.artifactVersions[0].id,
      },
    });
    expect(completed.artifactSelections).toHaveLength(2);
    expect(completed.artifactSelections[1]).toMatchObject({
      nodeId: "consume",
      versionId: consuming.artifactVersions[0].id,
    });

    const handoff = JSON.parse(
      (await run(handoffScript, ["--run-root", generatedRunRoot, "--json"]))
        .stdout,
    ) as {
      artifactVersions: unknown[];
      artifactSelections: unknown[];
      currentArtifactVersions: Record<string, string>;
    };
    expect(handoff.artifactVersions).toHaveLength(1);
    expect(handoff.artifactSelections).toHaveLength(2);
    expect(handoff.currentArtifactVersions).toEqual(
      completed.currentArtifactVersions,
    );

    for (const script of [stateScript, guardScript, handoffScript]) {
      const source = await fs.readFile(script, "utf8");
      expect(source).not.toContain("artifact-version-");
      expect(source).not.toContain("prepareWorkflowArtifactMutation");
      expect(source).not.toContain("createHash");
      expect(source).not.toContain("latestArtifact");
    }
  });
});
