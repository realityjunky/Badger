import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readRunState } from "../src/engine/state.js";
import { readTrajectory } from "../src/engine/run-store.js";
import { normalizeWorkflow } from "../src/workflow/contract.js";
import { createWorkflowRuntime } from "../src/workflow-runtime/public.js";
import {
  clearWorkflowTransitionFaultForTests,
  setWorkflowTransitionFaultForTests,
} from "../src/workflow-runtime/transition-journal.js";
import {
  clearWorkflowRunLockFaultForTests,
  setWorkflowRunLockFaultForTests,
} from "../src/workflow-runtime/run-lock.js";
import type { WorkflowInput, WorkflowProtocol } from "../src/types.js";

const execFileAsync = promisify(execFile);
const LOCK_PATH = ".badger/run-lock.json";
const LOCK_EVENTS_PATH = ".badger/run-lock-recovery.jsonl";

const mutationLockProfile = {
  version: 1,
  capabilities: ["mutation-locks", "revision-fences", "transition-journal"],
  bounds: {
    runStateBytes: 256 * 1024,
    pendingActionBytes: 256 * 1024,
    trajectoryBytes: 8 * 1024 * 1024,
    artifactsBytes: 1024 * 1024,
    claimBytes: 16 * 1024,
    transitionJournalBytes: 1024 * 1024,
    runLockBytes: 16 * 1024,
  },
  schemaVersions: {
    runState: 1,
    pendingAction: 1,
    trajectory: 1,
    artifacts: 1,
    revisionClaim: 1,
    transitionJournal: 1,
    runLock: 1,
  },
  findingCatalogVersion: 1,
} as const;

type MutationLockProtocol = WorkflowProtocol & {
  capabilities: NonNullable<WorkflowProtocol["capabilities"]> & {
    durability: typeof mutationLockProfile;
  };
};

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

function protocol(): MutationLockProtocol {
  return normalizeWorkflow({
    kind: "workflow-kernel",
    name: "mutation-lock-workflow",
    goal: "Serialize protected workflow mutations.",
    customNodes: [node("prepare"), node("finish")],
    capabilities: {
      version: 3,
      features: ["conditional-routing", "revisioned-attempts"],
      durability: structuredClone(mutationLockProfile),
    },
  }).protocol as MutationLockProtocol;
}

function decisionProtocol(): MutationLockProtocol {
  return normalizeWorkflow({
    kind: "workflow-kernel",
    name: "mutation-lock-decision-workflow",
    goal: "Serialize protected decision mutations.",
    customNodes: [
      {
        ...node("review"),
        kind: "decision",
        decision: {
          id: "release-decision",
          question: "Proceed?",
          choices: [
            { id: "approve", label: "Approve", to: "finish" },
            { id: "reject", label: "Reject", to: "abort" },
          ],
          inputs: { type: "object", fields: [] },
          rationale: { required: false },
          reviewer: { subjects: ["reviewer"], authorities: ["approve"] },
        },
      },
      node("finish"),
      node("abort"),
    ],
    routing: {
      transitions: [
        { from: "review", to: "finish", condition: "success" },
        { from: "review", to: "abort", condition: "success" },
        { from: "finish", to: null, condition: "success" },
        { from: "abort", to: null, condition: "success" },
      ],
    },
    capabilities: {
      version: 3,
      features: [
        "conditional-routing",
        "revisioned-attempts",
        "decision-nodes",
      ],
      durability: structuredClone(mutationLockProfile),
    },
  }).protocol as MutationLockProtocol;
}

function submission(
  started: Awaited<
    ReturnType<ReturnType<typeof createWorkflowRuntime>["start"]>
  >,
) {
  return {
    actionId: started.pendingAction!.id,
    runId: started.runId,
    nodeId: started.currentNode!,
    revision: started.revision,
    execution: started.execution,
    status: "succeeded" as const,
    summary: "Prepared the workflow input.",
  };
}

function decisionSubmission(
  started: Awaited<
    ReturnType<ReturnType<typeof createWorkflowRuntime>["start"]>
  >,
  choiceId: string,
) {
  return {
    kind: "decision" as const,
    actionId: started.pendingAction!.id,
    runId: started.runId,
    revision: started.revision,
    nodeId: started.currentNode!,
    cycleId: started.cycleId,
    attemptId: started.attemptId!,
    choiceId,
    reviewer: { subject: "reviewer", authorities: ["approve"] },
    execution: started.execution,
  };
}

async function waitFor(relativePath: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      await fs.access(relativePath);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for ${relativePath}`);
}

function rejectedFinding(result: PromiseSettledResult<unknown>) {
  expect(result.status).toBe("rejected");
  const reason = (result as PromiseRejectedResult).reason as {
    finding?: { code: string; requiredAction: string };
  };
  expect(reason.finding).toBeDefined();
  return reason.finding!;
}

function blockedFinding(result: PromiseSettledResult<unknown>) {
  expect(result.status).toBe("fulfilled");
  const value = (
    result as PromiseFulfilledResult<{
      findings: Array<{ code: string; requiredAction: string }>;
    }>
  ).value;
  expect(value.findings).toBeDefined();
  return value.findings.find((finding) => finding.code.startsWith("run-lock-"));
}

function lockRecord(
  overrides: Partial<{
    ownerToken: string;
    pid: number;
    hostname: string;
    createdAt: string;
    operation: string;
  }> = {},
) {
  return {
    schemaVersion: 1,
    kind: "workflow-run-lock",
    ownerToken: randomUUID(),
    pid: 2_147_483_647,
    hostname: os.hostname(),
    createdAt: "2026-08-01T00:00:00.000Z",
    operation: "workflow.submit",
    ...overrides,
  };
}

async function writeLock(runRoot: string, value: unknown): Promise<void> {
  await fs.writeFile(
    path.join(runRoot, LOCK_PATH),
    `${JSON.stringify(value, null, 2)}\n`,
  );
}

function restoreEnvironment(name: string, previous: string | undefined): void {
  if (previous === undefined) delete process.env[name];
  else process.env[name] = previous;
}

describe("WorkflowRuntime mutation locks", () => {
  let root: string;
  let runRoot: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "badger-workflow-lock-"));
    runRoot = path.join(root, "change");
    await fs.mkdir(runRoot, { recursive: true });
  });

  afterEach(async () => {
    clearWorkflowTransitionFaultForTests();
    clearWorkflowRunLockFaultForTests();
    delete process.env.BADGER_WORKFLOW_TEST_LOCK_HOLD_MS;
    await fs.rm(root, { recursive: true, force: true });
  });

  it.each(["runLockBytes", "runLock"])(
    "requires the mutation-lock %s profile binding",
    async (field) => {
      const invalid = structuredClone(mutationLockProfile) as {
        bounds: Record<string, unknown>;
        schemaVersions: Record<string, unknown>;
      };
      if (field === "runLockBytes") delete invalid.bounds.runLockBytes;
      else delete invalid.schemaVersions.runLock;
      const input = {
        kind: "workflow-kernel" as const,
        name: "invalid-lock-profile",
        goal: "Reject incomplete lock profiles.",
        customNodes: [node("prepare")],
        capabilities: {
          version: 3 as const,
          features: ["conditional-routing", "revisioned-attempts"],
          durability: invalid,
        },
      };

      await expect(
        createWorkflowRuntime().start({
          protocol: input as unknown as WorkflowProtocol,
          runRoot,
          runId: `invalid-lock-profile-${field}`,
        }),
      ).rejects.toThrow("mutation-locks requires its bound and schema version");
      await expect(readRunState(runRoot)).resolves.toBeNull();
    },
  );

  it("publishes bounded owner metadata and returns active contention", async () => {
    const runtime = createWorkflowRuntime();
    const started = await runtime.start({
      protocol: protocol(),
      runRoot,
      runId: "active-lock-run",
    });
    const previousHold = process.env.BADGER_WORKFLOW_TEST_LOCK_HOLD_MS;
    process.env.BADGER_WORKFLOW_TEST_LOCK_HOLD_MS = "300";

    try {
      const firstPromise = runtime.submit(runRoot, submission(started));
      const lockPath = path.join(runRoot, LOCK_PATH);
      await waitFor(lockPath);
      const lock = JSON.parse(await fs.readFile(lockPath, "utf8")) as Record<
        string,
        unknown
      >;
      expect(lock).toMatchObject({
        schemaVersion: 1,
        kind: "workflow-run-lock",
        operation: "workflow.submit",
        pid: process.pid,
        hostname: os.hostname(),
      });
      expect(lock.ownerToken).toEqual(expect.any(String));

      const secondPromise = runtime.submit(runRoot, submission(started));
      const [first, second] = await Promise.allSettled([
        firstPromise,
        secondPromise,
      ]);
      expect(first.status).toBe("fulfilled");
      expect(first).toMatchObject({
        value: { disposition: "continue", revision: 1 },
      });
      expect(blockedFinding(second)).toMatchObject({
        code: "run-lock-active",
        requiredAction: "retry",
      });
    } finally {
      restoreEnvironment("BADGER_WORKFLOW_TEST_LOCK_HOLD_MS", previousHold);
    }
  });

  it("serializes conflicting decision responses without duplicate receipts", async () => {
    const runtime = createWorkflowRuntime();
    const started = await runtime.start({
      protocol: decisionProtocol(),
      runRoot,
      runId: "decision-lock-run",
    });
    const previousHold = process.env.BADGER_WORKFLOW_TEST_LOCK_HOLD_MS;
    process.env.BADGER_WORKFLOW_TEST_LOCK_HOLD_MS = "300";

    try {
      const firstPromise = runtime.submit(
        runRoot,
        decisionSubmission(started, "approve"),
      );
      await waitFor(path.join(runRoot, LOCK_PATH));
      const secondPromise = runtime.submit(
        runRoot,
        decisionSubmission(started, "reject"),
      );
      const [first, second] = await Promise.allSettled([
        firstPromise,
        secondPromise,
      ]);

      expect(first.status).toBe("fulfilled");
      expect(first).toMatchObject({
        value: { disposition: "continue", revision: 1 },
      });
      expect(blockedFinding(second)).toMatchObject({
        code: "run-lock-active",
      });
      const state = await readRunState(runRoot);
      const trajectory = await readTrajectory(runRoot, state!.trajectoryRef);
      expect(state?.workflowRuntime?.decisionReceipts).toHaveLength(1);
      expect(
        state?.workflowRuntime?.visits.flatMap((visit) => visit.outcomes),
      ).toHaveLength(1);
      expect(
        trajectory.filter((event) => event.type === "action_completed"),
      ).toHaveLength(1);
    } finally {
      restoreEnvironment("BADGER_WORKFLOW_TEST_LOCK_HOLD_MS", previousHold);
    }
  });

  it.each([
    ["stale local", lockRecord(), "run-lock-stale"],
    [
      "foreign host",
      lockRecord({ hostname: "workflow-lock-foreign-host" }),
      "run-lock-unknown",
    ],
    [
      "malformed",
      { schemaVersion: 1, kind: "workflow-run-lock" },
      "run-lock-unknown",
    ],
  ] as const)(
    "does not steal %s locks during ordinary resume",
    async (_name, lock, code) => {
      const runtime = createWorkflowRuntime();
      const started = await runtime.start({
        protocol: protocol(),
        runRoot,
        runId: "protected-lock-run",
      });
      await writeLock(runRoot, lock);
      const before = await fs.readFile(path.join(runRoot, LOCK_PATH), "utf8");

      const result = await Promise.allSettled([runtime.resume(runRoot)]);

      expect(blockedFinding(result[0])).toMatchObject({ code });
      await expect(
        fs.readFile(path.join(runRoot, LOCK_PATH), "utf8"),
      ).resolves.toBe(before);
      expect(started.pendingAction).not.toBeNull();
    },
  );

  it("blocks oversized and symlinked lock records without following or removing them", async () => {
    const runtime = createWorkflowRuntime();
    await runtime.start({
      protocol: protocol(),
      runRoot,
      runId: "unsafe-lock-run",
    });
    const lockPath = path.join(runRoot, LOCK_PATH);
    await fs.writeFile(lockPath, "x".repeat(16 * 1024 + 1));
    const oversized = await Promise.allSettled([runtime.resume(runRoot)]);
    expect(blockedFinding(oversized[0])).toMatchObject({
      code: "run-lock-unknown",
    });
    await expect(fs.stat(lockPath)).resolves.toMatchObject({
      isFile: expect.any(Function),
    });

    if (process.platform === "win32") return;
    const outside = path.join(root, "outside-lock.json");
    await fs.writeFile(outside, JSON.stringify(lockRecord()));
    await fs.unlink(lockPath);
    await fs.symlink(outside, lockPath);
    const symlinked = await Promise.allSettled([runtime.resume(runRoot)]);
    expect(blockedFinding(symlinked[0])).toMatchObject({
      code: "run-lock-unknown",
    });
    await expect(fs.readFile(outside, "utf8")).resolves.toContain(
      "workflow-run-lock",
    );
  });

  it("takes over only a proven-stale lock and records evidence before journal recovery", async () => {
    const runtime = createWorkflowRuntime();
    const started = await runtime.start({
      protocol: protocol(),
      runRoot,
      runId: "takeover-lock-run",
    });
    setWorkflowTransitionFaultForTests({
      phase: "record-write",
      path: ".badger/artifacts.json",
    });
    await expect(runtime.submit(runRoot, submission(started))).rejects.toThrow(
      "deterministic workflow transition fault",
    );
    clearWorkflowTransitionFaultForTests();
    const stale = lockRecord({ operation: "workflow.submit" });
    await writeLock(runRoot, stale);

    const recovered = await runtime.recover(runRoot);

    expect(recovered).toMatchObject({
      disposition: "continue",
      revision: 1,
      currentNode: "finish",
    });
    await expect(
      fs.access(path.join(runRoot, LOCK_PATH)),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
    const events = (
      await fs.readFile(path.join(runRoot, LOCK_EVENTS_PATH), "utf8")
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      schemaVersion: 1,
      kind: "workflow-run-lock-takeover",
      ownerToken: stale.ownerToken,
      ownerOperation: "workflow.submit",
      operation: "workflow.recover",
      quarantinePath: expect.stringContaining(".badger/run-lock-quarantine/"),
    });
  });

  it("attributes active and stale locks after a hostname change", async () => {
    const runtime = createWorkflowRuntime();
    const started = await runtime.start({
      protocol: protocol(),
      runRoot,
      runId: "renamed-host-run",
    });
    const previousHold = process.env.BADGER_WORKFLOW_TEST_LOCK_HOLD_MS;
    process.env.BADGER_WORKFLOW_TEST_LOCK_HOLD_MS = "100";
    let owner: Record<string, unknown>;
    try {
      const resumed = runtime.resume(runRoot);
      await waitFor(path.join(runRoot, LOCK_PATH));
      owner = JSON.parse(
        await fs.readFile(path.join(runRoot, LOCK_PATH), "utf8"),
      );
      await resumed;
    } finally {
      restoreEnvironment("BADGER_WORKFLOW_TEST_LOCK_HOLD_MS", previousHold);
    }
    await writeLock(runRoot, {
      ...owner!,
      hostname: "hostname-before-rename",
    });
    const active = await runtime.recover(runRoot);
    expect(active).toMatchObject({
      disposition: "blocked",
      findings: [{ code: "run-lock-active", requiredAction: "retry" }],
    });

    await writeLock(runRoot, {
      ...owner!,
      hostname: "hostname-before-rename",
      pid: 2_147_483_647,
    });

    const childScript = `
      import { pathToFileURL } from "node:url";
      const [assetPath, runRoot] = process.argv.slice(1);
      const { createWorkflowRuntime } = await import(pathToFileURL(assetPath).href);
      console.log(JSON.stringify(await createWorkflowRuntime().recover(runRoot)));
    `;
    const recovered = await execFileAsync(process.execPath, [
      "--input-type=module",
      "--eval",
      childScript,
      path.resolve("assets/runtime/workflow-runtime.mjs"),
      runRoot,
    ]);
    expect(JSON.parse(recovered.stdout)).toEqual(started);
    expect(owner!.hostId).toEqual(expect.stringMatching(/^[a-f0-9]{64}$/u));
    const events = (
      await fs.readFile(path.join(runRoot, LOCK_EVENTS_PATH), "utf8")
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(events).toMatchObject([
      {
        hostId: owner!.hostId,
        hostname: "hostname-before-rename",
        ownerToken: owner!.ownerToken,
      },
    ]);
  });

  it.each([
    ["foreign host identity", "0".repeat(64)],
    ["unavailable host identity", null],
    ["malformed host identity", "not-a-host-id"],
  ] as const)(
    "refuses recovery for an %s even when the hostname matches",
    async (_name, hostId) => {
      const runtime = createWorkflowRuntime();
      await runtime.start({
        protocol: protocol(),
        runRoot,
        runId: "unknown-host-run",
      });
      const beforeState = await runtime.projectState(runRoot);
      await writeLock(runRoot, { ...lockRecord(), hostId });
      const beforeLock = await fs.readFile(
        path.join(runRoot, LOCK_PATH),
        "utf8",
      );

      const recovered = await runtime.recover(runRoot);

      expect(recovered).toMatchObject({
        disposition: "blocked",
        findings: [{ code: "run-lock-unknown", requiredAction: "stop" }],
      });
      await expect(
        fs.readFile(path.join(runRoot, LOCK_PATH), "utf8"),
      ).resolves.toBe(beforeLock);
      await expect(runtime.projectState(runRoot)).resolves.toEqual(beforeState);
    },
  );

  it("fails closed when release sees a replacement owner", async () => {
    const runtime = createWorkflowRuntime();
    const started = await runtime.start({
      protocol: protocol(),
      runRoot,
      runId: "release-lock-run",
    });
    const previousHold = process.env.BADGER_WORKFLOW_TEST_LOCK_HOLD_MS;
    process.env.BADGER_WORKFLOW_TEST_LOCK_HOLD_MS = "300";

    try {
      const promise = runtime.submit(runRoot, submission(started));
      const lockPath = path.join(runRoot, LOCK_PATH);
      await waitFor(lockPath);
      await new Promise((resolve) => setTimeout(resolve, 20));
      const displaced = `${lockPath}.displaced`;
      await fs.rename(lockPath, displaced);
      const replacement = lockRecord({
        operation: "workflow.resume",
        pid: process.pid,
      });
      await writeLock(runRoot, replacement);

      const result = await Promise.allSettled([promise]);
      expect(rejectedFinding(result[0])).toMatchObject({
        code: "run-lock-release-conflict",
      });
      await expect(fs.readFile(lockPath, "utf8")).resolves.toContain(
        replacement.ownerToken,
      );
      expect((await readRunState(runRoot))?.workflowRuntime?.revision).toBe(1);
    } finally {
      restoreEnvironment("BADGER_WORKFLOW_TEST_LOCK_HOLD_MS", previousHold);
    }
  });

  it("fails closed when a replacement file reuses the owner token", async () => {
    const runtime = createWorkflowRuntime();
    const started = await runtime.start({
      protocol: protocol(),
      runRoot,
      runId: "replacement-file-lock-run",
    });
    const previousHold = process.env.BADGER_WORKFLOW_TEST_LOCK_HOLD_MS;
    process.env.BADGER_WORKFLOW_TEST_LOCK_HOLD_MS = "300";

    try {
      const promise = runtime.submit(runRoot, submission(started));
      const lockPath = path.join(runRoot, LOCK_PATH);
      await waitFor(lockPath);
      await new Promise((resolve) => setTimeout(resolve, 20));
      const original = JSON.parse(await fs.readFile(lockPath, "utf8")) as {
        ownerToken: string;
      };
      const displaced = `${lockPath}.replaced`;
      await fs.rename(lockPath, displaced);
      await writeLock(runRoot, {
        ...lockRecord({ operation: "workflow.resume", pid: process.pid }),
        ownerToken: original.ownerToken,
      });

      const result = await Promise.allSettled([promise]);
      expect(rejectedFinding(result[0])).toMatchObject({
        code: "run-lock-release-conflict",
      });
      await expect(fs.readFile(lockPath, "utf8")).resolves.toContain(
        original.ownerToken,
      );
    } finally {
      restoreEnvironment("BADGER_WORKFLOW_TEST_LOCK_HOLD_MS", previousHold);
    }
  });

  it("preserves a replacement lock when quarantine loses its ownership race", async () => {
    const runtime = createWorkflowRuntime();
    const started = await runtime.start({
      protocol: protocol(),
      runRoot,
      runId: "quarantine-race-run",
    });
    const lockPath = path.join(runRoot, LOCK_PATH);
    const displaced = `${lockPath}.stale`;
    const stale = lockRecord({ operation: "workflow.submit" });
    const replacement = lockRecord({
      operation: "workflow.resume",
      pid: process.pid,
    });
    await writeLock(runRoot, stale);
    setWorkflowRunLockFaultForTests(async () => {
      await fs.rename(lockPath, displaced);
      await writeLock(runRoot, replacement);
    });

    const result = await Promise.allSettled([runtime.recover(runRoot)]);

    expect(blockedFinding(result[0])).toMatchObject({
      code: "run-lock-active",
    });
    await expect(fs.readFile(lockPath, "utf8")).resolves.toContain(
      replacement.ownerToken,
    );
    await expect(fs.readFile(displaced, "utf8")).resolves.toContain(
      "workflow-run-lock",
    );
  });

  it("keeps lock semantics equivalent for manual and standalone locations", async () => {
    const runtime = createWorkflowRuntime();
    const manualRoot = path.join(root, "manual");
    const standalone = {
      kind: "standalone" as const,
      projectRoot: path.join(root, "standalone-project"),
      runId: "standalone-lock-run",
    };
    await fs.mkdir(manualRoot, { recursive: true });
    const manualStarted = await runtime.start({
      protocol: protocol(),
      runRoot: manualRoot,
      runId: "manual-lock-run",
    });
    const standaloneStarted = await runtime.start({
      protocol: protocol(),
      location: standalone,
    });

    const manualNext = await runtime.submit(
      manualRoot,
      submission(manualStarted),
    );
    const standaloneNext = await runtime.submit(
      standalone,
      submission(standaloneStarted),
    );

    expect(standaloneNext).toMatchObject({
      disposition: manualNext.disposition,
      revision: manualNext.revision,
      currentNode: manualNext.currentNode,
      pendingAction: { type: manualNext.pendingAction!.type },
    });
  });

  it("serializes conflicting submissions across real child processes", async () => {
    const runtime = createWorkflowRuntime();
    const started = await runtime.start({
      protocol: protocol(),
      runRoot,
      runId: "child-process-lock-run",
    });
    const assetPath = path.resolve("assets/runtime/workflow-runtime.mjs");
    const childScript = `
      import { pathToFileURL } from "node:url";
      const [assetPath, runRoot, rawSubmission] = process.argv.slice(1);
      try {
        const runtimeModule = await import(pathToFileURL(assetPath).href);
        const result = await runtimeModule.createWorkflowRuntime().submit(
          runRoot,
          JSON.parse(rawSubmission),
        );
        console.log(JSON.stringify({ status: "fulfilled", result }));
      } catch (error) {
        console.log(JSON.stringify({
          status: "rejected",
          finding: error?.finding,
          message: error instanceof Error ? error.message : String(error),
        }));
      }
    `;
    const launch = (hold: boolean, rawSubmission: string) =>
      execFileAsync(
        process.execPath,
        [
          "--input-type=module",
          "--eval",
          childScript,
          assetPath,
          runRoot,
          rawSubmission,
        ],
        {
          env: {
            ...process.env,
            ...(hold ? { BADGER_WORKFLOW_TEST_LOCK_HOLD_MS: "400" } : {}),
          },
        },
      );

    const firstPromise = launch(true, JSON.stringify(submission(started)));
    await waitFor(path.join(runRoot, LOCK_PATH));
    const secondPromise = launch(
      false,
      JSON.stringify({
        ...submission(started),
        summary: "A competing process submitted a different result.",
      }),
    );
    const [firstOutput, secondOutput] = await Promise.all([
      firstPromise,
      secondPromise,
    ]);
    const first = JSON.parse(firstOutput.stdout.trim()) as {
      status: string;
      result?: {
        disposition: string;
        revision: number;
        findings: Array<{ code: string }>;
      };
      finding?: { code: string };
    };
    const second = JSON.parse(secondOutput.stdout.trim()) as typeof first;
    expect([first.status, second.status]).toEqual(["fulfilled", "fulfilled"]);
    const accepted = [first, second].find(
      (value) => value.result?.disposition === "continue",
    );
    const blocked = [first, second].find(
      (value) => value.result?.disposition === "blocked",
    );
    expect(accepted?.result).toMatchObject({
      disposition: "continue",
      revision: 1,
    });
    expect(blocked?.result?.findings).toEqual([
      expect.objectContaining({ code: "run-lock-active" }),
    ]);

    const state = await readRunState(runRoot);
    const trajectory = await readTrajectory(runRoot, state!.trajectoryRef);
    expect(state?.workflowRuntime?.revision).toBe(1);
    expect(
      trajectory.filter((event) => event.type === "action_completed"),
    ).toHaveLength(1);
    expect(
      trajectory.filter((event) => event.type === "action_proposed"),
    ).toHaveLength(2);
  }, 30_000);
});
