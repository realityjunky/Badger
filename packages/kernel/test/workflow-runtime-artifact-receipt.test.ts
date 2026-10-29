import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalizeWorkflow } from "../src/workflow/contract.js";
import {
  createWorkflowRuntime,
  type WorkflowContinuation,
} from "../src/workflow-runtime/public.js";
import type {
  ArtifactSchema,
  OutputSchema,
  WorkflowInput,
} from "../src/types.js";

function receiptWorkflow(
  externalRoot?: string,
  artifact: Partial<ArtifactSchema> = {},
) {
  const schema: OutputSchema = {
    id: "produce.v1",
    description: "The produced result.",
    ...(externalRoot ? { externalRoots: { outputs: externalRoot } } : {}),
    artifacts: [
      {
        id: "result",
        kind: "file",
        required: true,
        paths: ["result.bin"],
        validations: ["artifact-exists"],
        verification: "receipt",
        ...(externalRoot ? { root: "outputs" } : {}),
        ...artifact,
      },
    ],
    evidence: [],
  };
  const input: WorkflowInput = {
    kind: "workflow-kernel",
    name: "artifact-receipt-workflow",
    goal: "Verify outputs by receipt.",
    customNodes: [
      {
        id: "produce",
        label: "Produce",
        kind: "action",
        responsibility: "Produce the declared result.",
        implementation: {
          skill: "producer",
          operation: "default",
          scope: "main",
        },
        operations: ["require", "augment", "disable"],
        outputSchemas: [schema.id],
        guardrails: [],
      },
    ],
    outputSchemas: [schema],
  };
  return normalizeWorkflow(input).protocol;
}

function success(current: WorkflowContinuation) {
  return {
    runId: current.runId,
    revision: current.revision,
    execution: current.execution,
    actionId: current.pendingAction!.id,
    nodeId: current.currentNode,
    status: "succeeded" as const,
    summary: "Produced the result.",
  };
}

describe("WorkflowRuntime artifact receipts", () => {
  let root: string;
  let runRoot: string;
  let externalRoot: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "badger-artifact-receipt-"));
    runRoot = path.join(root, "run");
    externalRoot = path.join(root, "outputs");
    await fs.mkdir(externalRoot);
  });

  afterEach(async () => {
    vi.useRealTimers();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("records a large external artifact in accepted Completion evidence and recovers it", async () => {
    const runtime = createWorkflowRuntime();
    const started = await runtime.start({
      protocol: receiptWorkflow(externalRoot),
      runRoot,
      runId: "external-receipt",
    });
    const artifactPath = path.join(externalRoot, "result.bin");
    await fs.writeFile(artifactPath, Buffer.alloc(3 * 1024 * 1024, "a"));
    const stat = await fs.stat(artifactPath);

    const completed = await runtime.submit(runRoot, success(started));

    expect(completed.disposition).toBe("done");
    expect(completed.visits[0].outcomes[0].evidence?.artifactReceipts).toEqual([
      {
        artifactId: "produce.v1.result",
        path: artifactPath,
        size: 3 * 1024 * 1024,
        sha256:
          "6f850bc94ae6f7de14297c01616c36d712d22864497b28a63b81d776b035e656",
        mtimeMs: stat.mtimeMs,
        producer: {
          runId: started.runId,
          nodeId: "produce",
          cycleId: started.cycleId,
          attemptId: started.attemptId,
          actionId: started.pendingAction!.id,
          revision: started.revision,
        },
      },
    ]);
    expect((await runtime.recover(runRoot)).visits).toEqual(completed.visits);
  });

  it("refuses a stale output without advancing the Attempt, then accepts a fresh replacement", async () => {
    const artifactPath = path.join(externalRoot, "result.bin");
    await fs.writeFile(artifactPath, "old output\n");
    const oldTime = new Date("2000-01-01T00:00:00.000Z");
    await fs.utimes(artifactPath, oldTime, oldTime);
    const runtime = createWorkflowRuntime();
    const started = await runtime.start({
      protocol: receiptWorkflow(externalRoot, { requireCurrentAttempt: true }),
      runRoot,
      runId: "stale-receipt",
    });

    const refused = await runtime.submit(runRoot, {
      ...success(started),
      evidence: {
        artifactReceipts: [{ path: artifactPath, mtimeMs: Date.now() }],
      },
    });

    expect(refused).toMatchObject({
      disposition: "blocked",
      revision: started.revision,
      attemptId: started.attemptId,
      pendingAction: started.pendingAction,
      findings: expect.arrayContaining([
        expect.objectContaining({ code: "artifact-stale-attempt" }),
      ]),
    });
    expect((await runtime.resume(runRoot)).visits).toEqual(started.visits);
    await fs.writeFile(artifactPath, "fresh output\n");
    const completed = await runtime.submit(runRoot, success(started));
    expect(completed.disposition).toBe("done");
    expect(completed.visits[0].outcomes[0].evidence?.artifactReceipts).toEqual([
      expect.objectContaining({
        producer: expect.objectContaining({ attemptId: started.attemptId }),
      }),
    ]);
  });

  it.each([
    { root: "undeclared" },
    { verification: "content" as const, root: "outputs" },
    {
      verification: "content" as const,
      requireCurrentAttempt: true,
      root: undefined,
    },
    { paths: ["../outside.bin"] },
  ])(
    "refuses an unsafe receipt declaration before starting a Run: %j",
    async (artifact) => {
      const runtime = createWorkflowRuntime();
      const protocol = receiptWorkflow(externalRoot);
      Object.assign(protocol.outputSchemas[0].artifacts[0], artifact);
      await expect(
        runtime.start({
          protocol,
          runRoot,
          runId: "invalid-receipt",
        }),
      ).rejects.toThrow(/artifact|receipt/i);
    },
  );

  it("carries a large external receipt version forward and refuses later content drift", async () => {
    const protocol = receiptWorkflow(externalRoot, { lifetime: "run" });
    protocol.nodes.push({
      ...structuredClone(protocol.nodes[0]),
      id: "consume",
      label: "Consume",
      outputSchemas: ["produce.v1"],
    });
    protocol.edges = [
      { from: "produce", to: "consume", condition: "success" },
      { from: "consume", to: null, condition: "success" },
    ];
    protocol.routing = { transitions: protocol.edges };
    const runtime = createWorkflowRuntime();
    const started = await runtime.start({
      protocol,
      runRoot,
      runId: "versioned-receipt",
    });
    const artifactPath = path.join(externalRoot, "result.bin");
    await fs.writeFile(artifactPath, Buffer.alloc(3 * 1024 * 1024, "a"));
    const consuming = await runtime.submit(runRoot, {
      ...success(started),
      artifacts: { result: "result.bin" },
    });

    expect(consuming.currentNode).toBe("consume");
    const version = consuming.artifactVersions[0];
    expect(version).toMatchObject({
      path: "result.bin",
      receipt: {
        path: artifactPath,
        size: 3 * 1024 * 1024,
        sha256:
          "6f850bc94ae6f7de14297c01616c36d712d22864497b28a63b81d776b035e656",
        producer: { attemptId: started.attemptId },
      },
    });
    await fs.writeFile(artifactPath, "changed\n");
    const refused = await runtime.submit(runRoot, {
      ...success(consuming),
      artifactVersions: { result: version.id },
    });
    expect(refused).toMatchObject({
      disposition: "blocked",
      revision: consuming.revision,
      findings: expect.arrayContaining([
        expect.objectContaining({ code: "artifact-content-drift" }),
      ]),
    });
    await fs.writeFile(artifactPath, Buffer.alloc(3 * 1024 * 1024, "a"));
    const completed = await runtime.submit(runRoot, {
      ...success(consuming),
      artifactVersions: { result: version.id },
    });
    expect(completed.disposition).toBe("done");
    expect(completed.artifactVersions).toEqual(consuming.artifactVersions);
    expect(completed.visits[1].outcomes[0].evidence?.artifactReceipts).toEqual([
      version.receipt,
    ]);
    expect((await runtime.recover(runRoot)).artifactVersions).toEqual(
      completed.artifactVersions,
    );
  });

  it("receipts a directory of large outputs and refuses a stale retained file", async () => {
    const runtime = createWorkflowRuntime();
    const started = await runtime.start({
      protocol: receiptWorkflow(externalRoot, {
        kind: "directory",
        paths: ["bundle"],
        requireCurrentAttempt: true,
      }),
      runRoot,
      runId: "directory-receipt",
    });
    const directory = path.join(externalRoot, "bundle");
    await fs.mkdir(directory);
    await fs.writeFile(
      path.join(directory, "large.bin"),
      Buffer.alloc(3 * 1024 * 1024, "a"),
    );
    const retained = path.join(directory, "retained.txt");
    await fs.writeFile(retained, "old\n");
    const oldTime = new Date("2000-01-01T00:00:00.000Z");
    await fs.utimes(retained, oldTime, oldTime);
    const refused = await runtime.submit(runRoot, success(started));
    expect(refused.findings).toContainEqual(
      expect.objectContaining({ code: "artifact-stale-attempt" }),
    );
    await fs.writeFile(retained, "new\n");
    const completed = await runtime.submit(runRoot, success(started));
    expect(completed.disposition).toBe("done");
    expect(completed.visits[0].outcomes[0].evidence?.artifactReceipts).toEqual([
      expect.objectContaining({
        path: directory,
        size: 3 * 1024 * 1024 + 4,
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    ]);
  });

  it("bounds receipts across multiple declared patterns before recording evidence", async () => {
    await Promise.all(
      Array.from({ length: 257 }, (_, i) =>
        fs.writeFile(
          path.join(externalRoot, `${i < 128 ? "first" : "second"}-${i}.bin`),
          "x",
        ),
      ),
    );
    const runtime = createWorkflowRuntime();
    const started = await runtime.start({
      protocol: receiptWorkflow(externalRoot, {
        paths: ["first-*.bin", "second-*.bin"],
      }),
      runRoot,
      runId: "bounded-receipts",
    });
    const refused = await runtime.submit(runRoot, success(started));
    expect(refused.disposition).toBe("blocked");
    expect(refused.blockers.join(" ")).toContain("256");
    expect((await runtime.resume(runRoot)).visits).toEqual(started.visits);
  });

  it("checkpoints and recovers external receipt versions larger than the content budget", async () => {
    const protocol = receiptWorkflow(externalRoot, {
      lifetime: "run",
      requireCurrentAttempt: true,
    });
    protocol.capabilities!.durability = {
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
        trajectoryBytes: 2 * 1024 * 1024,
        artifactsBytes: 64 * 1024,
        claimBytes: 16 * 1024,
        transitionJournalBytes: 512 * 1024,
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
    };
    const runtime = createWorkflowRuntime();
    const started = await runtime.start({
      protocol,
      runRoot,
      runId: "checkpoint-receipt",
    });
    await fs.writeFile(
      path.join(externalRoot, "result.bin"),
      Buffer.alloc(3 * 1024 * 1024, "a"),
    );
    const completed = await runtime.submit(runRoot, {
      ...success(started),
      artifacts: { result: "result.bin" },
    });
    expect(completed.disposition).toBe("done");
    expect((await runtime.recover(runRoot)).artifactVersions).toEqual(
      completed.artifactVersions,
    );
  });

  it("retains the first Attempt's freshness boundary when retrying", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const epoch = Date.parse("2026-10-29T00:00:00.000Z");
    vi.setSystemTime(epoch);
    const runtime = createWorkflowRuntime();
    const started = await runtime.start({
      protocol: receiptWorkflow(externalRoot, { requireCurrentAttempt: true }),
      runRoot,
      runId: "retry-receipt",
    });
    const artifactPath = path.join(externalRoot, "result.bin");
    await fs.writeFile(artifactPath, "retry output\n");
    await fs.utimes(
      artifactPath,
      new Date(epoch + 1000),
      new Date(epoch + 1000),
    );
    vi.setSystemTime(epoch + 10_000);
    const retrying = await runtime.submit(runRoot, {
      ...success(started),
      status: "failed",
      summary: "Retry the work.",
    });
    expect(retrying.attemptId).toBe(started.attemptId);
    expect(retrying.retryOrdinal).toBe(1);
    expect((await runtime.submit(runRoot, success(retrying))).disposition).toBe(
      "done",
    );
  });

  it("refuses the prior Attempt's output when a later Node skips its work", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const epoch = Date.parse("2026-10-29T00:00:00.000Z");
    vi.setSystemTime(epoch);
    const protocol = receiptWorkflow(externalRoot, {
      requireCurrentAttempt: true,
    });
    protocol.nodes.push({
      ...structuredClone(protocol.nodes[0]),
      id: "produce-again",
    });
    protocol.edges = [
      { from: "produce", to: "produce-again", condition: "success" },
      { from: "produce-again", to: null, condition: "success" },
    ];
    protocol.routing = { transitions: protocol.edges };
    const runtime = createWorkflowRuntime();
    const started = await runtime.start({
      protocol,
      runRoot,
      runId: "later-attempt-receipt",
    });
    const artifactPath = path.join(externalRoot, "result.bin");
    await fs.writeFile(artifactPath, "first output\n");
    await fs.utimes(
      artifactPath,
      new Date(epoch + 1000),
      new Date(epoch + 1000),
    );
    vi.setSystemTime(epoch + 10_000);
    const next = await runtime.submit(runRoot, success(started));
    expect(next.attemptId).not.toBe(started.attemptId);
    const refused = await runtime.submit(runRoot, success(next));
    expect(refused).toMatchObject({
      disposition: "blocked",
      attemptId: next.attemptId,
      revision: next.revision,
      findings: expect.arrayContaining([
        expect.objectContaining({ code: "artifact-stale-attempt" }),
      ]),
    });
  });

  it.each(["root", "ancestor"])(
    "refuses a symlink or junction at an external %s",
    async (kind) => {
      const outside = path.join(root, "outside");
      await fs.mkdir(outside);
      await fs.writeFile(path.join(outside, "result.bin"), "outside\n");
      let artifact: Partial<ArtifactSchema> = {};
      if (kind === "root") {
        await fs.rmdir(externalRoot);
        await fs.symlink(
          outside,
          externalRoot,
          process.platform === "win32" ? "junction" : "dir",
        );
      } else {
        await fs.symlink(
          outside,
          path.join(externalRoot, "escape"),
          process.platform === "win32" ? "junction" : "dir",
        );
        artifact = { paths: ["escape/result.bin"] };
      }
      const runtime = createWorkflowRuntime();
      const started = await runtime.start({
        protocol: receiptWorkflow(externalRoot, artifact),
        runRoot,
        runId: "unsafe-root-receipt",
      });
      const refused = await runtime.submit(runRoot, success(started));
      expect(refused).toMatchObject({
        disposition: "blocked",
        revision: started.revision,
        pendingAction: started.pendingAction,
      });
    },
  );

  it.each([undefined, "receipt" as const])(
    "preserves the default Run-root cap and allows an explicit receipt opt-in: %s",
    async (verification) => {
      const runtime = createWorkflowRuntime();
      const started = await runtime.start({
        protocol: receiptWorkflow(undefined, { verification }),
        runRoot,
        runId: "run-root-receipt",
      });
      await fs.writeFile(
        path.join(runRoot, "result.bin"),
        Buffer.alloc(3 * 1024 * 1024, "a"),
      );
      const result = await runtime.submit(runRoot, success(started));
      expect(result.disposition).toBe(
        verification === "receipt" ? "done" : "blocked",
      );
      if (!verification)
        expect(result.findings).toContainEqual(
          expect.objectContaining({ code: "artifact-oversized" }),
        );
    },
  );
});
