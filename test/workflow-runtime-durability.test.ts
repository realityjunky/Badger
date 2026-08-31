import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalizeWorkflow } from "../src/workflow/contract.js";
import { readRunState } from "../src/engine/state.js";
import { readTrajectory } from "../src/engine/run-store.js";
import { createWorkflowRuntime } from "../src/workflow-runtime/public.js";
import { generatePackage } from "../src/factory/generate.js";
import type { WorkflowInput, WorkflowProtocol } from "../src/types.js";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const durabilityProfile = {
  version: 1,
  capabilities: ["revision-fences"],
  bounds: {
    runStateBytes: 256 * 1024,
    pendingActionBytes: 256 * 1024,
    trajectoryBytes: 8 * 1024 * 1024,
    artifactsBytes: 1024 * 1024,
    claimBytes: 16 * 1024,
  },
  schemaVersions: {
    runState: 1,
    pendingAction: 1,
    trajectory: 1,
    artifacts: 1,
    revisionClaim: 1,
  },
  findingCatalogVersion: 1,
} as const;

type Phase4Protocol = WorkflowProtocol & {
  capabilities: NonNullable<WorkflowProtocol["capabilities"]> & {
    durability: typeof durabilityProfile;
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

function phase4Protocol(): Phase4Protocol {
  return normalizeWorkflow({
    kind: "workflow-kernel",
    name: "phase-four-workflow",
    goal: "Run a protected revision workflow.",
    customNodes: [node("prepare"), node("finish")],
    capabilities: {
      version: 3,
      features: ["conditional-routing", "revisioned-attempts"],
      durability: structuredClone(durabilityProfile),
    },
  }).protocol as Phase4Protocol;
}

function phase4DecisionProtocol(): Phase4Protocol {
  return normalizeWorkflow({
    kind: "workflow-kernel",
    name: "phase-four-decision",
    goal: "Run a protected decision workflow.",
    capabilities: {
      version: 3,
      features: [
        "conditional-routing",
        "revisioned-attempts",
        "decision-nodes",
      ],
      durability: structuredClone(durabilityProfile),
    },
    customNodes: [
      {
        id: "review",
        label: "Review",
        kind: "decision",
        responsibility: "Choose whether the workflow proceeds.",
        implementation: {
          skill: "review-skill",
          operation: "default",
          scope: "main",
        },
        operations: ["require", "augment", "disable"],
        outputSchemas: [],
        guardrails: [],
        decision: {
          id: "release-decision",
          question: "Proceed?",
          choices: [{ id: "approve", label: "Approve", to: "finish" }],
          inputs: { type: "object", fields: [] },
          rationale: { required: false },
          reviewer: { subjects: ["reviewer"], authorities: ["approve"] },
        },
      },
      node("finish"),
    ],
    routing: {
      transitions: [
        { from: "review", to: "finish", condition: "success" },
        { from: "finish", to: null, condition: "success" },
      ],
    },
  }).protocol as Phase4Protocol;
}

describe("WorkflowRuntime Phase 4 revision fences", () => {
  let root: string;
  let runRoot: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(
      path.join(os.tmpdir(), "comet-workflow-durability-"),
    );
    runRoot = path.join(root, "change");
    await fs.mkdir(runRoot, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("captures the versioned durability profile in package and Run identity", async () => {
    const started = await createWorkflowRuntime().start({
      protocol: phase4Protocol(),
      runRoot,
      runId: "profile-run",
    });

    expect(started.execution.durabilityProfile).toEqual(durabilityProfile);
    expect((await readRunState(runRoot))?.runtimeIdentity).toMatchObject({
      durabilityProfile,
    });
  });

  it.each([
    [
      "unknown profile field",
      (profile: Record<string, unknown>) => {
        profile.unexpected = true;
      },
      "unknown field unexpected",
    ],
    [
      "unsupported profile bound",
      (profile: Record<string, unknown>) => {
        (profile.bounds as Record<string, unknown>).claimBytes = 0;
      },
      "bounds.claimBytes must be a positive bounded integer",
    ],
    [
      "unsupported profile schema",
      (profile: Record<string, unknown>) => {
        (profile.schemaVersions as Record<string, unknown>).revisionClaim = 2;
      },
      "Unsupported Workflow durability schema version: revisionClaim",
    ],
  ])("rejects %s before creating a Run", async (_name, mutate, message) => {
    const protocol = phase4Protocol();
    mutate(
      protocol.capabilities!.durability as unknown as Record<string, unknown>,
    );

    await expect(
      createWorkflowRuntime().start({
        protocol,
        runRoot,
        runId: "invalid-profile-run",
      }),
    ).rejects.toThrow(message);
    await expect(readRunState(runRoot)).resolves.toBeNull();
  });

  it("accepts one competing submission and returns one non-mutating conflict", async () => {
    const runtime = createWorkflowRuntime();
    const started = await runtime.start({
      protocol: phase4Protocol(),
      runRoot,
      runId: "concurrent-run",
    });
    const submission = {
      actionId: started.pendingAction!.id,
      runId: started.runId,
      nodeId: started.currentNode!,
      revision: started.revision,
      execution: started.execution,
      status: "succeeded" as const,
      summary: "Prepared the workflow input.",
    };

    const results = await Promise.all([
      runtime.submit(runRoot, submission),
      runtime.submit(runRoot, { ...submission }),
    ]);

    const accepted = results.filter(
      (result) => result.disposition === "continue",
    );
    const conflicts = results.filter((result) =>
      result.findings.some((finding) => finding.code === "revision-conflict"),
    );
    expect(accepted).toHaveLength(1);
    expect(accepted[0]).toMatchObject({
      disposition: "continue",
      revision: 1,
      currentNode: "finish",
    });
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({
      disposition: "blocked",
      revision: 1,
      pendingAction: accepted[0].pendingAction,
      findings: [
        expect.objectContaining({
          code: "revision-conflict",
          currentRevision: 1,
          currentActionId: accepted[0].pendingAction!.id,
        }),
      ],
    });

    const state = await readRunState(runRoot);
    expect(state?.workflowRuntime?.revision).toBe(1);
    expect(
      state?.workflowRuntime?.visits.flatMap((visit) => visit.outcomes),
    ).toHaveLength(1);
    const trajectory = await readTrajectory(runRoot, state!.trajectoryRef);
    expect(
      trajectory.filter((event) => event.type === "action_completed"),
    ).toHaveLength(1);
    expect(
      trajectory.filter((event) => event.type === "action_proposed"),
    ).toHaveLength(2);
  });

  it("returns the authoritative continuation for stale and cross-Run submissions", async () => {
    const runtime = createWorkflowRuntime();
    const protocol = phase4Protocol();
    const first = await runtime.start({
      protocol,
      runRoot,
      runId: "first-run",
    });
    const secondRoot = path.join(root, "second");
    await fs.mkdir(secondRoot, { recursive: true });
    const second = await runtime.start({
      protocol,
      runRoot: secondRoot,
      runId: "second-run",
    });

    const advanced = await runtime.submit(runRoot, {
      actionId: first.pendingAction!.id,
      runId: first.runId,
      nodeId: first.currentNode!,
      revision: first.revision,
      execution: first.execution,
      status: "succeeded",
      summary: "Prepared the first workflow.",
    });
    const beforeSecond = await readRunState(secondRoot);

    const stale = await runtime.submit(runRoot, {
      actionId: first.pendingAction!.id,
      runId: first.runId,
      nodeId: first.currentNode!,
      revision: first.revision,
      execution: first.execution,
      status: "succeeded",
      summary: "Replayed the first workflow.",
    });
    const crossRun = await runtime.submit(secondRoot, {
      actionId: first.pendingAction!.id,
      runId: first.runId,
      nodeId: second.currentNode!,
      revision: second.revision,
      execution: second.execution,
      status: "succeeded",
      summary: "Copied the other Run submission.",
    });

    expect(advanced.revision).toBe(1);
    expect(stale).toMatchObject({
      disposition: "blocked",
      revision: advanced.revision,
      pendingAction: advanced.pendingAction,
      findings: [expect.objectContaining({ code: "revision-conflict" })],
    });
    expect(crossRun).toMatchObject({
      disposition: "blocked",
      revision: second.revision,
      pendingAction: second.pendingAction,
      findings: [expect.objectContaining({ code: "revision-conflict" })],
    });
    expect(await readRunState(secondRoot)).toEqual(beforeSecond);
  });

  it("fences competing decision responses and records one receipt", async () => {
    const runtime = createWorkflowRuntime();
    const started = await runtime.start({
      protocol: phase4DecisionProtocol(),
      runRoot,
      runId: "decision-run",
    });
    const response = {
      kind: "decision" as const,
      actionId: started.pendingAction!.id,
      runId: started.runId,
      revision: started.revision,
      nodeId: started.currentNode!,
      cycleId: started.cycleId,
      attemptId: started.attemptId!,
      choiceId: "approve",
      reviewer: { subject: "reviewer", authorities: ["approve"] },
      execution: started.execution,
    };

    const results = await Promise.all([
      runtime.submit(runRoot, response),
      runtime.submit(runRoot, { ...response }),
    ]);

    expect(
      results.filter((result) => result.disposition === "continue"),
    ).toHaveLength(1);
    expect(
      results.filter((result) =>
        result.findings.some((finding) => finding.code === "revision-conflict"),
      ),
    ).toHaveLength(1);
    const state = await readRunState(runRoot);
    expect(state?.workflowRuntime?.revision).toBe(1);
    expect(state?.workflowRuntime?.decisionReceipts).toHaveLength(1);
  });

  it("enforces the same fence through generated adapters", async () => {
    const projectRoot = path.join(root, "generated-project");
    const protocol = phase4Protocol();
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
    const generatedRunRoot = path.join(projectRoot, "run");
    const run = (args: string[]) =>
      execFileAsync(process.execPath, [stateScript, ...args], {
        cwd: projectRoot,
        env: process.env,
      });

    await run([
      "init",
      "--run-root",
      generatedRunRoot,
      "--run-id",
      "generated-phase4-run",
    ]);
    const submissions = await Promise.all(
      [0, 1].map(() =>
        run([
          "record",
          "prepare",
          '{"summary":"Prepared through the generated adapter."}',
          "--run-root",
          generatedRunRoot,
          "--json",
        ]),
      ),
    );
    const continuations = submissions.map(
      (result) =>
        JSON.parse(result.stdout) as {
          disposition: string;
          revision: number;
          findings: Array<{ code: string }>;
        },
    );
    expect(
      continuations.filter(
        (continuation) => continuation.disposition === "continue",
      ),
    ).toHaveLength(1);
    expect(
      continuations.filter((continuation) =>
        continuation.findings.some(
          (finding) => finding.code === "revision-conflict",
        ),
      ),
    ).toHaveLength(1);
    expect(
      (await readRunState(generatedRunRoot))?.workflowRuntime?.revision,
    ).toBe(1);
  });

  it("binds generated decision adapters to the Phase 4 Run identity", async () => {
    const projectRoot = path.join(root, "generated-decision-project");
    const protocol = phase4DecisionProtocol();
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
    const run = (args: string[]) =>
      execFileAsync(process.execPath, [stateScript, ...args], {
        cwd: projectRoot,
        env: process.env,
      });
    const decision = JSON.stringify({
      choiceId: "approve",
      reviewer: { subject: "reviewer", authorities: ["approve"] },
    });
    const stateRunRoot = path.join(projectRoot, "state-run");
    await run([
      "init",
      "--run-root",
      stateRunRoot,
      "--run-id",
      "generated-decision-run",
    ]);
    const stateDecision = JSON.parse(
      (
        await run([
          "decide",
          "review",
          decision,
          "--run-root",
          stateRunRoot,
          "--json",
        ])
      ).stdout,
    ) as { disposition: string; revision: number };
    expect(stateDecision).toMatchObject({
      disposition: "continue",
      revision: 1,
    });

    const guardRunRoot = path.join(projectRoot, "guard-run");
    await run([
      "init",
      "--run-root",
      guardRunRoot,
      "--run-id",
      "generated-guard-decision-run",
    ]);
    const guardDecision = JSON.parse(
      (
        await execFileAsync(
          process.execPath,
          [
            guardScript,
            "decision",
            "review",
            decision,
            "--run-root",
            guardRunRoot,
            "--apply",
            "--json",
          ],
          {
            cwd: projectRoot,
            env: process.env,
          },
        )
      ).stdout,
    ) as { disposition: string; revision: number };
    expect(guardDecision).toMatchObject({
      disposition: "continue",
      revision: 1,
    });
  });

  it("preserves fence behavior across manual and standalone locations", async () => {
    const runtime = createWorkflowRuntime();
    const manualLocation = {
      kind: "manual" as const,
      runRoot,
    };
    const standaloneLocation = {
      kind: "standalone" as const,
      projectRoot: path.join(root, "standalone-project"),
      runId: "location-phase4-run",
    };
    const protocol = phase4Protocol();
    const manual = await runtime.start({
      protocol,
      location: manualLocation,
      runId: "location-phase4-run",
    });
    const standalone = await runtime.start({
      protocol: structuredClone(protocol),
      location: standaloneLocation,
    });
    expect(standalone).toEqual(manual);

    const submit = (continuation: typeof manual) => ({
      actionId: continuation.pendingAction!.id,
      runId: continuation.runId,
      revision: continuation.revision,
      execution: continuation.execution,
      nodeId: continuation.currentNode!,
      status: "succeeded" as const,
      summary: "Prepared the workflow input.",
    });
    const [manualNext, standaloneNext] = await Promise.all([
      runtime.submit(manualLocation, submit(manual)),
      runtime.submit(standaloneLocation, submit(standalone)),
    ]);
    expect(standaloneNext).toEqual(manualNext);
    expect(standaloneNext.findings).toEqual(manualNext.findings);
  });
});
