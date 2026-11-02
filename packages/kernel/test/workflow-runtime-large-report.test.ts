import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { normalizeWorkflow } from "../src/index.js";
import {
  createWorkflowRuntime,
  workflowRunSnapshotBoundViolation,
} from "../src/workflow-runtime/public.js";

let root: string;
afterEach(async () => {
  if (root) await fs.rm(root, { recursive: true, force: true });
});
it("exports a bounded snapshot of an Attempt with 257 outcomes while keeping all original events", async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "badger-large-report-"));
  const protocol = normalizeWorkflow({
    kind: "workflow-kernel",
    name: "large-report",
    goal: "Keep large Runs observable.",
    customNodes: [
      {
        id: "produce",
        label: "Produce",
        kind: "action",
        responsibility: "Produce evidence.",
        implementation: {
          skill: "producer",
          operation: "default",
          scope: "main",
        },
        operations: ["require", "augment", "disable"],
        outputSchemas: [],
        guardrails: [],
      },
      {
        id: "review",
        label: "Review",
        kind: "decision",
        responsibility: "Review the produced evidence.",
        implementation: {
          skill: "reviewer",
          operation: "default",
          scope: "main",
        },
        operations: ["require", "augment", "disable"],
        outputSchemas: [],
        guardrails: [],
        decision: {
          id: "accept",
          question: "Accept the evidence?",
          choices: [{ id: "accept", label: "Accept", to: null }],
          inputs: { type: "object", fields: [] },
          rationale: { required: false },
          reviewer: { authorities: ["operator"] },
        },
      },
    ],
    capabilities: {
      version: 3,
      features: ["conditional-routing", "revisioned-attempts"],
      durability: {
        version: 1,
        capabilities: [
          "mutation-locks",
          "revision-fences",
          "transition-journal",
          "repair-policy",
        ],
        bounds: {
          runStateBytes: 8 * 1024 * 1024,
          pendingActionBytes: 256 * 1024,
          trajectoryBytes: 16 * 1024 * 1024,
          artifactsBytes: 1024 * 1024,
          claimBytes: 16 * 1024,
          transitionJournalBytes: 16 * 1024 * 1024,
          runLockBytes: 16 * 1024,
          repairHistoryBytes: 1024 * 1024,
          repairHistoryCount: 300,
        },
        schemaVersions: {
          runState: 1,
          pendingAction: 1,
          trajectory: 1,
          artifacts: 1,
          revisionClaim: 1,
          transitionJournal: 1,
          runLock: 1,
          repairEpisode: 1,
        },
        findingCatalogVersion: 1,
        repairPolicy: {
          maxFailures: 300,
          warningThreshold: 280,
          manualStopThreshold: 290,
          allowedChoices: [
            { id: "retry", label: "Retry", outcome: "retry" },
            { id: "stop", label: "Stop", outcome: "stop" },
          ],
          allowOneTimeOverride: false,
          maxOverrideRationaleBytes: 256,
        },
      },
    },
  }).protocol;
  const runtime = createWorkflowRuntime();
  let current = await runtime.start({
    protocol,
    runRoot: root,
    runId: "large",
  });
  for (let i = 0; i < 257; i++)
    current = await runtime.submit(root, {
      actionId: current.pendingAction!.id,
      runId: current.runId,
      revision: current.revision,
      execution: current.execution,
      nodeId: current.currentNode,
      status: "failed",
      summary: `Attempt ${i}`,
    });
  for (let i = 0; i < 12; i++)
    current = await runtime.submit(root, {
      actionId: current.pendingAction!.id,
      runId: current.runId,
      revision: current.revision,
      execution: current.execution,
      nodeId: current.currentNode,
      status: "failed",
      summary: "x".repeat(50000),
    });
  const raw = await runtime.projectState(root);
  expect(
    Buffer.byteLength(
      JSON.stringify({
        projection: raw,
        continuation: await runtime.inspect(root),
      }),
    ),
  ).toBeGreaterThan(1024 * 1024);
  const report = (await runtime.readReport(root))!;
  expect(
    Buffer.byteLength(
      JSON.stringify({
        projection: report.projection,
        continuation: report.continuation,
      }),
    ),
  ).toBeLessThanOrEqual(1048576);
  for (const model of [report.projection, report.continuation]) {
    expect(model.visits.length).toBeLessThanOrEqual(256);
    for (const visit of model.visits)
      expect(visit.outcomes.length).toBeLessThanOrEqual(256);
  }
  expect(
    workflowRunSnapshotBoundViolation(report.projection, report.continuation),
  ).toBeNull();
  expect(
    report.events.filter((event) => event.type === "action_completed"),
  ).toHaveLength(269);
  expect(report.continuation.snapshotCompacted).toBe(true);
  expect(report.continuation.pendingAction?.id).toBe(current.pendingAction!.id);
  current = await runtime.submit(root, {
    actionId: current.pendingAction!.id,
    runId: current.runId,
    revision: current.revision,
    execution: current.execution,
    nodeId: current.currentNode,
    status: "succeeded",
    summary: "Evidence ready.",
  });
  const gate = (await runtime.readReport(root))!;
  expect(gate.continuation.disposition).toBe("await-user");
  expect(gate.continuation.pendingAction?.decisionId).toBe("accept");
  expect(
    workflowRunSnapshotBoundViolation(gate.projection, gate.continuation),
  ).toBeNull();
}, 300_000);
