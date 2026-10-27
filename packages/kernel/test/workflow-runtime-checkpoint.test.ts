import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { normalizeWorkflow } from "../src/workflow/contract.js";
import { createWorkflowRuntime } from "../src/workflow-runtime/public.js";
import {
  clearWorkflowCheckpointFaultForTests,
  readWorkflowCheckpointIndex,
  readWorkflowCheckpointManifest,
  readWorkflowCheckpointRecord,
  readWorkflowCheckpointRecoveryJournal,
  setWorkflowCheckpointFaultForTests,
} from "../src/workflow-runtime/checkpoints.js";
import type { WorkflowInput, WorkflowProtocol } from "../src/types.js";
import {
  clearWorkflowTransitionFaultForTests,
  setWorkflowTransitionFaultForTests,
} from "../src/workflow-runtime/transition-journal.js";
import { vitestCli } from "./fixtures/vitest-cli.js";

const execFileAsync = promisify(execFile);

const checkpointProfile = {
  version: 1,
  capabilities: [
    "mutation-locks",
    "revision-fences",
    "transition-journal",
    "verified-checkpoints",
  ],
  bounds: {
    runStateBytes: 256 * 1024,
    pendingActionBytes: 256 * 1024,
    trajectoryBytes: 8 * 1024 * 1024,
    artifactsBytes: 1024 * 1024,
    claimBytes: 16 * 1024,
    transitionJournalBytes: 1024 * 1024,
    runLockBytes: 16 * 1024,
    checkpointManifestBytes: 256 * 1024,
    checkpointRecordBytes: 256 * 1024,
    checkpointCount: 8,
  },
  schemaVersions: {
    runState: 1,
    pendingAction: 1,
    trajectory: 1,
    artifacts: 1,
    revisionClaim: 1,
    transitionJournal: 1,
    runLock: 1,
    checkpointManifest: 1,
    checkpointRecord: 1,
  },
  findingCatalogVersion: 1,
} as const;

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

function protocol(checkpointCount = 8): WorkflowProtocol {
  const profile = {
    ...checkpointProfile,
    bounds: { ...checkpointProfile.bounds, checkpointCount },
  };
  return normalizeWorkflow({
    kind: "workflow-kernel",
    name: "checkpoint-workflow",
    goal: "Verify durable checkpoints.",
    customNodes: [node("prepare"), node("finish")],
    capabilities: {
      version: 3,
      features: ["conditional-routing", "revisioned-attempts"],
      durability: structuredClone(profile),
    },
  }).protocol;
}

function artifactProtocol(): WorkflowProtocol {
  const prepare = node("prepare");
  prepare.outputSchemas = ["prepare-output"];
  return normalizeWorkflow({
    kind: "workflow-kernel",
    name: "checkpoint-artifact-workflow",
    goal: "Verify checkpoint artifact identities.",
    customNodes: [prepare, node("finish")],
    outputSchemas: [
      {
        id: "prepare-output",
        description: "Preparation output.",
        artifacts: [
          {
            id: "result",
            kind: "file",
            required: true,
            paths: ["artifacts/*/result.txt"],
            validations: ["artifact-exists"],
          },
        ],
        evidence: [],
      },
    ],
    capabilities: {
      version: 3,
      features: [
        "conditional-routing",
        "revisioned-attempts",
        "versioned-artifacts",
      ],
      durability: structuredClone(checkpointProfile),
    },
  }).protocol;
}

describe("WorkflowRuntime verified checkpoints", () => {
  let root: string;
  let runRoot: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(
      path.join(os.tmpdir(), "badger-workflow-checkpoint-"),
    );
    runRoot = path.join(root, "change");
    await fs.mkdir(runRoot);
  });

  afterEach(async () => {
    clearWorkflowCheckpointFaultForTests();
    clearWorkflowTransitionFaultForTests();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("publishes committed content-addressed checkpoint evidence", async () => {
    const runtime = createWorkflowRuntime();
    const started = await runtime.start({
      protocol: protocol(),
      runRoot,
      runId: "checkpoint-run",
    });
    const advanced = await runtime.submit(runRoot, {
      actionId: started.pendingAction!.id,
      runId: started.runId,
      revision: started.revision,
      nodeId: started.currentNode!,
      execution: started.execution,
      status: "succeeded",
      summary: "Prepared.",
    });

    const index = await readWorkflowCheckpointIndex(runRoot, checkpointProfile);
    expect(index?.records.map((record) => record.revision)).toEqual([1, 0]);
    expect(
      index?.records.every((record) =>
        /^[a-f0-9]{64}$/u.test(record.recordHash),
      ),
    ).toBe(true);

    const latest = await readWorkflowCheckpointManifest(
      runRoot,
      checkpointProfile,
      index!.records[0],
    );
    expect(latest).toMatchObject({
      kind: "workflow-checkpoint-manifest",
      manifestHash: index!.records[0].manifestHash,
      runId: started.runId,
      revision: advanced.revision,
      nodeId: advanced.currentNode,
      cycleId: advanced.cycleId,
      attemptId: advanced.attemptId,
      execution: advanced.execution,
      pendingAction: { id: advanced.pendingAction!.id },
      trajectory: {
        offset: expect.any(Number),
        prefixSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      },
    });
    expect(index!.records[0].recordHash).toEqual(
      (
        await readWorkflowCheckpointRecord(
          runRoot,
          checkpointProfile,
          index!.records[0],
        )
      ).recordHash,
    );
    expect(latest).not.toHaveProperty("state.content");
    expect(latest).not.toHaveProperty("pendingAction.content");
    expect(latest).not.toHaveProperty("artifacts.content");
    expect(await runtime.recover(runRoot)).toEqual(advanced);
  });

  it("does not publish checkpoint state for an interrupted transition", async () => {
    setWorkflowTransitionFaultForTests({
      phase: "record-write",
      path: ".badger/run-state.json",
    });

    await expect(
      createWorkflowRuntime().start({
        protocol: protocol(),
        runRoot,
        runId: "partial-transition-run",
      }),
    ).rejects.toThrow("deterministic workflow transition fault");

    await expect(
      readWorkflowCheckpointIndex(runRoot, checkpointProfile),
    ).resolves.toBeNull();
  });

  it("backfills a checkpoint when recovery follows a cleared transition journal", async () => {
    setWorkflowTransitionFaultForTests({ phase: "journal-cleared" });
    const runtime = createWorkflowRuntime();

    const startedPromise = runtime.start({
      protocol: protocol(),
      runRoot,
      runId: "cleared-journal-run",
    });
    await expect(startedPromise).rejects.toThrow(
      "deterministic workflow transition fault",
    );
    await expect(
      readWorkflowCheckpointIndex(runRoot, checkpointProfile),
    ).resolves.toBeNull();
    clearWorkflowTransitionFaultForTests();

    const recovered = await runtime.recover(runRoot);

    expect(recovered.pendingAction).not.toBeNull();
    await expect(
      readWorkflowCheckpointIndex(runRoot, checkpointProfile),
    ).resolves.toMatchObject({ records: [{ revision: 0 }] });
  });

  it("prefers the verified authoritative head and reports invalid checkpoint history", async () => {
    const runtime = createWorkflowRuntime();
    const started = await runtime.start({
      protocol: protocol(),
      runRoot,
      runId: "authoritative-head-run",
    });
    const current = await runtime.submit(runRoot, {
      actionId: started.pendingAction!.id,
      runId: started.runId,
      revision: started.revision,
      nodeId: started.currentNode!,
      execution: started.execution,
      status: "succeeded",
      summary: "Prepared.",
    });
    const index = await readWorkflowCheckpointIndex(runRoot, checkpointProfile);
    const latestPath = path.join(
      runRoot,
      ".badger",
      "checkpoints",
      "manifests",
      `${index!.records[0].manifestHash}.json`,
    );
    const latest = JSON.parse(await fs.readFile(latestPath, "utf8")) as Record<
      string,
      unknown
    >;
    latest.revision = 99;
    await fs.writeFile(latestPath, JSON.stringify(latest, null, 2) + "\n");

    const recovered = await runtime.recover(runRoot);

    expect(recovered.revision).toBe(current.revision);
    expect(recovered.pendingAction).toEqual(current.pendingAction);
    expect(recovered.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "checkpoint-invalid",
          severity: "warning",
        }),
      ]),
    );
  });

  it("blocks instead of silently ignoring a newer verified checkpoint", async () => {
    const runtime = createWorkflowRuntime();
    const started = await runtime.start({
      protocol: protocol(),
      runRoot,
      runId: "newer-checkpoint-run",
    });
    const advanced = await runtime.submit(runRoot, {
      actionId: started.pendingAction!.id,
      runId: started.runId,
      revision: started.revision,
      nodeId: started.currentNode!,
      execution: started.execution,
      status: "succeeded",
      summary: "Prepared.",
    });
    const index = await readWorkflowCheckpointIndex(runRoot, checkpointProfile);
    const older = index!.records.find(
      (record) => record.revision === started.revision,
    )!;
    const olderRecord = await readWorkflowCheckpointRecord(
      runRoot,
      checkpointProfile,
      older,
    );
    for (const reference of [
      olderRecord.state,
      olderRecord.pendingAction,
      olderRecord.artifacts,
      olderRecord.trajectory,
    ]) {
      if (!reference.contentPath) {
        await fs.rm(path.join(runRoot, reference.path), { force: true });
        continue;
      }
      const content = await fs.readFile(
        path.join(runRoot, reference.contentPath),
        "utf8",
      );
      await fs.writeFile(path.join(runRoot, reference.path), content);
    }

    const blocked = await runtime.recover(runRoot);

    expect(blocked).toMatchObject({
      disposition: "blocked",
      revision: started.revision,
      pendingAction: started.pendingAction,
      findings: expect.arrayContaining([
        expect.objectContaining({ code: "checkpoint-history-ambiguous" }),
      ]),
    });
    expect(advanced.revision).toBe(1);
  });

  it("retains only the newest bounded revisions", async () => {
    const runtime = createWorkflowRuntime();
    const started = await runtime.start({
      protocol: protocol(2),
      runRoot,
      runId: "retention-run",
    });
    const advanced = await runtime.submit(runRoot, {
      actionId: started.pendingAction!.id,
      runId: started.runId,
      revision: started.revision,
      nodeId: started.currentNode!,
      execution: started.execution,
      status: "succeeded",
      summary: "Prepared.",
    });
    await runtime.submit(runRoot, {
      actionId: advanced.pendingAction!.id,
      runId: advanced.runId,
      revision: advanced.revision,
      nodeId: advanced.currentNode!,
      execution: advanced.execution,
      status: "succeeded",
      summary: "Finished.",
    });

    const index = await readWorkflowCheckpointIndex(runRoot, {
      ...checkpointProfile,
      bounds: { ...checkpointProfile.bounds, checkpointCount: 2 },
    });

    expect(index?.records.map((record) => record.revision)).toEqual([2, 1]);
    await expect(
      readWorkflowCheckpointRecord(
        runRoot,
        {
          ...checkpointProfile,
          bounds: { ...checkpointProfile.bounds, checkpointCount: 2 },
        },
        {
          recordHash: index!.records[1].recordHash,
          manifestHash: index!.records[1].manifestHash,
          revision: 1,
        },
      ),
    ).resolves.toBeDefined();
  });

  it("restores an older verified checkpoint only with proof of no later transition", async () => {
    const runtime = createWorkflowRuntime();
    const started = await runtime.start({
      protocol: protocol(),
      runRoot,
      runId: "fallback-run",
    });
    await runtime.submit(runRoot, {
      actionId: started.pendingAction!.id,
      runId: started.runId,
      revision: started.revision,
      nodeId: started.currentNode!,
      execution: started.execution,
      status: "succeeded",
      summary: "Prepared.",
    });
    const index = await readWorkflowCheckpointIndex(runRoot, checkpointProfile);
    const older = index!.records.at(-1)!;
    const olderRecord = await readWorkflowCheckpointRecord(
      runRoot,
      checkpointProfile,
      older,
    );
    const olderTrajectory = await fs.readFile(
      path.join(runRoot, olderRecord.trajectory.contentPath!),
      "utf8",
    );
    await fs.writeFile(
      path.join(runRoot, ".badger", "trajectory.jsonl"),
      olderTrajectory,
    );
    await fs.writeFile(
      path.join(runRoot, ".badger", "run-state.json"),
      "{not-a-run-state}\n",
    );
    const latestPath = path.join(
      runRoot,
      ".badger",
      "checkpoints",
      "manifests",
      `${index!.records[0].manifestHash}.json`,
    );
    const latest = JSON.parse(await fs.readFile(latestPath, "utf8")) as Record<
      string,
      unknown
    >;
    latest.revision = 99;
    await fs.writeFile(latestPath, JSON.stringify(latest, null, 2) + "\n");

    const recovered = await runtime.recover(runRoot);

    expect(recovered).toMatchObject({
      disposition: "continue",
      revision: 0,
      pendingAction: { id: started.pendingAction!.id },
    });
    expect(recovered.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "checkpoint-invalid" }),
      ]),
    );
    const trajectory = await fs.readFile(
      path.join(runRoot, ".badger", "trajectory.jsonl"),
      "utf8",
    );
    expect(
      trajectory
        .split("\n")
        .filter((line) => line.includes('"type":"recovery_reconciled"')),
    ).toHaveLength(1);
  });

  it("restores the same checkpoint continuation in a fresh process", async () => {
    const runtime = createWorkflowRuntime();
    const started = await runtime.start({
      protocol: protocol(),
      runRoot,
      runId: "fresh-process-run",
    });
    const index = await readWorkflowCheckpointIndex(runRoot, checkpointProfile);
    const checkpoint = await readWorkflowCheckpointRecord(
      runRoot,
      checkpointProfile,
      index!.records[0],
    );
    await fs.writeFile(
      path.join(runRoot, ".badger", "trajectory.jsonl"),
      await fs.readFile(
        path.join(runRoot, checkpoint.trajectory.contentPath!),
        "utf8",
      ),
    );
    await fs.writeFile(
      path.join(runRoot, ".badger", "run-state.json"),
      "{not-a-run-state}\n",
    );

    const childTest = path.join(
      process.cwd(),
      "test",
      `workflow-checkpoint-fresh-${Date.now()}.test.ts`,
    );
    const sourceEntry = path.resolve("src/workflow-runtime/public.ts");
    const configPath = path.resolve("vitest.config.ts");
    try {
      await fs.writeFile(
        childTest,
        `import { expect, it } from "vitest";
import { createWorkflowRuntime } from ${JSON.stringify(sourceEntry)};

it("recovers the checkpoint in a new process", async () => {
  const continuation = await createWorkflowRuntime().recover(
    JSON.parse(process.env.WORKFLOW_RUN_ROOT!),
  );
  expect(continuation).toMatchObject(
    JSON.parse(process.env.WORKFLOW_EXPECTED!),
  );
});
`,
      );
      await execFileAsync(
        process.execPath,
        [vitestCli, "run", "--config", configPath, childTest],
        {
          cwd: process.cwd(),
          env: {
            PATH: process.env.PATH,
            WORKFLOW_RUN_ROOT: JSON.stringify(runRoot),
            WORKFLOW_EXPECTED: JSON.stringify({
              revision: started.revision,
              pendingAction: started.pendingAction,
            }),
          },
        },
      );
    } finally {
      await fs.rm(childTest, { force: true });
    }
  });

  it("requires explicit recovery after an interrupted checkpoint restore", async () => {
    const runtime = createWorkflowRuntime();
    const started = await runtime.start({
      protocol: protocol(),
      runRoot,
      runId: "checkpoint-restore-journal-run",
    });
    const index = await readWorkflowCheckpointIndex(runRoot, checkpointProfile);
    const checkpoint = await readWorkflowCheckpointRecord(
      runRoot,
      checkpointProfile,
      index!.records[0],
    );
    await fs.writeFile(
      path.join(runRoot, ".badger", "trajectory.jsonl"),
      await fs.readFile(
        path.join(runRoot, checkpoint.trajectory.contentPath!),
        "utf8",
      ),
    );
    await fs.writeFile(
      path.join(runRoot, ".badger", "run-state.json"),
      "{not-a-run-state}\n",
    );
    setWorkflowCheckpointFaultForTests(({ phase, path: boundaryPath }) => {
      if (
        phase === "checkpoint-recovery-record-write" &&
        boundaryPath === ".badger/run-state.json"
      ) {
        throw new Error("deterministic workflow checkpoint fault");
      }
    });

    const interrupted = await runtime.recover(runRoot);
    expect(interrupted).toMatchObject({
      disposition: "blocked",
      findings: expect.arrayContaining([
        expect.objectContaining({ code: "checkpoint-history-ambiguous" }),
      ]),
    });
    await expect(
      readWorkflowCheckpointRecoveryJournal(runRoot),
    ).resolves.toEqual(expect.objectContaining({ status: "prepared" }));
    const blocked = await runtime.resume(runRoot);
    expect(blocked).toMatchObject({
      disposition: "blocked",
      findings: expect.arrayContaining([
        expect.objectContaining({ code: "recovery-required" }),
      ]),
    });

    clearWorkflowCheckpointFaultForTests();
    const recovered = await runtime.recover(runRoot);

    expect(recovered).toMatchObject({
      disposition: "continue",
      revision: started.revision,
      pendingAction: started.pendingAction,
    });
    await expect(
      readWorkflowCheckpointRecoveryJournal(runRoot),
    ).resolves.toBeNull();
  });

  it("blocks recovery when a committed artifact has drifted", async () => {
    const runtime = createWorkflowRuntime();
    const started = await runtime.start({
      protocol: artifactProtocol(),
      runRoot,
      runId: "artifact-drift-run",
    });
    const artifactPath = path.join(
      runRoot,
      "artifacts",
      started.attemptId!,
      "result.txt",
    );
    await fs.mkdir(path.dirname(artifactPath), { recursive: true });
    await fs.writeFile(artifactPath, "original\n");
    await runtime.submit(runRoot, {
      actionId: started.pendingAction!.id,
      runId: started.runId,
      revision: started.revision,
      nodeId: started.currentNode!,
      execution: started.execution,
      status: "succeeded",
      summary: "Prepared.",
      artifacts: {
        "prepare-output.result": `artifacts/${started.attemptId}/result.txt`,
      },
    });
    const index = await readWorkflowCheckpointIndex(runRoot, checkpointProfile);
    const manifest = await readWorkflowCheckpointManifest(
      runRoot,
      checkpointProfile,
      index!.records[0],
    );
    expect(manifest.artifactVersions).toEqual([
      expect.objectContaining({
        artifactId: "prepare-output.result",
        contentHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
        bytes: Buffer.byteLength("original\n", "utf8"),
      }),
    ]);
    await fs.writeFile(artifactPath, "changed\n");

    const blocked = await runtime.recover(runRoot);

    expect(blocked).toMatchObject({
      disposition: "blocked",
      findings: expect.arrayContaining([
        expect.objectContaining({ code: "checkpoint-invalid" }),
      ]),
    });
  });

  it.each(["manual", "standalone"] as const)(
    "uses the same checkpoint recovery for %s Runs",
    async (locationKind) => {
      const runtime = createWorkflowRuntime();
      const location =
        locationKind === "manual"
          ? { kind: "manual" as const, runRoot }
          : {
              kind: "standalone" as const,
              projectRoot: root,
              runId: "location-run",
            };
      const started = await runtime.start(
        locationKind === "manual"
          ? { protocol: protocol(), location, runId: "location-run" }
          : { protocol: protocol(), location },
      );
      const recoveredLocation =
        locationKind === "manual"
          ? runRoot
          : path.join(root, ".badger", "runs", "location-run");
      await fs.writeFile(
        path.join(recoveredLocation, ".badger", "run-state.json"),
        "{not-a-run-state}\n",
      );

      const recovered = await runtime.recover(location);

      expect(recovered).toMatchObject({
        disposition: "continue",
        runId: started.runId,
        revision: started.revision,
        pendingAction: started.pendingAction,
      });
    },
  );

  it("blocks an older fallback when later trajectory evidence remains", async () => {
    const runtime = createWorkflowRuntime();
    const started = await runtime.start({
      protocol: protocol(),
      runRoot,
      runId: "ambiguous-history-run",
    });
    await runtime.submit(runRoot, {
      actionId: started.pendingAction!.id,
      runId: started.runId,
      revision: started.revision,
      nodeId: started.currentNode!,
      execution: started.execution,
      status: "succeeded",
      summary: "Prepared.",
    });
    const index = await readWorkflowCheckpointIndex(runRoot, checkpointProfile);
    const latestPath = path.join(
      runRoot,
      ".badger",
      "checkpoints",
      "manifests",
      `${index!.records[0].manifestHash}.json`,
    );
    const latest = JSON.parse(await fs.readFile(latestPath, "utf8")) as Record<
      string,
      unknown
    >;
    latest.revision = 99;
    await fs.writeFile(latestPath, JSON.stringify(latest, null, 2) + "\n");
    await fs.writeFile(
      path.join(runRoot, ".badger", "run-state.json"),
      "{not-a-run-state}\n",
    );

    const blocked = await runtime.recover(runRoot);

    expect(blocked).toMatchObject({
      disposition: "blocked",
      findings: expect.arrayContaining([
        expect.objectContaining({ code: "checkpoint-history-ambiguous" }),
      ]),
    });
    expect(
      await fs.readFile(
        path.join(runRoot, ".badger", "run-state.json"),
        "utf8",
      ),
    ).toBe("{not-a-run-state}\n");
  });
});
