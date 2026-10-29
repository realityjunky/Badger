import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { normalizeWorkflow } from "../src/workflow/contract.js";
import { readRunState } from "../src/engine/state.js";
import { appendTrajectory, readTrajectory } from "../src/engine/run-store.js";
import { createWorkflowRuntime } from "../src/workflow-runtime/public.js";
import { projectWorkflowHandoff } from "../src/workflow-runtime/index.js";
import type { WorkflowInput, WorkflowProtocol } from "../src/types.js";
import { vitestCli } from "./fixtures/vitest-cli.js";

const execFileAsync = promisify(execFile);

function actionNode(id: string): WorkflowInput["customNodes"][number] {
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

function decisionProtocol(): WorkflowProtocol {
  const input: WorkflowInput = {
    kind: "workflow-kernel",
    name: "finding-workflow",
    goal: "Exercise structured findings.",
    customNodes: [
      actionNode("prepare"),
      {
        id: "review",
        label: "Review",
        kind: "decision",
        responsibility: "Choose the next step.",
        implementation: {
          skill: "review-skill",
          operation: "default",
          scope: "main",
        },
        operations: ["require", "augment", "disable"],
        outputSchemas: [],
        guardrails: [],
        decision: {
          id: "review-decision",
          question: "Should the workflow finish?",
          choices: [{ id: "finish", label: "Finish", to: "finish" }],
          inputs: { type: "object", fields: [] },
          rationale: { required: false },
          reviewer: {},
        },
      },
      actionNode("finish"),
    ],
    routing: {
      transitions: [
        { from: "prepare", to: "review", condition: "success" },
        { from: "finish", to: null, condition: "success" },
      ],
    },
  };
  return normalizeWorkflow(input).protocol;
}

function noDefaultBranchProtocol(): WorkflowProtocol {
  const input: WorkflowInput = {
    kind: "workflow-kernel",
    name: "route-finding-workflow",
    goal: "Exercise route findings.",
    customNodes: [actionNode("prepare"), actionNode("fast")],
    routing: {
      fields: [{ id: "mode", values: ["fast"] }],
      transitions: [
        {
          from: "prepare",
          to: "fast",
          condition: "success",
          when: { field: "mode", equals: "fast" },
        },
        { from: "fast", to: null, condition: "success" },
      ],
    },
  };
  return normalizeWorkflow(input).protocol;
}

async function recoverInFreshProcess(
  location:
    | { kind: "manual"; runRoot: string }
    | {
        kind: "standalone";
        projectRoot: string;
        runId: string;
      },
  expected: Record<string, unknown>,
): Promise<void> {
  const childTest = path.join(
    process.cwd(),
    "test",
    `workflow-findings-fresh-process-${randomUUID()}.test.ts`,
  );
  const sourceEntry = path.resolve("src/workflow-runtime/public.ts");
  const configPath = path.resolve("vitest.config.ts");
  try {
    await fs.writeFile(
      childTest,
      `import { expect, it } from "vitest";
import { createWorkflowRuntime } from ${JSON.stringify(sourceEntry)};

it("recovers structured findings in a fresh process", async () => {
  const location = JSON.parse(process.env.WORKFLOW_LOCATION_JSON!);
  const continuation = await createWorkflowRuntime().recover(location);
  expect(continuation).toEqual(JSON.parse(process.env.WORKFLOW_EXPECTED_JSON!));
});
`,
    );
    await execFileAsync(
      process.execPath,
      [vitestCli, "run", "--config", configPath, childTest],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          WORKFLOW_LOCATION_JSON: JSON.stringify(location),
          WORKFLOW_EXPECTED_JSON: JSON.stringify(expected),
        },
      },
    );
  } finally {
    await fs.rm(childTest, { force: true });
  }
}

describe("WorkflowRuntime findings at the public seam", () => {
  let root: string;
  let runRoot: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(
      path.join(os.tmpdir(), "badger-workflow-findings-"),
    );
    runRoot = path.join(root, "manual-run");
    await fs.mkdir(runRoot, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("distinguishes executable work, a persisted decision, and completion", async () => {
    const runtime = createWorkflowRuntime();
    const started = await runtime.start({
      protocol: decisionProtocol(),
      runRoot,
      runId: "finding-run",
    });

    expect(started).toMatchObject({
      disposition: "continue",
      execution: { findingCatalogVersion: 1 },
      requiresUserDecision: false,
      blockers: [],
      findings: [
        {
          code: "action-available",
          severity: "info",
          requiredAction: "execute",
          operation: {
            id: "workflow.resume",
            args: [started.pendingAction!.id],
          },
          requiresUserDecision: false,
        },
      ],
      findingSummary: { total: 1, returned: 1, truncated: false },
    });

    const awaiting = await runtime.submit(runRoot, {
      actionId: started.pendingAction!.id,
      nodeId: "prepare",
      status: "succeeded",
      summary: "Prepared.",
    });
    expect(awaiting).toMatchObject({
      disposition: "await-user",
      requiresUserDecision: true,
      blockers: [],
      findings: [
        {
          code: "decision-required",
          requiredAction: "decide",
          operation: {
            id: "workflow.submit",
            args: [awaiting.pendingAction!.id],
          },
          requiresUserDecision: true,
        },
      ],
    });

    const next = await runtime.submit(runRoot, {
      kind: "decision",
      actionId: awaiting.pendingAction!.id,
      revision: awaiting.revision,
      nodeId: "review",
      cycleId: awaiting.cycleId,
      attemptId: awaiting.attemptId!,
      choiceId: "finish",
      reviewer: { subject: "reviewer", authorities: ["approve"] },
      execution: awaiting.execution,
    });
    const completed = await runtime.submit(runRoot, {
      actionId: next.pendingAction!.id,
      nodeId: "finish",
      status: "succeeded",
      summary: "Finished.",
    });

    expect(completed).toMatchObject({
      disposition: "done",
      requiresUserDecision: false,
      findings: [],
      findingSummary: { total: 0, returned: 0, omitted: 0, truncated: false },
      blockers: [],
    });
    await expect(runtime.recover(runRoot)).resolves.toEqual(completed);
  });

  it("projects automatic repair findings without mutating a blocked route", async () => {
    const runtime = createWorkflowRuntime();
    const started = await runtime.start({
      protocol: noDefaultBranchProtocol(),
      runRoot,
      runId: "route-finding-run",
    });
    const before = await readRunState(runRoot);

    const blocked = await runtime.submit(runRoot, {
      actionId: started.pendingAction!.id,
      nodeId: "prepare",
      status: "succeeded",
      summary: "No route value.",
    });

    expect(blocked).toMatchObject({
      disposition: "blocked",
      requiresUserDecision: false,
      findings: [
        {
          code: "route-no-match",
          severity: "error",
          requiredAction: "repair",
          operation: {
            id: "workflow.submit",
            args: [started.pendingAction!.id],
          },
          requiresUserDecision: false,
        },
      ],
    });
    expect(blocked.blockers).toEqual(
      blocked.findings.map((finding) => finding.message),
    );
    expect(await readRunState(runRoot)).toEqual(before);
  });

  it("forwards the authoritative findings through a handoff", async () => {
    const runtime = createWorkflowRuntime();
    const current = await runtime.start({
      protocol: decisionProtocol(),
      runRoot,
      runId: "handoff-finding-run",
    });
    const handoff = await projectWorkflowHandoff(decisionProtocol(), current);

    expect(handoff).toMatchObject({
      findings: current.findings,
      findingSummary: current.findingSummary,
      requiresUserDecision: false,
      continuation: { findings: current.findings },
    });
  });

  it("keeps findings equivalent across manual and standalone fresh-process recovery", async () => {
    const runtime = createWorkflowRuntime();
    const manual = {
      kind: "manual" as const,
      runRoot: path.join(root, "manual-parity"),
    };
    const standalone = {
      kind: "standalone" as const,
      projectRoot: path.join(root, "standalone-parity"),
      runId: "location-parity-run",
    };
    await fs.mkdir(manual.runRoot, { recursive: true });
    const protocol = decisionProtocol();
    const manualStarted = await runtime.start({
      protocol,
      location: manual,
      runId: standalone.runId,
    });
    const standaloneStarted = await runtime.start({
      protocol: structuredClone(protocol),
      location: standalone,
    });

    expect(standaloneStarted).toEqual(manualStarted);
    await recoverInFreshProcess(manual, manualStarted);
    await recoverInFreshProcess(standalone, standaloneStarted);
  }, 30_000);

  it("binds the finding catalog version to the persisted execution identity", async () => {
    const runtime = createWorkflowRuntime();
    const started = await runtime.start({
      protocol: decisionProtocol(),
      runRoot,
      runId: "catalog-identity-run",
    });
    const state = await readRunState(runRoot);

    expect(started.execution.findingCatalogVersion).toBe(1);
    expect(state?.runtimeIdentity?.findingCatalogVersion).toBe(1);
    expect(await runtime.recover(runRoot)).toEqual(started);
  });

  it("attaches stable findings to rejected identity and recovery errors", async () => {
    const runtime = createWorkflowRuntime();
    await runtime.start({
      protocol: decisionProtocol(),
      runRoot,
      runId: "error-finding-run",
    });
    const statePath = path.join(runRoot, ".badger", "run-state.json");
    const state = JSON.parse(await fs.readFile(statePath, "utf8")) as {
      runtimeIdentity: { protocolHash: string };
    };
    state.runtimeIdentity.protocolHash = "0".repeat(64);
    await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);

    await expect(runtime.recover(runRoot)).rejects.toMatchObject({
      finding: {
        code: "identity-invalid",
        severity: "error",
        requiredAction: "stop",
        requiresUserDecision: false,
      },
    });
  });

  it("retains terminal evaluation warnings through recovery", async () => {
    const runtime = createWorkflowRuntime();
    const protocol = normalizeWorkflow({
      kind: "workflow-kernel",
      name: "warning-workflow",
      goal: "Exercise terminal warnings.",
      customNodes: [actionNode("finish")],
    }).protocol;
    const started = await runtime.start({
      protocol,
      runRoot,
      runId: "warning-run",
    });
    const completed = await runtime.submit(runRoot, {
      actionId: started.pendingAction!.id,
      nodeId: "finish",
      status: "succeeded",
      summary: "Finished.",
    });
    const state = await readRunState(runRoot);
    const trajectory = await readTrajectory(runRoot, state!.trajectoryRef);
    await appendTrajectory(runRoot, state!.trajectoryRef, {
      sequence: trajectory.length + 1,
      timestamp: new Date().toISOString(),
      type: "eval_completed",
      runId: state!.runId,
      data: {
        scope: "completion",
        results: [
          {
            evalId: "terminal-warning",
            passed: false,
            evidence: "synthetic warning",
          },
        ],
      },
    });

    const recovered = await runtime.recover(runRoot);

    expect(completed.findings).toEqual([]);
    expect(recovered).toMatchObject({
      disposition: "done",
      findings: [
        {
          code: "evaluation-warning",
          severity: "warning",
          requiredAction: "none",
          requiresUserDecision: false,
        },
      ],
      blockers: [],
    });
  });
});
