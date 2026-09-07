import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalizeWorkflow } from "../src/workflow/contract.js";
import { generatePackage } from "../src/factory/generate.js";
import { readRunState } from "../src/engine/state.js";
import { readTrajectory } from "../src/engine/run-store.js";
import { createWorkflowRuntime } from "../src/workflow-runtime/public.js";
import {
  projectWorkflowHandoff,
  projectWorkflowState,
} from "../src/workflow-runtime/index.js";
import type { WorkflowInput, WorkflowProtocol } from "../src/types.js";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

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

function cycleProtocol(maxInstances = 2): WorkflowProtocol {
  const input: WorkflowInput = {
    kind: "workflow-kernel",
    name: "bounded-cycle-workflow",
    goal: "Run a bounded synthetic cycle.",
    customNodes: [
      node("prepare"),
      node("cycle-start"),
      node("cycle-end"),
      node("finish"),
    ],
    routing: {
      fields: [{ id: "next", values: ["repeat", "finish"] }],
      transitions: [
        { from: "prepare", to: "cycle-start", condition: "success" },
        { from: "cycle-start", to: "cycle-end", condition: "success" },
        {
          from: "cycle-end",
          to: "cycle-start",
          condition: "success",
          when: { field: "next", equals: "repeat" },
        },
        {
          from: "cycle-end",
          to: "finish",
          condition: "success",
          when: { field: "next", equals: "finish" },
        },
        { from: "finish", to: null, condition: "success" },
      ],
    },
    cycles: [
      {
        key: "sample-cycle",
        entry: "cycle-start",
        repeatTransitions: [{ from: "cycle-end", to: "cycle-start" }],
        maxInstances,
      },
    ],
  };
  return normalizeWorkflow(input).protocol;
}

function entryCycleProtocol(): WorkflowProtocol {
  const input: WorkflowInput = {
    kind: "workflow-kernel",
    name: "entry-cycle-workflow",
    goal: "Start in a bounded synthetic cycle.",
    customNodes: [node("cycle-start"), node("cycle-end"), node("finish")],
    routing: {
      fields: [{ id: "next", values: ["repeat", "finish"] }],
      transitions: [
        { from: "cycle-start", to: "cycle-end", condition: "success" },
        {
          from: "cycle-end",
          to: "cycle-start",
          condition: "success",
          when: { field: "next", equals: "repeat" },
        },
        {
          from: "cycle-end",
          to: "finish",
          condition: "success",
          when: { field: "next", equals: "finish" },
        },
        { from: "finish", to: null, condition: "success" },
      ],
    },
    cycles: [
      {
        key: "entry-cycle",
        entry: "cycle-start",
        repeatTransitions: [{ from: "cycle-end", to: "cycle-start" }],
        maxInstances: 2,
      },
    ],
  };
  return normalizeWorkflow(input).protocol;
}

describe("WorkflowRuntime bounded declared Cycles", () => {
  let root: string;
  let runRoot: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "badger-workflow-cycle-"));
    runRoot = path.join(root, "change");
    await fs.mkdir(runRoot, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("allocates the first Cycle before a cycle entry action", async () => {
    const started = await createWorkflowRuntime().start({
      protocol: entryCycleProtocol(),
      runRoot,
      runId: "entry-cycle-run",
    });

    expect(started).toMatchObject({
      disposition: "continue",
      currentNode: "cycle-start",
      cycleId: expect.stringMatching(/^cycle-/u),
      attemptId: expect.any(String),
      cycles: [
        expect.objectContaining({
          key: "entry-cycle",
          instanceOrdinal: 1,
        }),
      ],
      pendingAction: {
        cycleId: expect.stringMatching(/^cycle-/u),
      },
    });
    expect(started.cycleId).toBe(started.pendingAction!.cycleId);
    expect(started.cycleId).toBe(started.cycles[0].id);
  });

  it("allocates stable Cycle and Attempt identities across two instances", async () => {
    const runtime = createWorkflowRuntime();
    const started = await runtime.start({
      protocol: cycleProtocol(),
      runRoot,
      runId: "cycle-run",
    });

    const prepared = await runtime.submit(runRoot, {
      actionId: started.pendingAction!.id,
      nodeId: "prepare",
      status: "succeeded",
      summary: "Prepared the cycle.",
    });
    expect(prepared).toMatchObject({
      currentNode: "cycle-start",
      cycleId: expect.stringMatching(/^cycle-/u),
      visitOrdinal: 2,
      retryOrdinal: 0,
      pendingAction: {
        cycleId: expect.stringMatching(/^cycle-/u),
        retryOrdinal: 0,
      },
    });

    const retried = await runtime.submit(runRoot, {
      actionId: prepared.pendingAction!.id,
      nodeId: "cycle-start",
      status: "failed",
      summary: "Transient cycle failure.",
    });
    expect(retried).toMatchObject({
      currentNode: "cycle-start",
      cycleId: prepared.cycleId,
      attemptId: prepared.attemptId,
      visitOrdinal: prepared.visitOrdinal,
      retryOrdinal: 1,
      pendingAction: {
        cycleId: prepared.cycleId,
        attemptId: prepared.attemptId,
        retryOrdinal: 1,
      },
    });
    expect(retried.pendingAction!.id).not.toBe(prepared.pendingAction!.id);

    const ended = await runtime.submit(runRoot, {
      actionId: retried.pendingAction!.id,
      nodeId: "cycle-start",
      status: "succeeded",
      summary: "Completed the cycle start.",
    });
    expect(ended).toMatchObject({
      currentNode: "cycle-end",
      cycleId: prepared.cycleId,
      visitOrdinal: 3,
      retryOrdinal: 0,
    });

    const secondCycle = await runtime.submit(runRoot, {
      actionId: ended.pendingAction!.id,
      nodeId: "cycle-end",
      status: "succeeded",
      summary: "Repeat the cycle.",
      routing: { next: "repeat" },
    });
    expect(secondCycle).toMatchObject({
      currentNode: "cycle-start",
      cycleId: expect.stringMatching(/^cycle-/u),
      visitOrdinal: 4,
      retryOrdinal: 0,
      pendingAction: {
        cycleId: expect.stringMatching(/^cycle-/u),
      },
    });
    expect(secondCycle.cycleId).not.toBe(prepared.cycleId);
    expect(secondCycle.attemptId).not.toBe(prepared.attemptId);
    expect(secondCycle.pendingAction!.id).not.toBe(prepared.pendingAction!.id);

    const secondEnd = await runtime.submit(runRoot, {
      actionId: secondCycle.pendingAction!.id,
      nodeId: "cycle-start",
      status: "succeeded",
      summary: "Completed the second cycle start.",
    });
    const terminal = await runtime.submit(runRoot, {
      actionId: secondEnd.pendingAction!.id,
      nodeId: "cycle-end",
      status: "succeeded",
      summary: "Exit the cycle.",
      routing: { next: "finish" },
    });
    expect(terminal).toMatchObject({
      currentNode: "finish",
      cycleId: null,
      visitOrdinal: 6,
      retryOrdinal: 0,
      pendingAction: { cycleId: null },
    });

    const completed = await runtime.submit(runRoot, {
      actionId: terminal.pendingAction!.id,
      nodeId: "finish",
      status: "succeeded",
      summary: "Finished the workflow.",
    });
    expect(completed).toMatchObject({
      disposition: "done",
      currentNode: null,
      cycleId: null,
      pendingAction: null,
    });

    const state = await readRunState(runRoot);
    expect(state?.workflowRuntime?.cycles).toHaveLength(2);
    expect(state?.workflowRuntime?.cycles[0]).toMatchObject({
      key: "sample-cycle",
      instanceOrdinal: 1,
    });
    expect(state?.workflowRuntime?.cycles[1]).toMatchObject({
      key: "sample-cycle",
      instanceOrdinal: 2,
    });
    expect(state?.workflowRuntime?.visits).toHaveLength(6);
    expect(
      state?.workflowRuntime?.visits.filter(
        (visit) => visit.stepId === "node-2-cycle-start",
      ),
    ).toHaveLength(2);
    expect(
      state?.workflowRuntime?.visits.filter(
        (visit) => visit.stepId === "node-2-cycle-start",
      )[0].cycleId,
    ).not.toBe(
      state?.workflowRuntime?.visits.filter(
        (visit) => visit.stepId === "node-2-cycle-start",
      )[1].cycleId,
    );
    expect(state?.workflowRuntime?.revision).toBe(7);
    expect(await runtime.recover(runRoot)).toEqual(completed);

    const projection = await projectWorkflowState(runRoot);
    expect(projection?.cycles).toHaveLength(2);
    expect(projection?.visits).toHaveLength(6);
    const handoff = await projectWorkflowHandoff(cycleProtocol(), completed);
    expect(handoff.cycles).toHaveLength(2);
    expect(handoff.visits).toHaveLength(6);
  });

  it("blocks an exhausted repeat before creating outcome or Cycle state", async () => {
    const runtime = createWorkflowRuntime();
    const started = await runtime.start({
      protocol: cycleProtocol(1),
      runRoot,
      runId: "exhausted-cycle-run",
    });
    let current = await runtime.submit(runRoot, {
      actionId: started.pendingAction!.id,
      nodeId: "prepare",
      status: "succeeded",
      summary: "Prepared the cycle.",
    });
    current = await runtime.submit(runRoot, {
      actionId: current.pendingAction!.id,
      nodeId: "cycle-start",
      status: "succeeded",
      summary: "Started the cycle.",
    });
    const stateBefore = await readRunState(runRoot);
    const trajectoryBefore = await readTrajectory(
      runRoot,
      stateBefore!.trajectoryRef,
    );

    const blocked = await runtime.submit(runRoot, {
      actionId: current.pendingAction!.id,
      nodeId: "cycle-end",
      status: "succeeded",
      summary: "Attempted an exhausted repeat.",
      routing: { next: "repeat" },
    });

    expect(blocked).toMatchObject({
      disposition: "blocked",
      currentNode: "cycle-end",
      cycleId: current.cycleId,
      attemptId: current.attemptId,
      pendingAction: current.pendingAction,
      blockers: [expect.stringContaining("Cycle budget exhausted")],
    });
    expect(await readRunState(runRoot)).toEqual(stateBefore);
    expect(await readTrajectory(runRoot, stateBefore!.trajectoryRef)).toEqual(
      trajectoryBefore,
    );
  });

  it("recovers the committed Cycle and Attempt and matches standalone behavior", async () => {
    const runtime = createWorkflowRuntime();
    const runId = "recovery-cycle-run";
    const manualLocation = {
      kind: "manual" as const,
      runRoot: path.join(root, "manual"),
    };
    const standaloneLocation = {
      kind: "standalone" as const,
      projectRoot: path.join(root, "standalone"),
      runId,
    };
    const manual = await runtime.start({
      protocol: cycleProtocol(),
      location: manualLocation,
      runId,
    });
    const standalone = await runtime.start({
      protocol: cycleProtocol(),
      location: standaloneLocation,
    });
    expect(standalone).toEqual(manual);

    const manualPrepared = await runtime.submit(manualLocation, {
      actionId: manual.pendingAction!.id,
      nodeId: "prepare",
      status: "succeeded",
      summary: "Prepared the cycle.",
    });
    const standalonePrepared = await runtime.submit(standaloneLocation, {
      actionId: standalone.pendingAction!.id,
      nodeId: "prepare",
      status: "succeeded",
      summary: "Prepared the cycle.",
    });
    expect(standalonePrepared).toEqual(manualPrepared);
    expect(await runtime.recover(manualLocation)).toEqual(manualPrepared);
    expect(await runtime.recover(standaloneLocation)).toEqual(
      standalonePrepared,
    );
  });

  it("projects Cycle state through generated adapters without routing logic", async () => {
    const projectRoot = path.join(root, "generated-project");
    const protocol = cycleProtocol();
    const generated = await generatePackage({
      proposal: {
        schemaVersion: 1,
        name: protocol.name,
        goal: protocol.goal,
        intent: "new-skill",
        planHash: "plan-hash",
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
        skillSources: [],
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
    const handoffScript = path.join(
      generated.packageRoot,
      "scripts",
      "workflow-handoff.mjs",
    );
    const run = (script: string, args: string[]) =>
      execFileAsync(process.execPath, [script, ...args], {
        cwd: projectRoot,
        env: process.env,
      });
    const generatedRunRoot = path.join(projectRoot, "run");
    const json = async (args: string[]) =>
      JSON.parse((await run(stateScript, [...args, "--json"])).stdout) as {
        currentNode: string | null;
        cycleId: string | null;
        pendingAction: { id: string } | null;
        cycles: unknown[];
        visits: unknown[];
      };

    const initialized = await json([
      "init",
      "--run-root",
      generatedRunRoot,
      "--run-id",
      "generated-cycle-run",
    ]);
    expect(initialized).toMatchObject({
      currentNode: "prepare",
      cycleId: null,
      cycles: [],
    });

    const prepared = await json([
      "record",
      "prepare",
      "Prepared the cycle.",
      "--run-root",
      generatedRunRoot,
    ]);
    expect(prepared).toMatchObject({
      currentNode: "cycle-start",
      cycleId: expect.stringMatching(/^cycle-/u),
      cycles: [expect.objectContaining({ key: "sample-cycle" })],
    });

    const ended = await json([
      "record",
      "cycle-start",
      "Started the cycle.",
      "--run-root",
      generatedRunRoot,
    ]);
    const repeated = await json([
      "record",
      "cycle-end",
      '{"summary":"Repeat the cycle.","routing":{"next":"repeat"}}',
      "--run-root",
      generatedRunRoot,
    ]);
    expect(repeated).toMatchObject({
      currentNode: "cycle-start",
      cycles: [
        expect.objectContaining({ instanceOrdinal: 1 }),
        expect.objectContaining({ instanceOrdinal: 2 }),
      ],
      visits: expect.arrayContaining([
        expect.objectContaining({ stepId: "node-2-cycle-start" }),
      ]),
    });
    expect(repeated.cycleId).not.toBe(prepared.cycleId);
    expect(ended.currentNode).toBe("cycle-end");

    const handoff = JSON.parse(
      (await run(handoffScript, ["--run-root", generatedRunRoot, "--json"]))
        .stdout,
    ) as { cycles: unknown[]; visits: unknown[] };
    expect(handoff.cycles).toHaveLength(2);
    expect(handoff.visits).toHaveLength(4);

    for (const script of [stateScript, handoffScript]) {
      const source = await fs.readFile(script, "utf8");
      expect(source).not.toContain("resolveWorkflowCycleTransition");
      expect(source).not.toContain("allocateCycle");
      expect(source).not.toContain("first-incomplete");
    }
  });

  it.each([
    [
      "unknown entry",
      (protocol: WorkflowProtocol) => {
        protocol.cycles![0].entry = "missing";
      },
      "entry Node is unknown or disabled",
    ],
    [
      "unknown repeat target",
      (protocol: WorkflowProtocol) => {
        protocol.cycles![0].repeatTransitions[0].to = "missing";
      },
      "repeat transition is outside its cycle",
    ],
    [
      "unbounded policy",
      (protocol: WorkflowProtocol) => {
        protocol.routing!.fields = [
          { id: "next", values: ["repeat", "finish", "rework"] },
        ];
        protocol.edges.push({
          from: "cycle-start",
          to: "cycle-start",
          condition: "success",
          when: { field: "next", equals: "rework" },
        });
        protocol.routing!.transitions = structuredClone(protocol.edges);
      },
      "contains an unbounded path",
    ],
    [
      "overlapping ownership",
      (protocol: WorkflowProtocol) => {
        protocol.cycles!.push({
          key: "another-cycle",
          entry: "cycle-start",
          repeatTransitions: [{ from: "cycle-end", to: "cycle-start" }],
          maxInstances: 2,
        });
      },
      "overlapping ambiguous Cycle ownership",
    ],
    [
      "unbounded maximum",
      (protocol: WorkflowProtocol) => {
        (
          protocol.cycles![0] as unknown as { maxInstances: number }
        ).maxInstances = Number.POSITIVE_INFINITY;
      },
      "maxInstances must be a finite positive integer",
    ],
    [
      "undeclared graph cycle",
      (protocol: WorkflowProtocol) => {
        delete protocol.cycles;
      },
      "undeclared cycle",
    ],
  ])("rejects %s before Run creation", async (_label, mutate, message) => {
    const protocol = cycleProtocol();
    mutate(protocol);
    await expect(
      createWorkflowRuntime().start({
        protocol,
        runRoot,
        runId: "invalid-cycle-run",
      }),
    ).rejects.toThrow(message);
    await expect(
      fs.access(path.join(runRoot, ".badger")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});
