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
import {
  clearWorkflowTransitionFaultForTests,
  readWorkflowTransitionJournal,
  setWorkflowTransitionFaultForTests,
} from "../src/workflow-runtime/transition-journal.js";

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

const transitionJournalProfile = {
  ...durabilityProfile,
  capabilities: ["revision-fences", "transition-journal"],
  bounds: {
    ...durabilityProfile.bounds,
    transitionJournalBytes: 1024 * 1024,
  },
  schemaVersions: {
    ...durabilityProfile.schemaVersions,
    transitionJournal: 1,
  },
} as const;

type Phase4Protocol = WorkflowProtocol & {
  capabilities: NonNullable<WorkflowProtocol["capabilities"]> & {
    durability: typeof durabilityProfile;
  };
};

type Phase4JournalProtocol = WorkflowProtocol & {
  capabilities: NonNullable<WorkflowProtocol["capabilities"]> & {
    durability: typeof transitionJournalProfile;
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

function phase4JournalProtocol(): Phase4JournalProtocol {
  const protocol = phase4Protocol();
  protocol.capabilities = {
    ...protocol.capabilities!,
    durability: structuredClone(transitionJournalProfile),
  } as Phase4JournalProtocol["capabilities"];
  return protocol as Phase4JournalProtocol;
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
    clearWorkflowTransitionFaultForTests();
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
    await expect(readWorkflowTransitionJournal(runRoot)).resolves.toBeNull();
  });

  it("captures an explicit transition-journal capability and bound", async () => {
    const started = await createWorkflowRuntime().start({
      protocol: phase4JournalProtocol(),
      runRoot,
      runId: "explicit-journal-profile-run",
    });

    expect(started.execution.durabilityProfile).toEqual(
      transitionJournalProfile,
    );
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

  it("requires explicit recovery and rolls forward a crashed transition", async () => {
    const runtime = createWorkflowRuntime();
    const started = await runtime.start({
      protocol: phase4Protocol(),
      runRoot,
      runId: "journal-run",
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

    setWorkflowTransitionFaultForTests({
      phase: "record-write",
      path: ".comet/artifacts.json",
    });
    await expect(runtime.submit(runRoot, submission)).rejects.toThrow(
      "deterministic workflow transition fault",
    );
    const journal = await readWorkflowTransitionJournal(runRoot);
    expect(journal).toMatchObject({
      operation: "workflow.submit",
      runId: started.runId,
      previous: { revision: 0, actionId: started.pendingAction!.id },
      intended: { revision: 1, actionId: expect.any(String) },
    });
    expect(journal?.records.slice(0, 4).map((record) => record.path)).toEqual([
      ".comet/run-state.json",
      ".comet/pending-action.json",
      ".comet/artifacts.json",
      ".comet/trajectory.jsonl",
    ]);
    expect(journal?.records.at(-1)).toMatchObject({
      kind: "revision-claim",
      path: expect.stringMatching(/^\.comet\/revision-claims\//u),
    });
    clearWorkflowTransitionFaultForTests();

    const blocked = await runtime.resume(runRoot);
    expect(blocked).toMatchObject({
      disposition: "blocked",
      revision: 1,
      findings: [expect.objectContaining({ code: "recovery-required" })],
    });

    const recovered = await runtime.recover(runRoot);
    expect(recovered).toMatchObject({
      disposition: "continue",
      revision: 1,
      currentNode: "finish",
    });
    const state = await readRunState(runRoot);
    const trajectory = await readTrajectory(runRoot, state!.trajectoryRef);
    expect(
      trajectory.filter((event) => event.type === "recovery_reconciled"),
    ).toHaveLength(1);
    expect(
      trajectory.find((event) => event.type === "recovery_reconciled")?.data,
    ).toMatchObject({
      crashBoundary: "record-write:.comet/artifacts.json",
    });
    expect(await runtime.recover(runRoot)).toEqual(recovered);
    const completed = await runtime.submit(runRoot, {
      actionId: recovered.pendingAction!.id,
      runId: recovered.runId,
      nodeId: recovered.currentNode!,
      revision: recovered.revision,
      execution: recovered.execution,
      status: "succeeded",
      summary: "Finished the workflow.",
    });
    expect(completed).toMatchObject({
      disposition: "done",
      revision: 2,
      pendingAction: null,
    });
  });

  it.each([
    ["journal-prepared", undefined],
    ["journal-verified", undefined],
    ["record-write", ".comet/run-state.json"],
    ["record-verification", ".comet/run-state.json"],
    ["commit-evidence", undefined],
    ["commit-evidence-written", undefined],
    ["journal-clearance", undefined],
  ] as const)("recovers a start interrupted at %s", async (phase, path) => {
    const runtime = createWorkflowRuntime();
    setWorkflowTransitionFaultForTests({ phase, ...(path ? { path } : {}) });

    await expect(
      runtime.start({
        protocol: phase4Protocol(),
        runRoot,
        runId: `fault-${phase}`,
      }),
    ).rejects.toThrow("deterministic workflow transition fault");
    clearWorkflowTransitionFaultForTests();

    const blocked = await runtime.resume(runRoot);
    expect(blocked).toMatchObject({
      disposition: "blocked",
      findings: [expect.objectContaining({ code: "recovery-required" })],
    });

    const recovered = await runtime.recover(runRoot);
    expect(recovered.pendingAction).not.toBeNull();
    expect(await runtime.recover(runRoot)).toEqual(recovered);
  });

  it("blocks recovery on an unknown record identity without guessing", async () => {
    const runtime = createWorkflowRuntime();
    const started = await runtime.start({
      protocol: phase4Protocol(),
      runRoot,
      runId: "unknown-record-run",
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

    setWorkflowTransitionFaultForTests({
      phase: "record-write",
      path: ".comet/run-state.json",
    });
    await expect(runtime.submit(runRoot, submission)).rejects.toThrow(
      "deterministic workflow transition fault",
    );
    clearWorkflowTransitionFaultForTests();
    await fs.writeFile(
      path.join(runRoot, ".comet", "artifacts.json"),
      '{"tampered":true}\n',
    );

    const blocked = await runtime.recover(runRoot);
    expect(blocked).toMatchObject({
      disposition: "blocked",
      findings: [expect.objectContaining({ code: "recovery-required" })],
    });
    expect(
      await fs.readFile(path.join(runRoot, ".comet", "artifacts.json"), "utf8"),
    ).toBe('{"tampered":true}\n');
    expect(
      (
        await readTrajectory(
          runRoot,
          (await readRunState(runRoot))!.trajectoryRef,
        )
      ).filter((event) => event.type === "recovery_reconciled"),
    ).toHaveLength(0);
  });

  it("recovers decision receipts and terminal writes exactly once", async () => {
    const runtime = createWorkflowRuntime();
    const started = await runtime.start({
      protocol: phase4DecisionProtocol(),
      runRoot,
      runId: "journal-decision-run",
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

    setWorkflowTransitionFaultForTests({
      phase: "record-verification",
      path: ".comet/run-state.json",
    });
    await expect(runtime.submit(runRoot, response)).rejects.toThrow(
      "deterministic workflow transition fault",
    );
    clearWorkflowTransitionFaultForTests();

    const afterDecision = await runtime.recover(runRoot);
    expect(afterDecision).toMatchObject({
      disposition: "continue",
      revision: 1,
      currentNode: "finish",
      decisionReceipts: [
        expect.objectContaining({ actionId: response.actionId }),
      ],
    });
    expect(
      (await readRunState(runRoot))?.workflowRuntime?.decisionReceipts,
    ).toHaveLength(1);

    const terminalSubmission = {
      actionId: afterDecision.pendingAction!.id,
      runId: afterDecision.runId,
      revision: afterDecision.revision,
      nodeId: afterDecision.currentNode!,
      execution: afterDecision.execution,
      status: "succeeded" as const,
      summary: "Finished the workflow.",
    };
    setWorkflowTransitionFaultForTests({
      phase: "record-write",
      path: ".comet/pending-action.json",
    });
    await expect(runtime.submit(runRoot, terminalSubmission)).rejects.toThrow(
      "deterministic workflow transition fault",
    );
    clearWorkflowTransitionFaultForTests();

    const completed = await runtime.recover(runRoot);
    expect(completed).toMatchObject({
      disposition: "done",
      revision: 2,
      pendingAction: null,
      decisionReceipts: [
        expect.objectContaining({ actionId: response.actionId }),
      ],
    });
    const state = await readRunState(runRoot);
    const trajectory = await readTrajectory(runRoot, state!.trajectoryRef);
    expect(
      trajectory.filter((event) => event.type === "action_completed"),
    ).toHaveLength(2);
    expect(
      trajectory.filter((event) => event.type === "recovery_reconciled"),
    ).toHaveLength(2);
    expect(await runtime.recover(runRoot)).toEqual(completed);
  });

  it.each([
    "recovery-record-write",
    "recovery-record-verification",
    "recovery-evidence-prepared",
    "recovery-evidence",
    "recovery-evidence-recorded",
    "commit-evidence",
    "commit-evidence-written",
    "journal-clearance",
  ] as const)("recovers after a fault during %s", async (phase) => {
    const runtime = createWorkflowRuntime();
    const started = await runtime.start({
      protocol: phase4Protocol(),
      runRoot,
      runId: `recovery-fault-${phase}`,
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
    setWorkflowTransitionFaultForTests({
      phase: "record-write",
      path: ".comet/run-state.json",
    });
    await expect(runtime.submit(runRoot, submission)).rejects.toThrow(
      "deterministic workflow transition fault",
    );
    clearWorkflowTransitionFaultForTests();

    setWorkflowTransitionFaultForTests({ phase });
    await expect(runtime.recover(runRoot)).rejects.toThrow(
      "deterministic workflow transition fault",
    );
    clearWorkflowTransitionFaultForTests();

    const recovered = await runtime.recover(runRoot);
    expect(recovered).toMatchObject({
      disposition: "continue",
      revision: 1,
      currentNode: "finish",
    });
    expect(
      (
        await readTrajectory(
          runRoot,
          (await readRunState(runRoot))!.trajectoryRef,
        )
      ).filter((event) => event.type === "recovery_reconciled"),
    ).toHaveLength(1);
    expect(await runtime.recover(runRoot)).toEqual(recovered);
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

  it("recovers a generated child-process interruption through the public runtime", async () => {
    const projectRoot = path.join(root, "generated-journal-project");
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
    const run = (args: string[], env = process.env) =>
      execFileAsync(process.execPath, [stateScript, ...args], {
        cwd: projectRoot,
        env,
      });
    await run([
      "init",
      "--run-root",
      generatedRunRoot,
      "--run-id",
      "generated-journal-run",
    ]);

    await expect(
      run(
        [
          "record",
          "prepare",
          '{"summary":"Prepared through a child process."}',
          "--run-root",
          generatedRunRoot,
          "--json",
        ],
        {
          ...process.env,
          COMET_WORKFLOW_TEST_FAULT_BOUNDARY:
            "record-write:.comet/run-state.json",
        },
      ),
    ).rejects.toThrow();

    const runtime = createWorkflowRuntime();
    const blocked = await runtime.resume(generatedRunRoot);
    expect(blocked.findings).toEqual([
      expect.objectContaining({ code: "recovery-required" }),
    ]);
    const recovered = await runtime.recover(generatedRunRoot);
    expect(recovered).toMatchObject({
      disposition: "continue",
      revision: 1,
      currentNode: "finish",
    });
  });

  it("covers commit and recovery evidence boundaries in fresh processes", async () => {
    const projectRoot = path.join(root, "generated-boundary-project");
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
    const runtimeScript = path.join(
      generated.packageRoot,
      "scripts",
      "workflow-runtime.mjs",
    );
    const run = (args: string[], env = process.env) =>
      execFileAsync(process.execPath, [stateScript, ...args], {
        cwd: projectRoot,
        env,
      });
    const recover = (runRoot: string, env: NodeJS.ProcessEnv) =>
      execFileAsync(
        process.execPath,
        [
          "--input-type=module",
          "--eval",
          `const runtimeModule = await import(${JSON.stringify(runtimeScript)}); await runtimeModule.createWorkflowRuntime().recover(${JSON.stringify(runRoot)});`,
        ],
        { cwd: projectRoot, env },
      );
    const init = (runRoot: string, runId: string) =>
      run(["init", "--run-root", runRoot, "--run-id", runId]);
    const faultEnv = (boundary: string): NodeJS.ProcessEnv => ({
      ...process.env,
      COMET_WORKFLOW_TEST_FAULT_BOUNDARY: boundary,
    });
    const startBoundaries = [
      "journal-prepared",
      "journal-verified",
      "record-write:.comet/run-state.json",
      "record-verification:.comet/run-state.json",
      "record-write:.comet/pending-action.json",
      "record-verification:.comet/pending-action.json",
      "record-write:.comet/trajectory.jsonl",
      "record-verification:.comet/trajectory.jsonl",
      "commit-evidence",
      "commit-evidence-written",
      "journal-clearance",
    ];

    for (const [index, boundary] of startBoundaries.entries()) {
      const runRoot = path.join(projectRoot, `start-${index}`);
      await expect(
        run(
          [
            "init",
            "--run-root",
            runRoot,
            "--run-id",
            `start-boundary-${index}`,
          ],
          faultEnv(boundary),
        ),
      ).rejects.toThrow();
      const recovered = await createWorkflowRuntime().recover(runRoot);
      expect(recovered.pendingAction).not.toBeNull();
    }

    const recoveryBoundaries = [
      "recovery-record-write",
      "recovery-record-verification",
      "recovery-evidence-prepared",
      "recovery-evidence",
      "recovery-evidence-recorded",
      "commit-evidence",
      "commit-evidence-written",
      "journal-clearance",
    ];
    for (const [index, boundary] of recoveryBoundaries.entries()) {
      const runRoot = path.join(projectRoot, `recovery-${index}`);
      await init(runRoot, `recovery-boundary-${index}`);
      await expect(
        run(
          [
            "record",
            "prepare",
            '{"summary":"Prepared through a child process."}',
            "--run-root",
            runRoot,
            "--json",
          ],
          faultEnv("record-write:.comet/run-state.json"),
        ),
      ).rejects.toThrow();
      await expect(recover(runRoot, faultEnv(boundary))).rejects.toThrow();
      const recovered = await createWorkflowRuntime().recover(runRoot);
      expect(recovered).toMatchObject({
        disposition: "continue",
        revision: 1,
        currentNode: "finish",
      });
    }
  }, 60000);

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
